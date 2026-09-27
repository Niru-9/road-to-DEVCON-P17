/**
 * The book.
 *
 * Two things live here, and both are needed for the purse to be safe:
 *
 *  1. **Every decision**, paid or refused, with the rule that decided it. This
 *     is the artefact Arjun reads the next morning.
 *  2. **Reservations.** When the purse approves a quote it reserves that amount
 *     against the run budget *before* signing. The reservation is a durable
 *     claim on the budget, not an intention.
 *
 * The distinction matters because approval and settlement are separated in
 * time. A signature is produced, a request is sent, and only then does a
 * `payment-response` say whether money moved. In between, the run is holding an
 * amount it does not yet know it has spent. If that in-between window were not
 * reserved, two concurrent calls would each see the pre-payment total and both
 * would be approved — and the purse would overdraw.
 *
 * ## Amounts are TEXT
 *
 * Base-unit amounts are stored as canonical decimal strings in `TEXT` columns,
 * and parsed to `bigint` in JavaScript. SQLite's `INTEGER` is a signed 64-bit
 * integer, which is a ceiling this project refuses to inherit: a token with 18
 * decimals and a large supply can exceed 2⁶³−1 base units, and a driver that
 * silently rounds is a budget that can be wrong. Storing the exact characters
 * also means the shipped record can be diffed and grepped by a human, and that
 * `readBigInts` is never needed as a substitute for correct typing.
 *
 * ## Reservations are fail-secure
 *
 * A process that dies between reserving and settling leaves a reservation whose
 * fate is genuinely unknown. Releasing it on restart would risk spending the same
 * budget twice. So an orphaned reservation **stays held**, is reported by
 * `orphanedReservations()`, and is resolved only by an explicit
 * `reconcile()` backed by evidence from the payment flow.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync as DatabaseSyncInstance } from "node:sqlite";
import type { Atomic } from "../money/amount.js";
import { formatAtomic, parseAtomic, subtractAtomic, sumAtomic } from "../money/amount.js";
import type { Refusal } from "../policy/policy.js";
import { DatabaseSync } from "./sqlite.js";

/**
 * Lifecycle of a single payment attempt.
 *
 * - `refused`   — the policy said no. Terminal. Nothing was signed, nothing held.
 * - `reserved`  — approved, budget held, payment in flight.
 * - `settled`   — money moved, confirmed by the x402 `payment-response`.
 * - `released`  — the payment flow established that no settlement happened, so
 *                 the hold is returned to the budget.
 * - `interrupted` — a previous process died holding this reservation. The amount
 *                 remains held. Only `reconcile()` may change it.
 */
export type AttemptState = "refused" | "reserved" | "settled" | "released" | "interrupted";

/** States whose amount is still held against the run budget. */
const HOLDING_STATES: ReadonlySet<AttemptState> = new Set<AttemptState>([
  "reserved",
  "interrupted",
]);

export interface Attempt {
  readonly id: string;
  readonly runId: string;
  readonly ts: string;
  readonly tool: string;
  readonly url: string;
  readonly scheme: string | null;
  readonly network: string | null;
  readonly asset: string | null;
  readonly payTo: string | null;
  /** Canonical decimal string, base units. The seller's quote. */
  readonly quoteAtomic: string;
  readonly decision: "approved" | "refused";
  readonly reason: string | null;
  readonly reasonDetail: string | null;
  readonly state: AttemptState;
  /** Canonical decimal string. Zero for a refused attempt. */
  readonly reservedAtomic: string;
  /** Canonical decimal string, from the x402 settle response. Null until settled. */
  readonly settledAtomic: string | null;
  readonly txHash: string | null;
  /** Canonical decimal strings: the budget as it stood when this was decided. */
  readonly committedBefore: string;
  readonly reservedBefore: string;
  readonly availableBefore: string;
  /**
   * Seller-controlled text, kept for the audit trail only.
   *
   * Nothing in this column is ever read back into a model prompt — see
   * `src/untrusted/quarantine.ts`. It exists so that a reader can see what the
   * rogue stall said, including an attempted prompt injection.
   */
  readonly untrusted: string | null;
}

