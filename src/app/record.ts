/**
 * `record/decision-log.json`: the run, written down.
 *
 * ## The one rule this file exists to enforce
 *
 * **A stubbed or unsettled call is never labelled `paid`.**
 *
 * The gate's own vocabulary has a `paid` outcome, and it is the right word for
 * what the *protocol* did: the requirements were valid, the payment was
 * authorised, the facilitator reported success. But in this repository the
 * facilitator is a local stub and the signature is a deterministic constant, so
 * an unqualified "paid" would tell a reader that money moved. It did not.
 *
 * So the record carries its own vocabulary, and it is deliberately duller than
 * the gate's:
 *
 * | settlement     | meaning                                                        |
 * |----------------|----------------------------------------------------------------|
 * | `not-reached`  | refused before the gate; no socket, no signature, no ledger row |
 * | `not-paid`     | the gate declined; nothing was signed and nothing was charged   |
 * | `settled-stub` | authorised and settled **by a local stub**; no chain transaction|
 * | `budget-held`  | a signature may exist and settlement is unknown; the hold stays |
 * | `free`         | the endpoint never asked for payment                            |
 *
 * `settlement.chainTouched` is `false` at the top level and every amount is
 * labelled `settled-stub`, so a reader who only skims the totals still cannot
 * come away thinking funds moved. `tests/record.test.ts` asserts both, because the
 * failure mode here is not a crash - it is a plausible-looking document that
 * overstates what was demonstrated.
 *
 * ## Where the numbers come from
 *
 * Quotes, committed amounts and reservation state are read from the ledger rows,
 * not reconstructed from the gate outcomes. The ledger is the durable record; a
 * record that re-derived its own figures from a second source could disagree
 * with the book, and then neither could be trusted.
 *
 * ## Quarantined text
 *
 * Seller prose is carried through as `untrusted`, already wrapped by
 * `Quarantined.render()`, and is never merged into a trusted field. The record is
 * the artefact a human reads when something looks wrong, so it is exactly where
 * an unlabelled injection would do damage.
 */

import { toModelContent, type ToolCallResult } from "../agent/dispatch.js";
import { formatAtomic, formatUsd, sumAtomic, type Atomic } from "../money/amount.js";
import type { RunAgentReport } from "../agent/loop.js";
import type { Attempt, AttemptState, LedgerTotals } from "../ledger/ledger.js";
import { PAID_FETCH_TOOL, PAID_FETCH_TOOL_NAME } from "../agent/tools.js";
import { BURNER_FREE_ITERATIONS } from "../seller/rogue.js";
import { DEMO_MAX_TURNS, DEMO_QUESTION, type PurseRuntime, type RunEvent } from "./runtime.js";

/** How a call ended, in vocabulary that cannot be read as real money. */
export type SettlementStatus = "not-reached" | "not-paid" | "settled-stub" | "budget-held" | "free";

/** What the gate called it, kept verbatim so the two vocabularies can be compared. */
export type GateOutcomeName = "not-reached" | "free" | "refused" | "paid" | "interrupted";

export interface RecordedCall {
  readonly index: number;
  readonly callId: string;
  readonly tool: string;
  readonly label: string | null;
  readonly url: string | null;
  /** The truthful label. Never bare `paid`. */
  readonly settlement: SettlementStatus;
  /** The gate's own word for the same event. */
  readonly gateOutcome: GateOutcomeName;
  readonly refusal: { readonly code: string; readonly message: string } | null;
  /** Seller-quoted price in base units, from the ledger row. `"0"` when none. */
  readonly quotedAtomic: string;
  readonly quotedUsd: string;
  /** What the ledger committed for this attempt. */
  readonly committedAtomic: string;
  readonly committedUsd: string;
  /**
   * What the ledger holds for this attempt *right now*, if anything.
   *
   * Not the same thing as the amount that was authorised. A `settled` or
   * `released` row still carries its historical reservation in
   * `attempts.reserved_atomic`, and reading that column without also reading
   * `state` produces a record that claims a hold on every call it ever paid for
   * while its own `totals.heldAttemptCount` says one.
   */
  readonly heldAtomic: string;
  readonly spentBefore: string;
  readonly spentAfter: string;
  readonly spentAfterUsd: string;
  readonly attemptId: string | null;
  /** Ledger attempt state: refused / reserved / settled / released / interrupted. */
  readonly ledgerState: AttemptState | null;
  readonly httpStatus: number | null;
  /** A stub string from the stub facilitator. Not a chain transaction. */
  readonly reportedTxHash: string | null;
  /** Quarantined seller text, with its untrusted markers intact. */
  readonly untrusted: { readonly source: string; readonly content: string } | null;
  /** Exactly what the model was shown, for the transcript. */
  readonly modelContent: string;
}

