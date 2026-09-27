/**
 * Decoding the x402 v2 `Payment-Required` header.
 *
 * ## Why this is hand-written rather than `decodePaymentRequiredHeader`
 *
 * The SDK decoder is a `JSON.parse` with no validation. That is the right
 * behaviour for a library whose caller is trusted, and the wrong behaviour for
 * the boundary of a wallet: everything in this header was chosen by the server
 * that wants to be paid.
 *
 * Concretely, a `JSON.parse`-then-trust decoder lets a seller send
 * `amount: "1e9"`, or `amount: 1` as a number, or omit `amount` and hope the
 * caller reads `undefined` as zero, or send an `accepts` array with one entry
 * per chain so the caller picks the first. Each of those is a way to be paid
 * something other than the advertised price, or to be paid on a chain the
 * allowlist was never asked about.
 *
 * So: parse, then validate every field, and treat any violation as a refusal
 * with a named reason. Nothing here throws into the caller's control flow — a
 * decode failure is a decision, recorded like any other.
 *
 * ## What is trusted
 *
 * Nothing in the header. It is untrusted input that happens to be
 * well-structured. The *policy* — the allowlist, the ceilings, the budget — is
 * trusted code that this module only ever reads from, never writes to.
 */

import { decodePaymentRequiredHeader } from "@x402/core/http";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { formatAtomic, parseAtomic, type Atomic } from "../money/amount.js";
import { normaliseAsset, normaliseNetwork } from "../policy/allowlist.js";
import type { Quote, RefusalCode, SpendingPolicy } from "../policy/policy.js";
import { checkAllowlist, checkPerCall, REFUSAL_CODES } from "../policy/policy.js";

/** The only protocol version this purse speaks. */
export const SUPPORTED_X402_VERSION = 2;

/**
 * Header names, as the real x402 clients use them.
 *
 * HTTP header names are case-insensitive and Node lowercases them on arrival, so
 * matching is case-insensitive throughout. The spelling still matters for
 * interop: the request header is `X-PAYMENT`, not something like
 * `payment-signature`. A purse that invented its own name would work perfectly
 * against its own stub and fail against `@x402/fetch` or `x402HTTPClient`.
 */
export const PAYMENT_REQUIRED_HEADER = "payment-required";
export const PAYMENT_SIGNATURE_HEADER = "x-payment";
export const PAYMENT_RESPONSE_HEADER = "payment-response";

export type DecodeFailureCode =
  | "missing-402"
  | "unsupported-version"
  | "malformed-requirements"
  | "no-acceptable-quote"
  | RefusalCode;

export interface DecodeFailure {
  readonly ok: false;
  readonly code: DecodeFailureCode;
  readonly message: string;
  /** What the seller said, for the audit. Never parsed for instructions. */
  readonly untrusted: string | null;
  /**
   * Every requirement that was understood and then declined, with its reason.
   *
   * Carried on the failure as well as the success because "nothing was
   * acceptable" is useless without knowing what was offered. An operator
   * debugging a seller that stopped taking payments needs the per-option
   * reason, not a count.
   */
  readonly considered: readonly RejectedQuote[];
}

export interface DecodeSuccess {
  readonly ok: true;
  /** The single allowlisted requirement chosen to pay. */
  readonly quote: Quote;
  /** How many entries the seller offered, and why the others were skipped. */
  readonly considered: readonly RejectedQuote[];
  readonly resource: string;
  readonly description: string;
  /** The header exactly as it arrived, for the audit trail. */
  readonly rawHeader: string;
}

export type DecodeResult = DecodeSuccess | DecodeFailure;

/** An offered requirement that was not selected, with the reason. */
export interface RejectedQuote {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: string;
  readonly reason: string;
}

/** Read a header case-insensitively, as HTTP requires. */
export function headerValue(
  headers: Headers | Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  const wanted = name.toLowerCase();
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted) continue;
    if (Array.isArray(value)) return value[0] ?? null;
    return value ?? null;
  }
  return null;
}

/**
 * Decode and validate the `Payment-Required` header, then select the one
 * requirement this policy permits.
 *
 * Selection is *filter, then pick*, not *pick the first*. A seller that offers
 * `[{chain: mainnet}, {chain: base-sepolia}]` must not get the first entry
 * selected by a naive loop; offering extra chains is not a way to get paid on
 * them.
 */