/** What the purse needs to know about the budget. All base units. */
export interface LedgerTotals {
  /** Money that actually moved. */
  readonly committed: Atomic;
  /** Money approved but not yet accounted for. */
  readonly reserved: Atomic;
  /** `runBudget − committed − reserved`. */
  readonly available: Atomic;
  readonly runBudget: Atomic;
  readonly heldAttemptCount: number;
}

export interface ReserveApprovedInput {
  readonly id: string;
  readonly runId: string;
  readonly tool: string;
  readonly url: string;
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly payTo: string;
  readonly quote: Atomic;
  /**
   * Redundant, and deliberately not trusted.
   *
   * The ledger enforces against the budget stored in the `runs` row. This field
   * is a cross-check: if the caller's config and the persisted run disagree,
   * the reservation is refused rather than silently obeying whichever number
   * is more convenient.
   */
  readonly expectedRunBudget: Atomic;
  /**
   * What the seller actually asked for, retained verbatim.
   *
   * A settled attempt is the row an investigator reads first, so it is the row
   * that most needs the seller's original wording on it. It is stored as text
   * and never read back into a decision — see `src/untrusted/quarantine.ts`.
   */
  readonly untrusted?: string | null;
}

export interface ReserveRefusedInput {
  readonly id: string;
  readonly runId: string;
  readonly tool: string;
  readonly url: string;
  readonly quoteAtomic: string;
  readonly refusal: Refusal;
  /**
   * The precise code to store, when the real reason is not a `RefusalCode`.
   *
   * A decode failure is rejected for reasons the policy union does not name
   * (`no-acceptable-quote`, `missing-402`), and a decode failure can also be
   * *caused by* a policy code - an over-ceiling quote surfaces as
   * `per-call-ceiling-exceeded`. Recording a blanket `malformed-requirements`
   * for those loses which rule actually fired, which is the one thing this table
   * exists to answer.
   */
  readonly reasonCode?: string;
  /** The message to store alongside it, when it differs from `refusal.message`. */
  readonly reasonMessage?: string;
  /** Present when a requirement was decoded before the refusal. */
  readonly quote?: {
    readonly scheme: string;
    readonly network: string;
    readonly asset: string;
    readonly payTo: string;
  };
  readonly untrusted?: string | null;
}