export interface RunRecord {
  readonly schema: "khata.decision-log/1";
  readonly generatedAt: string;
  readonly run: {
    readonly runId: string;
    readonly planner: "scripted" | "llm";
    readonly plannerDescription: string;
    readonly question: string;
    readonly turns: number;
    readonly truncated: boolean;
    readonly finalAnswer: string | null;
    readonly maxTurns: number;
    /** Holds a previous process left behind, still held. Never auto-released. */
    readonly orphanedHoldsAtStartup: number;
  };
  readonly policy: {
    readonly perCallCeilingAtomic: string;
    readonly perCallCeilingUsd: string;
    readonly runBudgetAtomic: string;
    readonly runBudgetUsd: string;
    readonly allowedNetworks: readonly string[];
    readonly allowedSchemes: readonly string[];
    readonly allowedPayees: readonly string[];
    readonly allowedSellerHosts: readonly string[];
    readonly sellerPortsPinned: boolean;
    readonly transportGuardEngaged: boolean;
    readonly burnerFreeIterations: number;
    readonly note: string;
  };
  /**
   * The honest headline. Nothing in this repository has moved money, and a reader
   * should not have to infer that.
   */
  readonly settlement: {
    readonly chainTouched: false;
    readonly mode: "local-stub";
    readonly signer: "deterministic stub; no private key is read in this configuration";
    readonly facilitator: "in-process stub facilitator on the seller side";
    readonly realFundsMoved: false;
    readonly note: string;
  };
  readonly totals: {
    readonly committedAtomic: string;
    readonly committedUsd: string;
    readonly heldAtomic: string;
    readonly heldAttemptCount: number;
    readonly availableAtomic: string;
    readonly availableUsd: string;
    readonly signaturesProduced: number;
    readonly callsAttempted: number;
    readonly bySettlement: Readonly<Record<SettlementStatus, number>>;
  };
  readonly tool: {
    readonly name: string;
    readonly parameters: unknown;
    readonly note: string;
  };
  readonly calls: readonly RecordedCall[];
  readonly ledger: readonly LedgerRow[];
  readonly limitations: readonly string[];
}

export interface LedgerRow {
  readonly id: string;
  readonly ts: string;
  readonly url: string;
  readonly decision: "approved" | "refused";
  readonly state: AttemptState;
  readonly quoteAtomic: string;
  readonly reservedAtomic: string;
  /**
   * The current hold, which is not always `reservedAtomic`.
   *
   * Shipped alongside the raw column so a renderer cannot get this wrong: a
   * settled row's `reservedAtomic` is history, and displaying it as "held"
   * invents a hold that does not exist. See `heldNow()`.
   */
  readonly heldAtomic: string;
  readonly settledAtomic: string | null;
  readonly txHash: string | null;
  readonly committedBefore: string;
  readonly availableBefore: string;
  readonly reason: string | null;
  readonly reasonDetail: string | null;
  readonly untrusted: string | null;
}

export interface BuildRecordInput {
  readonly runtime: PurseRuntime;
  readonly report: RunAgentReport;
  readonly events: readonly RunEvent[];
  readonly generatedAt?: Date;
  readonly maxTurns?: number;
}