export function decodeAndSelect(
  headers: Headers | Record<string, string | string[] | undefined>,
  body: unknown,
  policy: SpendingPolicy,
  fallbackUrl: string,
): DecodeResult {
  const rawHeader = headerValue(headers, PAYMENT_REQUIRED_HEADER);
  if (rawHeader === null || rawHeader === "") {
    return {
      ok: false,
      code: "missing-402",
      message: `response carried no ${PAYMENT_REQUIRED_HEADER} header`,
      untrusted: describeBody(body),
      considered: [],
    };
  }

  let decoded: PaymentRequired;
  try {
    decoded = decodePaymentRequiredHeader(rawHeader);
  } catch (error) {
    return {
      ok: false,
      code: "malformed-requirements",
      message: `could not decode ${PAYMENT_REQUIRED_HEADER}: ${messageOf(error)}`,
      untrusted: truncate(rawHeader),
      considered: [],
    };
  }

  if (decoded.x402Version !== SUPPORTED_X402_VERSION) {
    return {
      ok: false,
      code: "unsupported-version",
      message: `seller offered x402 version ${String(decoded.x402Version)}; this purse speaks ${SUPPORTED_X402_VERSION}`,
      untrusted: truncate(rawHeader),
      considered: [],
    };
  }

  if (!Array.isArray(decoded.accepts) || decoded.accepts.length === 0) {
    return {
      ok: false,
      code: "malformed-requirements",
      message: "Payment-Required listed no payment requirements",
      untrusted: truncate(rawHeader),
      considered: [],
    };
  }

  const considered: RejectedQuote[] = [];
  for (const entry of decoded.accepts) {
    const normalised = normaliseRequirement(entry);
    if (normalised === null) {
      considered.push({
        scheme: String(entry?.scheme ?? ""),
        network: String(entry?.network ?? ""),
        asset: String(entry?.asset ?? ""),
        amount: String(entry?.amount ?? ""),
        reason: "malformed field",
      });
      continue;
    }

    const quote: Quote = {
      scheme: normalised.scheme,
      network: normalised.network,
      asset: normalised.asset,
      amount: normalised.amount,
      payTo: normalised.payTo,
      maxTimeoutSeconds: normalised.maxTimeoutSeconds,
      resource: fallbackUrl,
      description: typeof decoded.resource?.description === "string" ? decoded.resource.description : "",
    };

    // Order matters: allowlist first, then the ceiling. Both are pre-sign
    // refusals, and reporting the allowlist failure is more useful than
    // reporting "too expensive" for a chain we were never going to pay on.
    const allowlistRefusal = checkAllowlist(policy, quote);
    if (allowlistRefusal !== null) {
      considered.push({ ...normalised, amount: normalised.amountString, reason: allowlistRefusal.code });
      continue;
    }

    const ceilingRefusal = checkPerCall(policy, quote);
    if (ceilingRefusal !== null) {
      considered.push({ ...normalised, amount: normalised.amountString, reason: ceilingRefusal.code });
      continue;
    }

    // First acceptable entry wins, in the order the seller listed them. The
    // seller controls that order, but only among entries we would have accepted
    // anyway, so it cannot widen what is payable.
    return {
      ok: true,
      quote,
      considered,
      resource: fallbackUrl,
      description: quote.description,
      rawHeader,
    };
  }

  const summary = considered
    .map((entry) => `${entry.scheme} on ${entry.network} (${entry.reason})`)
    .join("; ");

  // If nothing we were offered could even be parsed, say that. "No acceptable
  // quote" implies we understood the options and disliked them, which is a
  // different and much less actionable diagnosis.
  const allMalformed = considered.length > 0 && considered.every((entry) => entry.reason === "malformed field");
  if (allMalformed) {
    return {
      ok: false,
      code: "malformed-requirements",
      message: `none of the ${decoded.accepts.length} offered requirement(s) could be parsed: ${summary}`,
      untrusted: truncate(rawHeader),
      considered,
    };
  }

  // A single-option seller gets its specific reason back, not "none of the
  // options", because "no-acceptable-quote" over one entry is a true but
  // useless diagnosis. It costs the operator a debugging session to discover
  // the ceiling was the problem.
  const sole = considered.length === 1 ? considered[0] : undefined;
  if (sole !== undefined && REFUSAL_CODES.includes(sole.reason as RefusalCode)) {
    return {
      ok: false,
      code: sole.reason as RefusalCode,
      message: `the only requirement offered was declined: ${sole.reason} (${formatAtomic(parseAtomic(sole.amount, "reported amount"))} base units for ${sole.scheme} on ${sole.network})`,
      untrusted: truncate(rawHeader),
      considered,
    };
  }

  return {
    ok: false,
    code: "no-acceptable-quote",
    message: `none of the ${decoded.accepts.length} offered requirement(s) passed policy: ${summary}`,
    untrusted: truncate(rawHeader),
    considered,
  };
}

interface NormalisedRequirement {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly amount: Atomic;
  readonly amountString: string;
}

/**
 * Validate one `PaymentRequirements` entry field by field.
 *
 * `amount` is the load-bearing field. It must be a string of canonical decimal
 * digits: a JSON number is rejected rather than coerced, because `1e21` and
 * `1.5` and `1` all arrive as numbers and none of them is a base-unit integer
 * this purse should pay.
 */
function normaliseRequirement(entry: PaymentRequirements | undefined): NormalisedRequirement | null {
  if (entry === null || typeof entry !== "object") return null;

  const scheme = typeof entry.scheme === "string" ? entry.scheme.trim().toLowerCase() : "";
  if (scheme === "") return null;

  let network: string;
  let asset: string;
  let payTo: string;
  try {
    network = normaliseNetwork(entry.network);
    asset = normaliseAsset(entry.asset);
    payTo = normaliseAsset(entry.payTo);
  } catch {
    return null;
  }

  if (typeof entry.amount !== "string") return null;
  let amount: Atomic;
  try {
    amount = parseAtomic(entry.amount, "x402 amount");
  } catch {
    return null;
  }
  // A zero or negative requirement is not a payment. `parseAtomic` already
  // rejects negatives, so this is only the zero case.
  if (amount === 0n) return null;

  const maxTimeoutSeconds =
    typeof entry.maxTimeoutSeconds === "number" && Number.isFinite(entry.maxTimeoutSeconds)
      ? entry.maxTimeoutSeconds
      : 0;

  return {
    scheme,
    network,
    asset,
    payTo,
    maxTimeoutSeconds,
    amount,
    amountString: entry.amount,
  };
}

/** A short, bounded description of a response body, for the audit only. */
function describeBody(body: unknown): string | null {
  if (body === undefined || body === null) return null;
  if (typeof body === "string") return truncate(body);
  try {
    return truncate(JSON.stringify(body));
  } catch {
    return "[unserialisable body]";
  }
}

const MAX_AUDIT_CHARS = 2_000;

function truncate(value: string): string {
  return value.length <= MAX_AUDIT_CHARS
    ? value
    : `${value.slice(0, MAX_AUDIT_CHARS)}[truncated ${value.length - MAX_AUDIT_CHARS} chars]`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
