/**
 * The signing gate.
 *
 * This is the only module in the project that may cause a signature to be
 * produced. Everything else reads and writes; this one decides.
 *
 * ## The order is the security property
 *
 * ```
 * 1. request unpaid                    ── no signature exists yet
 * 2. not 402? → return                 ── nothing to pay, nothing signed
 * 3. decode + validate requirements    ── untrusted input, fully checked
 * 4. allowlist / ceiling               ── refuse before any signature
 * 5. ledger.reserve()                  ── budget held, transactionally
 * 6. createPaymentPayload()            ── FIRST moment a signature can exist
 * 7. retry with the encoded signature
 * 8. verify payment-response           ── settle / release / interrupt
 * ```
 *
 * Steps 4 and 5 come *before* step 6 deliberately. The reservation is not a
 * record of an intent to pay; it is the durable claim that makes concurrent
 * approval safe, and it must exist before the signature does. A purse that
 * signed first and reserved afterwards would have a window in which two
 * concurrent calls both hold valid signatures and both believe the budget was
 * available.
 *
 * ## Release is evidence-gated
 *
 * Budget is only returned to the run when something *established* that no money
 * moved. That is a short list:
 *
 * - the retry returned 402 again, carrying a `payment-response` whose `success`
 *   is explicitly `false` — the facilitator refused, so nothing settled;
 * - the seller returned a non-2xx with a `payment-response` `success: false`;
 * - the payload could not be created or encoded, so no signature ever left.
 *
 * Everything ambiguous — a network timeout after the retry, a malformed
 * `payment-response`, a 200 with no payment header at all, a settlement for a
 * different network, an amount above the reservation — leaves the hold in
 * place and marks the attempt `interrupted`. It waits for a human or an
 * explicit reconciliation. This is the asymmetry the whole design turns on:
 * **it is safe to fail closed and expensive to fail open.** Holding budget that
 * was actually returned annoys someone; releasing budget that was actually spent
 * spends money that was not authorised to be spent twice.
 *
 * Seller-controlled text is never a reason to release. A `payment-response` is
 * read for its protocol fields only; its `errorReason` is recorded as text and
 * never interpreted.
 */