export function buildRunRecord(input: BuildRecordInput): RunRecord {
  const { runtime, report, events } = input;
  const { config, ledger, allowlist, signer } = runtime;
  const { limits, allowlist: spendAllowlist } = config.policy;
  const totals = ledger.totals(runtime.runId);

  // The durable rows, indexed by attempt id. Quotes and holds are read from here
  // rather than re-derived, so this record cannot disagree with the book.
  const rows = ledger.list(runtime.runId);
  const byId = new Map(rows.map((row) => [row.id, row]));

  const calls = events.map((event, index) => recordCall(event, index, byId));
  const bySettlement = tallySettlement(calls);

  // The record is only worth anything if it agrees with itself. The per-call hold
  // and the summary hold are computed from the same rows, so they can be checked
  // against each other, and they are: a record that claims a hold on every call it
  // ever paid for while reporting one held attempt is worse than no record, because
  // it looks like an audit. Failing loudly here is the right failure - the run
  // happened, but the document describing it does not survive its own arithmetic.
  assertHoldsAgree(calls, rows, totals);

  return {
    schema: "khata.decision-log/1",
    generatedAt: (input.generatedAt ?? new Date()).toISOString(),
    run: {
      runId: report.runId,
      planner: report.planner,
      plannerDescription: report.plannerDescription,
      question: DEMO_QUESTION,
      turns: report.turns,
      truncated: report.truncated,
      finalAnswer: report.finalContent,
      maxTurns: input.maxTurns ?? DEMO_MAX_TURNS,
      orphanedHoldsAtStartup: runtime.orphanedHolds.length,
    },
    policy: {
      perCallCeilingAtomic: limits.perCallCeiling.toString(),
      perCallCeilingUsd: formatUsd(limits.perCallCeiling),
      runBudgetAtomic: limits.runBudget.toString(),
      runBudgetUsd: formatUsd(limits.runBudget),
      allowedNetworks: [...spendAllowlist.networks].sort(),
      allowedSchemes: [...spendAllowlist.schemes].sort(),
      allowedPayees: [...config.policy.allowedPayees].sort(),
      allowedSellerHosts: allowlist.entries,
      sellerPortsPinned: allowlist.pinsPorts,
      transportGuardEngaged: runtime.transportGuardEngaged,
      burnerFreeIterations: BURNER_FREE_ITERATIONS,
      note:
        "Read-only. These numbers came from the environment at startup and were frozen " +
        "before the agent loop existed; no tool argument, no model output and no UI " +
        "control can change them.",
    },
    settlement: {
      chainTouched: false,
      mode: "local-stub",
      signer: "deterministic stub; no private key is read in this configuration",
      facilitator: "in-process stub facilitator on the seller side",
      realFundsMoved: false,
      note:
        "NO REAL MONEY MOVED. Every settled-stub row below was authorised and settled by an " +
        "in-process stub against a local test seller. A reported transaction hash is a stub " +
        "string, not a chain transaction. This record demonstrates policy decisions and " +
        "local protocol flow only.",
    },
    totals: {
      committedAtomic: totals.committed.toString(),
      committedUsd: formatUsd(totals.committed),
      heldAtomic: totals.reserved.toString(),
      heldAttemptCount: totals.heldAttemptCount,
      availableAtomic: totals.available.toString(),
      availableUsd: formatUsd(totals.available),
      signaturesProduced: signer.callCount,
      callsAttempted: calls.length,
      bySettlement,
    },
    tool: {
      name: PAID_FETCH_TOOL_NAME,
      parameters: PAID_FETCH_TOOL.function.parameters,
      note:
        "Sent to the model on every request. There is no field here from which a limit could " +
        "be read: no budget, no ceiling, no allowlist, no signer.",
    },
    calls,
    ledger: rows.map(toLedgerRow),
    limitations: [
      "The signer is a deterministic stub and the facilitator is an in-process stub; no chain was touched and no real funds moved.",
      "The demo runs the scripted planner, so no language model chose any of these URLs. The wire format and tool dispatch are proven against a real HTTP endpoint in tests/agent-llm.test.ts, but no live model call has been made.",
      "paid_fetch could only reach the two local test sellers on the ports listed under policy.allowedSellerHosts.",
      "The port pin and the transport guard are a defence for a local run, not a production boundary: a process already running on this machine can still be reached on an allowlisted loopback port.",
      "The tool schema has no field that could express a limit, but no real model has yet tried to set one.",
    ],
  };
}