export interface SettleEvidence {
  /** From the x402 `payment-response`. */
  readonly success: boolean;
  /** Canonical decimal string. Omitted for `exact`, which settles the quote. */
  readonly settledAtomic?: string;
  readonly txHash?: string;
  readonly payer?: string;
  readonly network?: string;
  readonly errorReason?: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS attempts (
  id                TEXT PRIMARY KEY,
  run_id            TEXT NOT NULL,
  ts                TEXT NOT NULL,
  tool              TEXT NOT NULL,
  url               TEXT NOT NULL,
  scheme            TEXT,
  network           TEXT,
  asset             TEXT,
  pay_to            TEXT,
  quote_atomic      TEXT NOT NULL,
  decision          TEXT NOT NULL,
  reason            TEXT,
  reason_detail     TEXT,
  state             TEXT NOT NULL,
  reserved_atomic   TEXT NOT NULL,
  settled_atomic    TEXT,
  tx_hash           TEXT,
  committed_before  TEXT NOT NULL,
  reserved_before   TEXT NOT NULL,
  available_before  TEXT NOT NULL,
  untrusted         TEXT
);
CREATE INDEX IF NOT EXISTS attempts_run_idx ON attempts (run_id, id);
CREATE INDEX IF NOT EXISTS attempts_state_idx ON attempts (state);

-- The attempt-id allocator.
--
-- \`attempts.id\` is a global PRIMARY KEY, so an id must be unique across every
-- run that has ever touched this file, not just the current runtime. Minting
-- them from a counter held in a closure gets that wrong: a second runtime over
-- the same file starts again at 1 and collides with the first run's rows, which
-- is \`UNIQUE constraint failed: attempts.id\`.
--
-- So the sequence lives here, in the same database it protects. It is seeded
-- from the ids already present (see Ledger.open) so an existing ledger keeps
-- counting instead of re-issuing an id it has already used.
CREATE TABLE IF NOT EXISTS attempt_sequence (
  tool          TEXT PRIMARY KEY,
  value         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  run_budget    TEXT NOT NULL,
  planner       TEXT NOT NULL,
  question      TEXT NOT NULL DEFAULT ''
);

-- Single-row table: which process last claimed this ledger. Written by
-- claimForProcess() at startup so a recovery can name the predecessor it
-- recovered holds from.
CREATE TABLE IF NOT EXISTS process_state (
  id         INTEGER PRIMARY KEY CHECK (id = 1),
  owner      TEXT,
  claimed_at TEXT
);
`;

interface AttemptRow {
  id: string;
  run_id: string;
  ts: string;
  tool: string;
  url: string;
  scheme: string | null;
  network: string | null;
  asset: string | null;
  pay_to: string | null;
  quote_atomic: string;
  decision: string;
  reason: string | null;
  reason_detail: string | null;
  state: string;
  reserved_atomic: string;
  settled_atomic: string | null;
  tx_hash: string | null;
  committed_before: string;
  reserved_before: string;
  available_before: string;
  untrusted: string | null;
}

function toAttempt(row: AttemptRow): Attempt {
  return {
    id: row.id,
    runId: row.run_id,
    ts: row.ts,
    tool: row.tool,
    url: row.url,
    scheme: row.scheme,
    network: row.network,
    asset: row.asset,
    payTo: row.pay_to,
    quoteAtomic: row.quote_atomic,
    decision: row.decision === "approved" ? "approved" : "refused",
    reason: row.reason,
    reasonDetail: row.reason_detail,
    state: row.state as AttemptState,
    reservedAtomic: row.reserved_atomic,
    settledAtomic: row.settled_atomic,
    txHash: row.tx_hash,
    committedBefore: row.committed_before,
    reservedBefore: row.reserved_before,
    availableBefore: row.available_before,
    untrusted: row.untrusted,
  };
}

export class Ledger {
  private readonly db: DatabaseSyncInstance;
  private closed = false;
  private readonly path: string;

  private constructor(db: DatabaseSyncInstance, path: string) {
    this.db = db;
    this.path = path;
  }

  /**
   * Open (and create if absent) the book.
   *
   * `:memory:` is honoured for tests. A file path gets its parent directory
   * created, because the first thing a new user does is run the demo.
   */
  static open(path: string): Ledger {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    const db = new DatabaseSync(path);
    // WAL keeps a reader (the audit UI) from blocking a writer, and FULL
    // synchronous means a reservation survives a power cut, not just a crash.
    if (path !== ":memory:") {
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
    }
    db.exec(SCHEMA);
    Ledger.seedAttemptSequence(db);
    return new Ledger(db, path);
  }

  /**
   * Continue each tool's numbering from the ids already in `attempts`.
   *
   * A ledger written before this table existed has rows but no sequence, so the
   * first mint would hand out an id that is already on disk. Reading the
   * existing ids forward is what makes the fix safe to deploy onto a ledger
   * with history: nothing is deleted or rewritten, the next id is simply the
   * next one.
   *
   * `INSERT OR IGNORE` keeps this idempotent and non-destructive. Once a real
   * mint has advanced the sequence, reopening the ledger must not walk it back
   * to the highest id it can see, so an existing row always wins.
   */
  private static seedAttemptSequence(db: DatabaseSyncInstance): void {
    const rows = db.prepare("SELECT id FROM attempts").all() as { id: string }[];
    const highest = new Map<string, number>();
    for (const { id } of rows) {
      const match = /^(.*)-(\d+)$/.exec(id);
      if (match === null) continue;
      const tool = match[1] as string;
      const value = Number(match[2]);
      if (!highest.has(tool) || value > (highest.get(tool) as number)) highest.set(tool, value);
    }
    const insert = db.prepare("INSERT OR IGNORE INTO attempt_sequence (tool, value) VALUES (?, ?)");
    for (const [tool, value] of highest) insert.run(tool, value);
  }