import type { PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import { decodePaymentResponseHeader } from "@x402/core/http";
import type { Ledger, Attempt, LedgerTotals } from "../ledger/ledger.js";
import type { Refusal, SpendingPolicy, Quote } from "../policy/policy.js";
import { checkCumulative } from "../policy/policy.js";
import { formatAtomic, parseAtomic, type Atomic } from "../money/amount.js";
import {
  decodeAndSelect,
  PAYMENT_RESPONSE_HEADER,
  SUPPORTED_X402_VERSION,
  type DecodeFailure,
  type RejectedQuote,
} from "./decode.js";

/** The narrow slice of an HTTP transport this gate uses. */
export interface HttpPort {
  request(url: string, init: { headers: Record<string, string> }): Promise<HttpResponse>;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Headers | Record<string, string | string[] | undefined>;
  readonly body: unknown;
}

/** A signer that turns a validated quote into an encoded payment header. */
export interface Signer {
  createPaymentPayload(paymentRequired: PaymentRequired): Promise<PaymentPayload>;
  encodePaymentSignatureHeader(payload: PaymentPayload): Record<string, string>;
}

export type GateOutcome =
  | {
      readonly kind: "free";
      readonly status: number;
      readonly body: unknown;
      readonly attemptId: string;
    }
  | {
      readonly kind: "refused";
      readonly status: number;
      readonly body: unknown;
      readonly attemptId: string;
      readonly refusal: Refusal | DecodeFailure;
      readonly considered: readonly RejectedQuote[];
    }
  | {
      readonly kind: "paid";
      readonly status: number;
      readonly body: unknown;
      readonly attemptId: string;
      readonly settledAtomic: Atomic;
      readonly txHash: string | null;
    }
  | {
      /**
       * A signature may exist and settlement is unknown. The hold stays.
       */
      readonly kind: "interrupted";
      readonly status: number;
      readonly body: unknown;
      readonly attemptId: string;
      readonly reason: string;
      readonly heldAtomic: Atomic;
    };

export interface GateDeps {
  readonly policy: SpendingPolicy;
  readonly ledger: Ledger;
  readonly http: HttpPort;
  readonly signer: Signer;
  /** Injected so attempt ids are deterministic in tests. */
  readonly nextAttemptId: (tool: string) => string;
  readonly now?: () => Date;
}

export interface PaidCallInput {
  readonly runId: string;
  readonly tool: string;
  readonly url: string;
  /** Extra headers for the unpaid request. Never policy-related. */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export class SigningGate {
  private readonly policy: SpendingPolicy;
  private readonly ledger: Ledger;
  private readonly http: HttpPort;
  private readonly signer: Signer;
  private readonly nextAttemptId: (tool: string) => string;
  private readonly now: () => Date;

  constructor(deps: GateDeps) {
    this.policy = deps.policy;
    this.ledger = deps.ledger;
    this.http = deps.http;
    this.signer = deps.signer;
    this.nextAttemptId = deps.nextAttemptId;
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * One paid tool call: request, decide, reserve, sign, retry, reconcile.
   *
   * `tool`, `url` and `headers` are the only caller-supplied values, and none
   * of them is consulted for a limit. There is deliberately no `amount`,
   * `network`, `budget` or `limit` parameter: a model that wanted a larger
   * allowance would have to find a parameter that does not exist.
   */
  async call(input: PaidCallInput): Promise<GateOutcome> {
    const attemptId = this.nextAttemptId(input.tool);
    const baseHeaders = { ...(input.headers ?? {}) };

    // --- 1. Ask first, pay later. No signature exists at this point. -------
    let first: HttpResponse;
    try {
      first = await this.http.request(input.url, { headers: baseHeaders });
    } catch (error) {
      // The transport can refuse a destination before a socket exists - that is
      // what `withTransportGuard` does - and a plain connection failure arrives
      // the same way. In both cases no signature exists, nothing is held and no
      // money moved, so the truthful outcome is a recorded refusal. Letting the
      // exception escape instead would take down the whole agent run over one bad
      // URL, and would leave the caller unable to tell whether a signature exists.
      const refusal: Refusal = { code: "transport-refused", message: messageOf(error) };
      this.ledger.recordRefusal({
        id: attemptId,
        runId: input.runId,
        tool: input.tool,
        url: input.url,
        quoteAtomic: "0",
        refusal,
      });
      return { kind: "refused", status: 0, body: null, attemptId, refusal, considered: [] };
    }

    if (first.status !== 402) {
      this.ledger.recordRefusal({
        id: attemptId,
        runId: input.runId,
        tool: input.tool,
        url: input.url,
        quoteAtomic: "0",
        refusal: {
          code: "not-a-payment",
          message: `endpoint answered ${first.status} without requesting payment`,
        },
        untrusted: describe(first.body),
      });
      return { kind: "free", status: first.status, body: first.body, attemptId };
    }

    // --- 2. Decode and validate. Untrusted input, every field checked. ------
    const selected = decodeAndSelect(first.headers, first.body, this.policy, input.url);
    if (!selected.ok) {
      // `selected.code` is the real reason. It is not always a policy code - a
      // single over-ceiling quote surfaces as `per-call-ceiling-exceeded` while a
      // garbled header surfaces as `malformed-requirements` - and the ledger is
      // the only place a reader can find out which rule fired. The quoted amount
      // is recorded too, so "refused" is accompanied by what was asked for.
      const soleAmount = soleConsideredAmount(selected.considered);
      this.ledger.recordRefusal({
        id: attemptId,
        runId: input.runId,
        tool: input.tool,
        url: input.url,
        quoteAtomic: soleAmount ?? "0",
        refusal: { code: "malformed-requirements", message: selected.message },
        reasonCode: selected.code,
        reasonMessage: selected.message,
        untrusted: selected.untrusted ?? describe(first.body),
      });
      return {
        kind: "refused",
        status: 402,
        body: first.body,
        attemptId,
        refusal: selected,
        considered: selected.considered,
      };
    }

    const quote = selected.quote;

    // --- 3. Cumulative check against the persisted, run-scoped budget. -----
    // `totals` throws for a run that was never opened, which is the ledger
    // doing its job. It has to be caught here: an unknown runId must come back
    // as a refusal the agent can read, not as an exception that escapes the
    // tool call and leaves the caller guessing whether a signature exists.
    let totals: LedgerTotals;
    try {
      totals = this.ledger.totals(input.runId);
    } catch (error) {
      const refusal: Refusal = {
        code: "run-budget-exhausted",
        message: `cannot price this call: ${messageOf(error)}`,
      };
      return {
        kind: "refused",
        status: 402,
        body: first.body,
        attemptId,
        refusal,
        considered: selected.considered,
      };
    }

    const cumulativeRefusal = checkCumulative(this.policy, quote, {
      committed: totals.committed,
      reserved: totals.reserved,
    });
    if (cumulativeRefusal !== null) {
      this.ledger.recordRefusal({
        id: attemptId,
        runId: input.runId,
        tool: input.tool,
        url: input.url,
        quoteAtomic: formatAtomic(quote.amount),
        refusal: cumulativeRefusal,
        quote: {
          scheme: quote.scheme,
          network: quote.network,
          asset: quote.asset,
          payTo: quote.payTo,
        },
        untrusted: truncateText(selected.description),
      });
      return {
        kind: "refused",
        status: 402,
        body: first.body,
        attemptId,
        refusal: cumulativeRefusal,
        considered: selected.considered,
      };
    }

    // --- 4. Reserve, transactionally, BEFORE any signature exists. ---------
    let reservation: Attempt;
    try {
      reservation = this.ledger.reserve({
        id: attemptId,
        runId: input.runId,
        tool: input.tool,
        url: input.url,
        scheme: quote.scheme,
        network: quote.network,
        asset: quote.asset,
        payTo: quote.payTo,
        quote: quote.amount,
        expectedRunBudget: totals.runBudget,
        // The seller's own wording, kept on the row that an investigator will
        // read first: the settled one.
        untrusted: truncateText(`${selected.description}\n\n${selected.rawHeader}`),
      });
    } catch (error) {
      // The ledger refused. Most likely a concurrent call took the budget
      // between step 3 and here. Nothing was signed, so nothing is held.
      const refusal: Refusal = {
        code: "reservation-refused",
        message: `ledger refused the reservation: ${messageOf(error)}`,
      };
      this.ledger.recordRefusal({
        id: attemptId,
        runId: input.runId,
        tool: input.tool,
        url: input.url,
        quoteAtomic: formatAtomic(quote.amount),
        refusal,
        quote: { scheme: quote.scheme, network: quote.network, asset: quote.asset, payTo: quote.payTo },
      });
      return {
        kind: "refused",
        status: 402,
        body: first.body,
        attemptId,
        refusal,
        considered: selected.considered,
      };
    }

    // --- 5. Sign. This is the first moment a signature can exist. ----------
    let payload: PaymentPayload;
    let signatureHeaders: Record<string, string>;
    try {
      const paymentRequired = buildPaymentRequired(quote, selected.description);
      payload = await this.signer.createPaymentPayload(paymentRequired);
      signatureHeaders = this.signer.encodePaymentSignatureHeader(payload);
    } catch (error) {
      // No signature was produced or transmitted, so no settlement is possible.
      // This is the one failure where releasing is provably safe.
      this.releaseWithEvidence(attemptId, `signing failed before any signature was sent: ${messageOf(error)}`);
      return {
        kind: "refused",
        status: 402,
        body: first.body,
        attemptId,
        refusal: { code: "signing-failed", message: messageOf(error) },
        considered: selected.considered,
      };
    }

    // --- 6. Retry, paid. ----------------------------------------------------
    let retry: HttpResponse;
    try {
      retry = await this.http.request(input.url, {
        headers: { ...baseHeaders, ...signatureHeaders },
      });
    } catch (error) {
      // The request may or may not have reached the seller. Ambiguous by
      // construction, so the hold stays and the attempt is interrupted.
      const reason = `retry outcome unknown: ${messageOf(error)}`;
      this.ledger.markInterrupted(attemptId, reason);
      return {
        kind: "interrupted",
        status: 0,
        body: null,
        attemptId,
        reason,
        heldAtomic: reservation.reservedAtomic === null ? 0n : parseAtomic(reservation.reservedAtomic, "held"),
      };
    }

    // --- 7. Reconcile against the payment response. ------------------------
    return this.reconcileFromResponse(attemptId, retry, quote, reservation);
  }

  /**
   * Decide settled / released / interrupted from the paid response.
   *
   * Split out so the branches are individually testable: each one is a
   * different claim about what is known, and the difference between them is
   * whether budget returns to the run.
   */
  private reconcileFromResponse(
    attemptId: string,
    retry: HttpResponse,
    quote: Quote,
    reservation: Attempt,
  ): GateOutcome {
    const held = parseAtomic(reservation.reservedAtomic, "held");
    const rawResponse = headerOf(retry.headers, PAYMENT_RESPONSE_HEADER);

    if (rawResponse === null || rawResponse === "") {
      // A paid retry with no payment header. The seller may have settled and
      // failed to report it, or may have ignored the payment. We cannot tell,
      // so the money stays held.
      const reason =
        retry.status === 402
          ? "seller returned 402 again with no payment-response; settlement unknown"
          : `paid response (${retry.status}) carried no ${PAYMENT_RESPONSE_HEADER}; settlement unknown`;
      this.ledger.markInterrupted(attemptId, reason);
      return {
        kind: "interrupted",
        status: retry.status,
        body: retry.body,
        attemptId,
        reason,
        heldAtomic: held,
      };
    }

    let settle: SettleResponse;
    try {
      settle = decodePaymentResponseHeader(rawResponse);
    } catch (error) {
      // Unparseable settlement evidence is not evidence of anything.
      const reason = `could not decode ${PAYMENT_RESPONSE_HEADER}: ${messageOf(error)}`;
      this.ledger.markInterrupted(attemptId, reason);
      return { kind: "interrupted", status: retry.status, body: retry.body, attemptId, reason, heldAtomic: held };
    }

    if (settle.success !== true) {
      // The facilitator explicitly refused. Nothing settled, so the hold can
      // safely return. `errorReason` is seller text: recorded, never obeyed.
      const reason = `facilitator reported failure: ${truncateText(String(settle.errorReason ?? "no reason given"))}`;
      this.releaseWithEvidence(attemptId, reason);
      return {
        kind: "refused",
        status: retry.status,
        body: retry.body,
        attemptId,
        refusal: { code: "settlement-failed", message: reason },
        considered: [],
      };
    }

    // Success. Now the evidence is checked rather than believed.
    const networkProblem = checkSettleNetwork(settle.network, quote.network);
    if (networkProblem !== null) {
      this.ledger.markInterrupted(attemptId, networkProblem);
      return { kind: "interrupted", status: retry.status, body: retry.body, attemptId, reason: networkProblem, heldAtomic: held };
    }

    // `exact` settles the quote, so an absent `amount` means the quote. A
    // present amount is authoritative, but it may not exceed the reservation.
    const settledRaw = settle.amount;
    let settled: Atomic;
    if (settledRaw === undefined || settledRaw === null || settledRaw === "") {
      settled = parseAtomic(reservation.quoteAtomic, "quote");
    } else {
      try {
        settled = parseAtomic(settledRaw, "settle amount");
      } catch (error) {
        const reason = `settle amount ${JSON.stringify(settledRaw)} is not canonical: ${messageOf(error)}`;
        this.ledger.markInterrupted(attemptId, reason);
        return { kind: "interrupted", status: retry.status, body: retry.body, attemptId, reason, heldAtomic: held };
      }
    }

    if (settled > held) {
      const reason =
        `settled ${formatAtomic(settled)} exceeds the ${formatAtomic(held)} reserved; ` +
        `refusing to record an over-settlement and leaving the hold in place`;
      this.ledger.markInterrupted(attemptId, reason);
      return { kind: "interrupted", status: retry.status, body: retry.body, attemptId, reason, heldAtomic: held };
    }

    const txHash = typeof settle.transaction === "string" ? settle.transaction : undefined;

    // `exactOptionalPropertyTypes` is on, so an absent field is omitted rather
    // than set to `null`: a `null` transaction would read as "the facilitator
    // reported a null hash", which is a different claim than "no hash given".
    this.ledger.reconcile(attemptId, {
      success: true,
      settledAtomic: formatAtomic(settled),
      network: quote.network,
      ...(txHash === undefined ? {} : { txHash }),
      ...(typeof settle.payer === "string" ? { payer: settle.payer } : {}),
    });

    return {
      kind: "paid",
      status: retry.status,
      body: retry.body,
      attemptId,
      settledAtomic: settled,
      txHash: txHash ?? null,
    };
  }

  /** Release a hold, but only with a recorded reason. */
  private releaseWithEvidence(attemptId: string, reason: string): void {
    this.ledger.reconcile(attemptId, { success: false, errorReason: truncateText(reason) });
  }
}

/**
 * Rebuild the `Payment-Required` the signer needs, from the *validated* quote.
 *
 * Only one requirement is offered to the signer, and it is the one that passed
 * the allowlist, the ceiling and the budget. This matters: `createPaymentPayload`
 * selects from whatever it is given, so handing it the seller's full `accepts`
 * array would let it pick a different chain than the policy approved.
 */
function buildPaymentRequired(quote: Quote, description: string): PaymentRequired {
  return {
    x402Version: SUPPORTED_X402_VERSION,
    // `ResourceInfo.url` is required and non-empty; `resource` is a v1 field
    // that v2 dropped, so setting it would be dead weight at best.
    resource: {
      url: quote.resource,
      description,
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: quote.scheme,
        network: quote.network as PaymentRequired["accepts"][number]["network"],
        asset: quote.asset,
        amount: formatAtomic(quote.amount),
        payTo: quote.payTo,
        maxTimeoutSeconds: quote.maxTimeoutSeconds,
        extra: {},
      },
    ],
  };
}

/** The settled network must be the one we authorised, or the evidence is not ours. */
function checkSettleNetwork(observed: unknown, authorised: string): string | null {
  if (typeof observed !== "string" || observed === "") {
    return "payment-response named no network; cannot confirm the settlement was on the authorised chain";
  }
  if (observed.trim().toLowerCase() !== authorised) {
    return `payment-response settled on ${observed}, but the authorisation was for ${authorised}`;
  }
  return null;
}

function headerOf(
  headers: Headers | Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }
  return null;
}

/**
 * The amount from a lone declined requirement, as a canonical string.
 *
 * Only when there is exactly one, because that is the case where the amount is
 * unambiguous. Two candidates and picking the larger would be inventing a number
 * the seller never asked for; zero is the honest answer for "several were
 * offered, see the header".
 */
function soleConsideredAmount(considered: readonly RejectedQuote[]): string | null {
  if (considered.length !== 1) return null;
  const amount = considered[0]?.amount;
  if (amount === undefined) return null;
  try {
    return formatAtomic(parseAtomic(amount, "considered amount"));
  } catch {
    return null;
  }
}

function describe(body: unknown): string | null {  if (body === undefined || body === null) return null;
  if (typeof body === "string") return truncateText(body);
  try {
    return truncateText(JSON.stringify(body));
  } catch {
    return "[unserialisable body]";
  }
}

function truncateText(value: string): string {
  return value.length <= 500 ? value : `${value.slice(0, 500)}[truncated]`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