function recordCall(event: RunEvent, index: number, byId: ReadonlyMap<string, Attempt>): RecordedCall {
  const { result } = event;
  const common = {
    index,
    callId: result.callId,
    tool: result.toolName,
    label: result.label,
    modelContent: toModelContent(result),
    spentBefore: event.spentBefore.toString(),
    spentAfter: event.spentAfter.toString(),
    spentAfterUsd: event.spentAfterUsd,
  };

  // Refused before the gate: nothing was fetched, so no ledger row exists either.
  if (result.kind === "refused") {
    return {
      ...common,
      url: null,
      settlement: "not-reached",
      gateOutcome: "not-reached",
      refusal: { code: result.code, message: result.reason },
      quotedAtomic: "0",
      quotedUsd: formatUsd(0n),
      committedAtomic: "0",
      committedUsd: formatUsd(0n),
      heldAtomic: "0",
      attemptId: null,
      ledgerState: null,
      httpStatus: null,
      reportedTxHash: null,
      untrusted: null,
    };
  }

  const outcome = result.outcome;
  const row = byId.get(outcome.attemptId) ?? null;
  const url = row?.url ?? null;
  const settled = outcome.kind === "paid" ? outcome.settledAtomic : 0n;

  const fromRow = {
    quotedAtomic: row?.quoteAtomic ?? "0",
    quotedUsd: formatUsd(parseAmount(row?.quoteAtomic ?? "0")),
    // Every branch takes the hold from here, so a settled row and a refused row
    // cannot disagree about what is still reserved.
    heldAtomic: heldNow(row),
    attemptId: outcome.attemptId,
    ledgerState: row?.state ?? null,
    httpStatus: outcome.status,
    reportedTxHash: outcome.kind === "paid" ? outcome.txHash : null,
    untrusted:
      result.untrusted === null
        ? null
        : { source: result.untrusted.source, content: result.untrusted.render() },
  };

  switch (outcome.kind) {
    case "paid":
      return {
        ...common,
        ...fromRow,
        url,
        // Never bare "paid": the facilitator was a local stub.
        settlement: "settled-stub",
        gateOutcome: "paid",
        refusal: null,
        committedAtomic: settled.toString(),
        committedUsd: formatUsd(settled),
      };
    case "free":
      return {
        ...common,
        ...fromRow,
        url,
        settlement: "free",
        gateOutcome: "free",
        refusal: null,
        committedAtomic: "0",
        committedUsd: formatUsd(0n),
      };
    case "refused":
      return {
        ...common,
        ...fromRow,
        url,
        settlement: "not-paid",
        gateOutcome: "refused",
        refusal: { code: outcome.refusal.code, message: outcome.refusal.message },
        committedAtomic: "0",
        committedUsd: formatUsd(0n),
      };
    case "interrupted":
      return {
        ...common,
        ...fromRow,
        url,
        settlement: "budget-held",
        gateOutcome: "interrupted",
        refusal: { code: "settlement-unknown", message: outcome.reason },
        // Nothing committed - the amount is still held, which is the point.
        committedAtomic: "0",
        committedUsd: formatUsd(0n),
      };
  }
}