  /**
   * Allocate the next globally unique attempt id for one tool.
   *
   * Uniqueness is the database's job, not a convention: the counter is durable
   * and monotonic, so ids stay unique across repeated runs on one file and
   * across process restarts. `attempts.id` remains the enforcing backstop.
   *
   * Synchronous to match the gate's `nextAttemptId: (tool) => string` seam, so
   * a caller can mint an id before it knows whether the attempt will be a
   * refusal or a reservation.
   */
  mintAttemptId(tool: string): string {
    this.db
      .prepare(
        `INSERT INTO attempt_sequence (tool, value) VALUES (?, 1)
         ON CONFLICT(tool) DO UPDATE SET value = value + 1`,
      )
      .run(tool);
    const row = this.db.prepare("SELECT value FROM attempt_sequence WHERE tool = ?").get(tool) as {
      value: number;
    };
    return `${tool}-${row.value}`;
  }

  /** Where this ledger is stored. */
  get location(): string {
    return this.path;
  }

  // -------------------------------------------------------------------------
  // Runs
  // -------------------------------------------------------------------------

  openRun(input: {
    runId: string;
    runBudget: Atomic;
    planner: string;
    question: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO runs (run_id, started_at, run_budget, planner, question)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(input.runId, new Date().toISOString(), formatAtomic(input.runBudget), input.planner, input.question);
  }

  closeRun(runId: string): void {
    this.db
      .prepare("UPDATE runs SET ended_at = ? WHERE run_id = ?")
      .run(new Date().toISOString(), runId);
  }

  runExists(runId: string): boolean {
    const row = this.db
      .prepare("SELECT run_id FROM runs WHERE run_id = ?")
      .get(runId) as { run_id: string } | undefined;
    return row !== undefined;
  }

  /** The budget this run was opened with, in base units. */
  runBudgetFor(runId: string): Atomic | null {
    const row = this.db
      .prepare("SELECT run_budget FROM runs WHERE run_id = ?")
      .get(runId) as { run_budget: string } | undefined;
    return row === undefined ? null : parseAtomic(row.run_budget, "runs.run_budget");
  }

  // -------------------------------------------------------------------------
  // Totals
  // -------------------------------------------------------------------------

  /**
   * Money that moved: the sum of settled amounts. Read from the rows rather
   * than from a running counter, so it cannot drift from the audit trail.
   *
   * Scoped to `runId` when given, because the budget is a *per-run* budget. Two
   * runs sharing one ledger file must not see each other's spending, or the
   * second run inherits a purse the first already drained.
   */
  committed(runId?: string): Atomic {
    return this.sumColumn("settled_atomic", "settled", undefined, runId);
  }

  /**
   * Money held by unresolved reservations.
   *
   * `interrupted` is included on purpose. A reservation from a dead process is
   * still a claim on the budget, and treating it as available money is how a
   * purse overdraws after a crash.
   */
  reserved(runId?: string): Atomic {
    return this.sumColumn("reserved_atomic", null, HOLDING_STATES, runId);
  }

  private sumColumn(
    column: string,
    state: string | null,
    states?: ReadonlySet<AttemptState>,
    runId?: string,
  ): Atomic {
    const clauses: string[] = [`${column} IS NOT NULL`];
    const params: string[] = [];
    if (state !== null) {
      clauses.push("state = ?");
      params.push(state);
    }
    if (states !== undefined) {
      const list = [...states];
      clauses.push(`state IN (${list.map(() => "?").join(", ")})`);
      params.push(...list);
    }
    if (runId !== undefined) {
      clauses.push("run_id = ?");
      params.push(runId);
    }
    // The parameters must actually be bound. Leaving them out makes SQLite
    // compare against NULL, `state IN (NULL, NULL)` is never true, and every
    // total silently reads as zero — a budget that believes it has spent
    // nothing.
    const rows = this.db
      .prepare(`SELECT ${column} AS v FROM attempts WHERE ${clauses.join(" AND ")}`)
      .all(...params) as unknown as Array<{ v: string }>;
    return sumAtomic(rows.map((row) => parseAtomic(row.v, `attempts.${column}`)));
  }

  /**
   * The persisted budget for a run, or a hard failure.
   *
   * The budget lives in the `runs` row rather than in whatever the caller
   * happens to be holding in config. If they disagree, the ledger wins: a stale
   * config file must not be able to widen a purse, and a process that
   * invents a run id must not be handed a full budget by default.
   */
  private requireRunBudget(runId: string): Atomic {
    const budget = this.runBudgetFor(runId);
    if (budget === null) {
      throw new Error(
        `run ${runId} is not open: refusing to report a budget. An unknown run must not look like a full purse.`,
      );
    }
    return budget;
  }

  /**
   * The four numbers the policy needs, for one run.
   *
   * Both components are read inside the caller's transaction where there is
   * one, so `available` is a single consistent snapshot rather than three
   * separate reads that another writer could slip between.
   */
  totals(runId: string): LedgerTotals {
    const runBudget = this.requireRunBudget(runId);
    const committed = this.committed(runId);
    const reserved = this.reserved(runId);
    const held = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM attempts
          WHERE run_id = ? AND state IN (${[...HOLDING_STATES].map(() => "?").join(", ")})`,
      )
      .get(runId, ...[...HOLDING_STATES]) as { n: number };
    return {
      committed,
      reserved,
      available: subtractAtomic(runBudget, committed + reserved),
      runBudget,
      heldAttemptCount: held.n,
    };
  }

  // -------------------------------------------------------------------------
  // Decisions
  // -------------------------------------------------------------------------

  /**
   * Record a refusal. Nothing is held, nothing is signed.
   *
   * A refusal is still a budget-relevant fact for the audit trail, so it is
   * stored with the totals as they stood.
   */
  recordRefusal(input: ReserveRefusedInput): Attempt {
    const totals = this.totals(input.runId);
    const attempt: Attempt = {
      id: input.id,
      runId: input.runId,
      ts: new Date().toISOString(),
      tool: input.tool,
      url: input.url,
      scheme: input.quote?.scheme ?? null,
      network: input.quote?.network ?? null,
      asset: input.quote?.asset ?? null,
      payTo: input.quote?.payTo ?? null,
      quoteAtomic: input.quoteAtomic,
      decision: "refused",
      reason: input.reasonCode ?? input.refusal.code,
      reasonDetail: input.reasonMessage ?? input.refusal.message,
      state: "refused",
      reservedAtomic: "0",
      settledAtomic: null,
      txHash: null,
      committedBefore: formatAtomic(totals.committed),
      reservedBefore: formatAtomic(totals.reserved),
      availableBefore: formatAtomic(totals.available),
      untrusted: input.untrusted ?? null,
    };
    this.insert(attempt);
    return attempt;
  }

  /**
   * Hold budget for an approved quote, atomically.
   *
   * The caller has already had `checkCumulative` approve this quote, but the
   * re-check inside the transaction is the point: between the policy's decision
   * and this insert, another call may have reserved. The transaction makes
   * "read the totals, decide, take the money" a single indivisible step, so
   * concurrent callers cannot both pass.
   *
   * `BEGIN IMMEDIATE` takes the write lock up front, which is what stops a
   * second connection reading a stale total.
   */
  reserve(input: ReserveApprovedInput): Attempt {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // The budget is read from the `runs` row, inside the transaction, not
      // taken from the caller. `BEGIN IMMEDIATE` holds the write lock, so this
      // read and the insert below are one indivisible step and a second
      // connection cannot read a stale total.
      const runBudget = this.requireRunBudget(input.runId);
      if (runBudget !== input.expectedRunBudget) {
        throw new Error(
          `run ${input.runId} has a persisted budget of ${formatAtomic(runBudget)} but the caller ` +
            `expected ${formatAtomic(input.expectedRunBudget)}. Refusing rather than obeying the ` +
            `more convenient of the two.`,
        );
      }
      const committed = this.committed(input.runId);
      const reserved = this.reserved(input.runId);
      const used = committed + reserved;
      if (used > runBudget) {
        throw new Error(
          `ledger is over-committed: held ${formatAtomic(used)} against a budget of ${formatAtomic(runBudget)}`,
        );
      }
      const available = runBudget - used;
      if (input.quote > available) {
        throw new Error(
          `reservation of ${formatAtomic(input.quote)} exceeds the available ${formatAtomic(available)}`,
        );
      }
      const attempt: Attempt = {
        id: input.id,
        runId: input.runId,
        ts: new Date().toISOString(),
        tool: input.tool,
        url: input.url,
        scheme: input.scheme,
        network: input.network,
        asset: input.asset,
        payTo: input.payTo,
        quoteAtomic: formatAtomic(input.quote),
        decision: "approved",
        reason: null,
        reasonDetail: null,
        state: "reserved",
        reservedAtomic: formatAtomic(input.quote),
        settledAtomic: null,
        txHash: null,
        committedBefore: formatAtomic(committed),
        reservedBefore: formatAtomic(reserved),
        availableBefore: formatAtomic(available),
        untrusted: input.untrusted ?? null,
      };
      this.insert(attempt);
      this.db.exec("COMMIT");
      return attempt;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private insert(attempt: Attempt): void {
    this.db
      .prepare(
        `INSERT INTO attempts (
           id, run_id, ts, tool, url, scheme, network, asset, pay_to,
           quote_atomic, decision, reason, reason_detail, state,
           reserved_atomic, settled_atomic, tx_hash,
           committed_before, reserved_before, available_before, untrusted
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.id,
        attempt.runId,
        attempt.ts,
        attempt.tool,
        attempt.url,
        attempt.scheme,
        attempt.network,
        attempt.asset,
        attempt.payTo,
        attempt.quoteAtomic,
        attempt.decision,
        attempt.reason,
        attempt.reasonDetail,
        attempt.state,
        attempt.reservedAtomic,
        attempt.settledAtomic,
        attempt.txHash,
        attempt.committedBefore,
        attempt.reservedBefore,
        attempt.availableBefore,
        attempt.untrusted,
      );
  }

  /**
   * Reconcile a reservation against evidence from the payment flow.
   *
   * The `exact` scheme settles the quoted amount, and `SettleResponse.amount` is
   * only populated for schemes like `upto` where the settled figure can differ
   * from the authorised maximum. So:
   *
   * - `amount` present  → use it, and reject it if it exceeds what was reserved.
   * - `amount` absent    → the quote *is* the settlement, because the scheme is
   *   `exact`. That is an assumption about the scheme, so it is stated rather
   *   than hidden, and it is only reachable for a scheme the allowlist accepted.
   *
   * A successful settlement moves the amount from `reserved` to `committed`: it
   * is subtracted from the hold and added to the total, so the budget total is
   * unchanged and only its composition moves.
   */
  reconcile(attemptId: string, evidence: SettleEvidence): Attempt {
    const current = this.get(attemptId);
    if (current === null) {
      throw new Error(`no attempt with id ${attemptId}`);
    }
    if (current.state === "refused") {
      throw new Error(`attempt ${attemptId} was refused and holds nothing to reconcile`);
    }
    if (current.state === "settled" || current.state === "released") {
      throw new Error(`attempt ${attemptId} is already ${current.state}`);
    }

    if (!evidence.success) {
      // The flow established that no settlement occurred, so the hold is
      // returned. This is the only path that may release a reservation.
      this.db
        .prepare(
          `UPDATE attempts
              SET state = 'released', reason = ?, reason_detail = ?
            WHERE id = ?`,
        )
        .run(
          "no-settlement",
          evidence.errorReason ?? "the payment flow completed without settling",
          attemptId,
        );
      return this.require(attemptId);
    }

    const reserved = parseAtomic(current.reservedAtomic, "reserved_atomic");
    const settled =
      evidence.settledAtomic === undefined
        ? reserved
        : parseAtomic(evidence.settledAtomic, "settle response amount");

    if (settled > reserved) {
      throw new Error(
        `settled ${formatAtomic(settled)} exceeds the ${formatAtomic(reserved)} reserved for ${attemptId}`,
      );
    }

    this.db
      .prepare(
        `UPDATE attempts
            SET state = 'settled', settled_atomic = ?, tx_hash = ?, reason = ?
          WHERE id = ?`,
      )
      .run(formatAtomic(settled), evidence.txHash ?? null, "settled", attemptId);

    return this.require(attemptId);
  }

  /**
   * Mark a reservation as interrupted — a previous process died holding it.
   *
   * The amount stays held. Nothing else may change an `interrupted` row except
   * `reconcile()`, because the safe assumption is that the payment may have gone
   * through after the process died.
   */
  markInterrupted(attemptId: string, detail: string): Attempt {
    this.db
      .prepare(
        `UPDATE attempts SET state = 'interrupted', reason = ?, reason_detail = ?
          WHERE id = ? AND state = 'reserved'`,
      )
      .run("interrupted", detail, attemptId);
    return this.require(attemptId);
  }

  /** Reservations held by a previous process, still awaiting evidence. */
  orphanedReservations(): Attempt[] {
    return this.list().filter((attempt) => attempt.state === "interrupted");
  }

  /** Reservations this process has in flight. */
  inFlight(): Attempt[] {
    return this.list().filter((attempt) => attempt.state === "reserved");
  }

  /**
   * Claim the ledger for this process, and return the holds a dead predecessor
   * left behind.
   *
   * On startup every `reserved` row is moved to `interrupted` in one
   * transaction. This assumes one writer at a time, which is what the purse is
   * for: a single agent process spending a single budget. Under that assumption
   * a `reserved` row at startup cannot belong to a live peer, so it is an
   * orphan by definition. If a second process ever needs to share a purse, the
   * owner column below is where the lease goes.
   *
   * The amounts stay held either way. The point of the state change is honesty
   * about provenance — an `interrupted` row is a hold awaiting evidence, and
   * only `reconcile()` may release it.
   */
  claimForProcess(owner: string): Attempt[] {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO process_state (id, owner, claimed_at) VALUES (1, ?, ?)
             ON CONFLICT(id) DO UPDATE SET owner = excluded.owner,
                                          claimed_at = excluded.claimed_at`,
        )
        .run(owner, new Date().toISOString());
      this.db
        .prepare(
          `UPDATE attempts
              SET state = 'interrupted', reason = 'interrupted', reason_detail = ?
            WHERE state = 'reserved'`,
        )
        .run(`recovered at startup; previous owner was ${this.previousOwner()}`);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.orphanedReservations();
  }

  private previousOwner(): string | null {
    const row = this.db.prepare("SELECT owner FROM process_state WHERE id = 1").get() as
      | { owner: string | null }
      | undefined;
    return row?.owner ?? null;
  }

  /** Who last claimed this ledger, for the audit trail. */
  ledgerOwner(): string | null {
    const row = this.db.prepare("SELECT owner FROM process_state WHERE id = 1").get() as
      | { owner: string | null }
      | undefined;
    return row?.owner ?? null;
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  get(id: string): Attempt | null {
    const row = this.db.prepare("SELECT * FROM attempts WHERE id = ?").get(id) as
      | AttemptRow
      | undefined;
    return row === undefined ? null : toAttempt(row);
  }

  private require(id: string): Attempt {
    const attempt = this.get(id);
    if (attempt === null) throw new Error(`no attempt with id ${id}`);
    return attempt;
  }

  list(runId?: string): Attempt[] {
    const rows =
      runId === undefined
        ? (this.db.prepare("SELECT * FROM attempts ORDER BY ts, id").all() as unknown as AttemptRow[])
        : (this.db
            .prepare("SELECT * FROM attempts WHERE run_id = ? ORDER BY ts, id")
            .all(runId) as unknown as AttemptRow[]);
    return rows.map(toAttempt);
  }

  /** Refusals grouped by rule, for a one-line summary. */
  refusalSummary(runId?: string): Record<string, number> {
    const rows = this.db
      .prepare(
        `SELECT reason, COUNT(*) AS n FROM attempts
          WHERE decision = 'refused' ${runId === undefined ? "" : "AND run_id = ?"}
          GROUP BY reason ORDER BY n DESC`,
      )
      .all(...(runId === undefined ? [] : [runId])) as Array<{ reason: string | null; n: number }>;
    const summary: Record<string, number> = {};
    for (const row of rows) {
      summary[row.reason ?? "unknown"] = row.n;
    }
    return summary;
  }

  /**
   * Close the database. Idempotent: a cleanup path that runs twice — a test
   * `afterEach` after the test already closed it, a `finally` after an early
   * return — must not throw `database is not open` and mask the real result.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