/**
 * What the ledger holds for this attempt at this moment.
 *
 * `reserved_atomic` is the amount that was authorised, and it is kept forever as
 * history. It is only a *current* hold while the row is in a holding state, which
 * is exactly the set `Ledger.reserved()` filters on. So the column has to be read
 * together with `state`:
 *
 * | state        | `reserved_atomic` means | current hold |
 * |--------------|-------------------------|--------------|
 * | `reserved`   | in flight               | the amount   |
 * | `interrupted`| awaiting evidence       | the amount   |
 * | `settled`    | what was paid           | 0            |
 * | `released`   | what was given back     | 0            |
 * | `refused`    | nothing was authorised  | 0            |
 *
 * Reading the column alone is how a record ends up claiming six simultaneous
 * holds next to a `heldAttemptCount` of 1 - a document that contradicts itself,
 * which is the one failure mode this file exists to rule out.
 */
export function heldNow(row: Attempt | null): string {
  if (row === null) return "0";
  return row.state === "reserved" || row.state === "interrupted" ? row.reservedAtomic : "0";
}

function tallySettlement(calls: readonly RecordedCall[]): Record<SettlementStatus, number> {
  const counts: Record<SettlementStatus, number> = {
    "not-reached": 0,
    "not-paid": 0,
    "settled-stub": 0,
    "budget-held": 0,
    free: 0,
  };
  for (const call of calls) counts[call.settlement] += 1;
  return counts;
}

function toLedgerRow(attempt: Attempt): LedgerRow {
  return {
    id: attempt.id,
    ts: attempt.ts,
    url: attempt.url,
    decision: attempt.decision,
    state: attempt.state,
    quoteAtomic: attempt.quoteAtomic,
    reservedAtomic: attempt.reservedAtomic,
    heldAtomic: heldNow(attempt),
    settledAtomic: attempt.settledAtomic,
    txHash: attempt.txHash,
    committedBefore: attempt.committedBefore,
    availableBefore: attempt.availableBefore,
    reason: attempt.reason,
    reasonDetail: attempt.reasonDetail,
    untrusted: attempt.untrusted,
  };
}

function parseAmount(value: string): Atomic {
  return BigInt(value);
}

/**
 * The per-call holds, the per-row holds and the summary must be one number.
 *
 * Three views of the same fact, so two agreeing proves little. This checks the
 * per-call column against the summary, and both against the raw rows, which is
 * what catches a state filter that was widened or narrowed in one place only.
 */
function assertHoldsAgree(
  calls: readonly RecordedCall[],
  rows: readonly Attempt[],
  totals: LedgerTotals,
): void {
  const fromCalls = sumAtomic(calls.map((call) => parseAmount(call.heldAtomic)));
  if (fromCalls !== totals.reserved) {
    throw new Error(
      `the record would contradict itself: its call rows hold ${formatAtomic(fromCalls)} while the ` +
        `ledger holds ${formatAtomic(totals.reserved)}. Refusing to write it.`,
    );
  }

  const fromRows = sumAtomic(rows.map((row) => parseAmount(heldNow(row))));
  if (fromRows !== totals.reserved) {
    throw new Error(
      `the record would contradict itself: its ledger rows hold ${formatAtomic(fromRows)} while the ` +
        `ledger holds ${formatAtomic(totals.reserved)}. Refusing to write it.`,
    );
  }

  const heldRows = rows.filter((row) => heldNow(row) !== "0");
  if (heldRows.length !== totals.heldAttemptCount) {
    throw new Error(
      `the record would contradict itself: ${heldRows.length} row(s) hold a balance but the ledger ` +
        `counts ${totals.heldAttemptCount}. Refusing to write it.`,
    );
  }

  // And the same for committed spend, which is the number a reader looks at first.
  const fromSettled = sumAtomic(
    calls.filter((call) => call.settlement === "settled-stub").map((call) => parseAmount(call.committedAtomic)),
  );
  if (fromSettled !== totals.committed) {
    throw new Error(
      `the record would contradict itself: its settled rows commit ${formatAtomic(fromSettled)} while the ` +
        `ledger commits ${formatAtomic(totals.committed)}. Refusing to write it.`,
    );
  }
}

/** `bigint` is not JSON-serialisable, so the record is written as text. */
export function serialiseRecord(record: RunRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}
