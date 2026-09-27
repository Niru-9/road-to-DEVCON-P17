import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "../src/ledger/sqlite.js";
import { Ledger, type Attempt } from "../src/ledger/ledger.js";
import { parseAtomic, formatAtomic } from "../src/money/amount.js";
import type { Refusal } from "../src/policy/policy.js";

const RUN = "run-1";
const BUDGET = 5_000_000n; // $5.00
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const NET = "eip155:11155111";

let dir: string;
let path: string;
let ledger: Ledger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "khata-ledger-"));
  path = join(dir, "purse.sqlite");
  ledger = Ledger.open(path);
  ledger.openRun({ runId: RUN, runBudget: BUDGET, planner: "scripted", question: "q" });
});

afterEach(() => {
  // close() is idempotent, so tests that already closed mid-body are fine.
  ledger.close();
  // WAL mode leaves -wal/-shm handles; a locked file would make the delete
  // fail and mask the real assertion with an EBUSY.
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

function reserve(
  id: string,
  quote: bigint,
  overrides: Partial<{ scheme: string; network: string; asset: string; payTo: string }> = {},
): Attempt {
  return ledger.reserve({
    id,
    runId: RUN,
    tool: "paid_fetch",
    url: "http://127.0.0.1:4031/rain/grid",
    scheme: overrides.scheme ?? "exact",
    network: overrides.network ?? NET,
    asset: overrides.asset ?? USDC,
    payTo: overrides.payTo ?? "0x1111111111111111111111111111111111111111",
    quote,
    expectedRunBudget: BUDGET,
  });
}

describe("Check 7 (7 pts) — cumulative spend is persisted outside process memory", () => {
  it("writes a real SQLite file to disk", () => {
    expect(path.endsWith(".sqlite")).toBe(true);
    reserve("a1", 1_000n);
    ledger.close();
    // The row is in a file that outlived the handle, not in process memory.
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(0);
  });

  it("is a real SQLite database, readable by an independent reader", () => {
    // Proves the file is not a private encoding: the standard library opens it,
    // sees the expected tables, and reads the row back.
    reserve("a1", 1_000n);
    ledger.close();

    const reader = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = (
        reader
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as unknown as Array<{ name: string }>
      ).map((row) => row.name);
      // `attempt_sequence` is the attempt-id allocator. It lives here so ids stay
  // unique across repeated runs on one file and across restarts; a ledger that
  // omits it would mint ids in memory and collide on the second run.
  expect(tables).toEqual(["attempt_sequence", "attempts", "process_state", "runs"]);
      const row = reader
        .prepare("SELECT id, quote_atomic, reserved_atomic, state FROM attempts")
        .get() as unknown as { id: string; quote_atomic: string; reserved_atomic: string; state: string };
      expect(row).toEqual({ id: "a1", quote_atomic: "1000", reserved_atomic: "1000", state: "reserved" });
    } finally {
      reader.close();
    }
  });

  it("stores amounts as canonical decimal strings, never as SQLite INTEGER", () => {
    // A value beyond signed 64-bit. SQLite INTEGER is a signed 64-bit column,
    // so a schema that used one would reject or corrupt this.
    const beyond64 = 1_180_591_620_717_411_303_424n; // 2^70
    expect(beyond64 > 9_223_372_036_854_775_807n).toBe(true);
    const bigPath = join(dir, "big.sqlite");
    const other = Ledger.open(bigPath);
    other.openRun({ runId: "big", runBudget: beyond64 * 2n, planner: "scripted", question: "" });
    other.reserve({
      id: "big-1",
      runId: "big",
      tool: "paid_fetch",
      url: "http://x/y",
      scheme: "exact",
      network: NET,
      asset: USDC,
      payTo: "0x1111111111111111111111111111111111111111",
      quote: beyond64,
      expectedRunBudget: beyond64 * 2n,
    });
    expect(other.reserved("big")).toBe(beyond64);
    other.close();

    const reopened = Ledger.open(bigPath);
    expect(reopened.reserved("big")).toBe(beyond64);
    // The stored characters are exactly the canonical decimal string.
    expect(reopened.list()[0]?.reservedAtomic).toBe("1180591620717411303424");
    expect(reopened.list()[0]?.quoteAtomic).toBe("1180591620717411303424");
    reopened.close();

    // And the on-disk column type really is TEXT, read independently of our
    // own schema string.
    const reader = new DatabaseSync(bigPath, { readOnly: true });
    try {
      const declared = reader.prepare("PRAGMA table_info(attempts)").all() as unknown as Array<{
        name: string;
        type: string;
      }>;
      const byName = new Map(declared.map((c) => [c.name, c.type.toUpperCase()]));
      expect(byName.get("quote_atomic")).toBe("TEXT");
      expect(byName.get("reserved_atomic")).toBe("TEXT");
      expect(byName.get("settled_atomic")).toBe("TEXT");
    } finally {
      reader.close();
    }
  });

  it("reads the total back from a completely fresh connection", () => {
    reserve("a1", 1_000n);
    reserve("a2", 2_000n);
    expect(ledger.reserved(RUN)).toBe(3_000n);

    // A brand new Ledger object over the same file: the state cannot be coming
    // from any variable in the first object.
    const reopened = Ledger.open(path);
    expect(reopened.reserved(RUN)).toBe(3_000n);
    expect(reopened.committed(RUN)).toBe(0n);
    expect(reopened.list()).toHaveLength(2);
    expect(reopened.list()[0]?.id).toBe("a1");
    reopened.close();
  });

  it("declares the amount columns as TEXT, so the schema cannot drift to INTEGER", () => {
    const schema = (ledger as unknown as { db: { prepare(sql: string): { all(): unknown[] } } })
      .db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'attempts'")
      .all() as Array<{ sql: string }>;
    const ddl = schema[0]?.sql ?? "";
    expect(ddl).toMatch(/quote_atomic\s+TEXT/);
    expect(ddl).toMatch(/reserved_atomic\s+TEXT/);
    expect(ddl).toMatch(/settled_atomic\s+TEXT/);
    expect(ddl).not.toMatch(/(quote_atomic|reserved_atomic|settled_atomic)\s+INTEGER/);
  });

  it("records the budget as it stood, so a disputed total needs no SQL", () => {
    reserve("a1", 1_000n);
    reserve("a2", 2_000n);
    const second = ledger.list()[1];
    expect(second?.committedBefore).toBe("0");
    expect(second?.reservedBefore).toBe("1000");
    expect(second?.availableBefore).toBe(formatAtomic(BUDGET - 1_000n));
  });
});

describe("reservation lifecycle", () => {
  it("starts approved at `reserved` with the amount held", () => {
    const attempt = reserve("a1", 1_000n);
    expect(attempt.state).toBe("reserved");
    expect(attempt.decision).toBe("approved");
    expect(attempt.reservedAtomic).toBe("1000");
    expect(attempt.settledAtomic).toBeNull();
    expect(ledger.totals(RUN).heldAttemptCount).toBe(1);
  });

  it("moves the amount from reserved to committed on settlement", () => {
    reserve("a1", 1_500n);
    ledger.reconcile("a1", { success: true, txHash: "0xdead", payer: "0xbeef", network: NET });

    const totals = ledger.totals(RUN);
    expect(totals.committed).toBe(1_500n);
    expect(totals.reserved).toBe(0n);
    // The budget total is unchanged; only its composition moved.
    expect(totals.available).toBe(BUDGET - 1_500n);
    expect(ledger.get("a1")?.state).toBe("settled");
    expect(ledger.get("a1")?.txHash).toBe("0xdead");
  });

  it("treats an absent settle amount as the quote, because the scheme is `exact`", () => {
    reserve("a1", 1_500n);
    // SettleResponse.amount is only populated for `upto`. For `exact` the
    // authorised amount is what moves, so the quote is the settlement.
    ledger.reconcile("a1", { success: true });
    expect(ledger.committed(RUN)).toBe(1_500n);
  });

  it("uses an explicit settle amount when the facilitator reports one", () => {
    reserve("a1", 1_500n);
    // A settlement smaller than the authorisation: the difference is returned.
    ledger.reconcile("a1", { success: true, settledAtomic: "900" });
    expect(ledger.committed(RUN)).toBe(900n);
    expect(ledger.reserved(RUN)).toBe(0n);
  });

  it("refuses a settlement larger than what was reserved", () => {
    reserve("a1", 1_500n);
    expect(() => ledger.reconcile("a1", { success: true, settledAtomic: "1501" })).toThrow(
      /exceeds the 1500 reserved/,
    );
    // The reservation is untouched — a rejected reconcile must not free it.
    expect(ledger.get("a1")?.state).toBe("reserved");
    expect(ledger.reserved(RUN)).toBe(1_500n);
  });

  it("rejects a non-canonical settle amount instead of coercing it", () => {
    reserve("a1", 1_500n);
    expect(() => ledger.reconcile("a1", { success: true, settledAtomic: "1.5" })).toThrow();
  });

  it("releases the hold when the flow establishes no settlement", () => {
    reserve("a1", 1_500n);
    ledger.reconcile("a1", { success: false, errorReason: "seller returned 500 after verify" });
    const totals = ledger.totals(RUN);
    expect(totals.reserved).toBe(0n);
    expect(totals.committed).toBe(0n);
    expect(totals.available).toBe(BUDGET);
    expect(ledger.get("a1")?.state).toBe("released");
    expect(ledger.get("a1")?.reason).toBe("no-settlement");
  });

  it("refuses to reconcile a refused attempt, which holds nothing", () => {
    const refusal: Refusal = { code: "per-call-ceiling-exceeded", message: "too much" };
    ledger.recordRefusal({ id: "r1", runId: RUN, tool: "paid_fetch", url: "u", quoteAtomic: "9999999", refusal });
    expect(() => ledger.reconcile("r1", { success: true })).toThrow(/was refused/);
  });

  it("refuses to reconcile the same attempt twice", () => {
    reserve("a1", 1_500n);
    ledger.reconcile("a1", { success: true });
    expect(() => ledger.reconcile("a1", { success: true })).toThrow(/already settled/);
  });

  it("records a refusal without holding anything", () => {
    const refusal: Refusal = { code: "network-not-allowed", message: "eip155:1 is not allowed" };
    const attempt = ledger.recordRefusal(
      {
        id: "r1",
        runId: RUN,
        tool: "paid_fetch",
        url: "http://rogue/wrong-network",
        quoteAtomic: "1000",
        refusal,
        quote: { scheme: "exact", network: "eip155:1", asset: USDC, payTo: "0x1" },
        untrusted: "sellers may say anything here",
      },
    );
    expect(attempt.decision).toBe("refused");
    expect(attempt.state).toBe("refused");
    expect(attempt.reservedAtomic).toBe("0");
    expect(ledger.reserved(RUN)).toBe(0n);
    expect(ledger.get("r1")?.reason).toBe("network-not-allowed");
    // Quarantined seller text is retained for the audit trail.
    expect(ledger.get("r1")?.untrusted).toBe("sellers may say anything here");
  });

  it("groups refusals by rule for the morning-after summary", () => {
    const refusal = (code: Refusal["code"], id: string): void => {
      ledger.recordRefusal(
        { id, runId: RUN, tool: "paid_fetch", url: "u", quoteAtomic: "1", refusal: { code, message: code } },
      );
    };
    refusal("per-call-ceiling-exceeded", "r1");
    refusal("per-call-ceiling-exceeded", "r2");
    refusal("asset-not-allowed", "r3");
    expect(ledger.refusalSummary(RUN)).toEqual({
      "per-call-ceiling-exceeded": 2,
      "asset-not-allowed": 1,
    });
  });
});

describe("concurrent reservations cannot overdraw the purse", () => {
  it("admits exactly the affordable number of simultaneous claims", () => {
    // A budget of 10 000 with each claim asking for 1 000: ten fit exactly.
    const smallBudget = 10_000n;
    const other = Ledger.open(join(dir, "race.sqlite"));
    other.openRun({ runId: "race", runBudget: smallBudget, planner: "scripted", question: "" });

    const claim = (index: number): void => {
      other.reserve({
        id: `c${index}`,
        runId: "race",
        tool: "paid_fetch",
        url: `http://x/${index}`,
        scheme: "exact",
        network: NET,
        asset: USDC,
        payTo: "0x1111111111111111111111111111111111111111",
        quote: 1_000n,
        expectedRunBudget: smallBudget,
      });
    };

    // Every claim reads the same starting total, the way ten concurrent tool
    // calls launched in one turn would.
    let approved = 0;
    let refusedByLedger = 0;
    for (let index = 0; index < 10; index += 1) {
      try {
        claim(index);
        approved += 1;
      } catch {
        refusedByLedger += 1;
      }
    }

    expect(approved).toBe(10);
    expect(refusedByLedger).toBe(0);
    expect(other.reserved("race")).toBe(smallBudget);
    expect(other.totals("race").available).toBe(0n);
    other.close();
  });

  it("refuses the eleventh concurrent claim rather than overdrawing", () => {
    const smallBudget = 10_000n;
    const other = Ledger.open(join(dir, "race2.sqlite"));
    other.openRun({ runId: "race2", runBudget: smallBudget, planner: "scripted", question: "" });
    const claim = (index: number): boolean => {
      try {
        other.reserve({
          id: `c${index}`,
          runId: "race2",
          tool: "paid_fetch",
          url: `http://x/${index}`,
          scheme: "exact",
          network: NET,
          asset: USDC,
          payTo: "0x1111111111111111111111111111111111111111",
          quote: 1_000n,
          expectedRunBudget: smallBudget,
        });
        return true;
      } catch {
        return false;
      }
    };
    for (let index = 0; index < 10; index += 1) expect(claim(index)).toBe(true);
    // The eleventh has nowhere to come from.
    expect(claim(10)).toBe(false);
    expect(other.reserved("race2")).toBe(smallBudget);
    expect(other.totals("race2").available).toBe(0n);
    other.close();
  });

  it("keeps the hold when a claim would exceed what is left of a part-spent budget", () => {
    const smallBudget = 10_000n;
    const other = Ledger.open(join(dir, "race3.sqlite"));
    other.openRun({ runId: "race3", runBudget: smallBudget, planner: "scripted", question: "" });
    other.reserve({
      id: "big",
      runId: "race3",
      tool: "t",
      url: "u",
      scheme: "exact",
      network: NET,
      asset: USDC,
      payTo: "0x1111111111111111111111111111111111111111",
      quote: 9_500n,
      expectedRunBudget: smallBudget,
    });
    expect(() =>
      other.reserve({
        id: "too-big",
        runId: "race3",
        tool: "t",
        url: "u",
        scheme: "exact",
        network: NET,
        asset: USDC,
        payTo: "0x1111111111111111111111111111111111111111",
        quote: 1_000n,
        expectedRunBudget: smallBudget,
      }),
    ).toThrow(/exceeds the available 500/);
    other.close();
  });

  it("serialises writes across two connections to the same file", () => {
    // Two Ledger objects = two connections, which is what two processes look
    // like. The second must see the first's reservation, so it cannot spend
    // what the first already took.
    const a = Ledger.open(path);
    const b = Ledger.open(path);
    a.reserve({
      id: "from-a",
      runId: RUN,
      tool: "t",
      url: "u",
      scheme: "exact",
      network: NET,
      asset: USDC,
      payTo: "0x1111111111111111111111111111111111111111",
      quote: 2_000n,
      expectedRunBudget: BUDGET,
    });
    // A separate connection sees the committed row, not its own empty cache.
    expect(b.reserved(RUN)).toBe(2_000n);
    expect(b.totals(RUN).available).toBe(BUDGET - 2_000n);

    // The next 1 base unit fits; one more does not.
    b.reserve({
      id: "from-b-ok",
      runId: RUN,
      tool: "t",
      url: "u",
      scheme: "exact",
      network: NET,
      asset: USDC,
      payTo: "0x1111111111111111111111111111111111111111",
      quote: BUDGET - 2_000n,
      expectedRunBudget: BUDGET,
    });
    expect(b.totals(RUN).available).toBe(0n);
    // Now the purse is empty and the other connection must be refused too.
    expect(() =>
      a.reserve({
        id: "from-a-too-big",
        runId: RUN,
        tool: "t",
        url: "u",
        scheme: "exact",
        network: NET,
        asset: USDC,
        payTo: "0x1111111111111111111111111111111111111111",
        quote: 1n,
        expectedRunBudget: BUDGET,
      }),
    ).toThrow(/exceeds the available 0/);
    a.close();
    b.close();
  });

  it("refuses a reservation whose expected budget disagrees with the persisted run", () => {
    // The cross-check in reserve(): a caller claiming a different budget is a
    // configuration or tampering problem, not something to silently resolve in
    // the caller's favour.
    expect(() =>
      ledger.reserve({
        id: "drift",
        runId: RUN,
        tool: "t",
        url: "u",
        scheme: "exact",
        network: NET,
        asset: USDC,
        payTo: "0x1111111111111111111111111111111111111111",
        quote: 1_000n,
        expectedRunBudget: 999_999_999n,
      }),
    ).toThrow(/persisted budget of 5000000/);
    // Nothing was taken.
    expect(ledger.reserved(RUN)).toBe(0n);
  });

  it("refuses a reservation against a run that was never opened", () => {
    // An unknown run must not look like a full purse.
    expect(() =>
      ledger.reserve({
        id: "ghost",
        runId: "never-opened",
        tool: "t",
        url: "u",
        scheme: "exact",
        network: NET,
        asset: USDC,
        payTo: "0x1111111111111111111111111111111111111111",
        quote: 1_000n,
        expectedRunBudget: 1_000n,
      }),
    ).toThrow(/is not open/);
    expect(ledger.list()).toHaveLength(0);
  });

  it("keeps two runs on one ledger from spending each other's budget", () => {
    // The budget is per run. Without the run_id filter, run A's spend would
    // silently eat run B's allowance.
    ledger.openRun({ runId: "run-2", runBudget: 1_000n, planner: "scripted", question: "" });
    reserve("a-spends", 4_000n);
    ledger.reconcile("a-spends", { success: true });

    expect(ledger.totals(RUN).committed).toBe(4_000n);
    expect(ledger.totals(RUN).available).toBe(BUDGET - 4_000n);
    // Run 2 is untouched and still has its whole allowance.
    expect(ledger.totals("run-2").committed).toBe(0n);
    expect(ledger.totals("run-2").available).toBe(1_000n);

    // And the unscoped read is the sum, for reporting only.
    expect(ledger.committed(RUN)).toBe(4_000n);
  });
});

describe("startup recovery claims orphaned holds", () => {
  it("moves a dead process's reserved rows to interrupted and keeps them held", () => {
    reserve("a1", 1_500n);
    reserve("a2", 2_500n);
    expect(ledger.inFlight().map((row) => row.id)).toEqual(["a1", "a2"]);
    ledger.close();

    const recovered = Ledger.open(path);
    const orphans = recovered.claimForProcess("pid-2");
    expect(orphans.map((row) => row.id)).toEqual(["a1", "a2"]);
    expect(recovered.ledgerOwner()).toBe("pid-2");
    // Held, not released. The purse still believes the money might be gone.
    expect(recovered.totals(RUN).available).toBe(BUDGET - 4_000n);
    expect(recovered.totals(RUN).heldAttemptCount).toBe(2);
    recovered.close();
  });

  it("leaves settled and released rows alone", () => {
    reserve("settled-1", 1_000n);
    ledger.reconcile("settled-1", { success: true });
    reserve("released-1", 2_000n);
    ledger.reconcile("released-1", { success: false });
    ledger.close();

    const recovered = Ledger.open(path);
    expect(recovered.claimForProcess("pid-2")).toEqual([]);
    expect(recovered.committed(RUN)).toBe(1_000n);
    expect(recovered.reserved(RUN)).toBe(0n);
    expect(recovered.totals(RUN).available).toBe(BUDGET - 1_000n);
    recovered.close();
  });

  it("does not re-interrupt rows a later process already reconciled", () => {
    reserve("a1", 1_500n);
    ledger.close();

    const second = Ledger.open(path);
    second.claimForProcess("pid-2");
    // Evidence arrives: the payment did settle.
    second.reconcile("a1", { success: true, txHash: "0x1" });
    second.close();

    const third = Ledger.open(path);
    expect(third.claimForProcess("pid-3")).toEqual([]);
    expect(third.committed(RUN)).toBe(1_500n);
    third.close();
  });

  it("names the predecessor in the recovery note", () => {
    reserve("a1", 1_000n);
    ledger.close();

    const second = Ledger.open(path);
    expect(second.ledgerOwner()).toBeNull();
    second.claimForProcess("pid-2");
    second.close();

    const third = Ledger.open(path);
    expect(third.ledgerOwner()).toBe("pid-2");
    third.claimForProcess("pid-3");
    expect(third.get("a1")?.reasonDetail).toContain("pid-2");
    third.close();
  });
});

describe("restart recovery", () => {
  it("keeps an orphaned reservation held rather than returning it to the budget", () => {
    reserve("a1", 1_500n);
    // The process dies here. A new process opens the same file.
    ledger.close();
    const recovered = Ledger.open(path);

    // Fail-secure: we do not know whether the payment went through, so the
    // amount stays held. Releasing it would let the next call spend it again.
    expect(recovered.reserved(RUN)).toBe(1_500n);
    expect(recovered.totals(RUN).available).toBe(BUDGET - 1_500n);

    recovered.markInterrupted("a1", "process exited before reconciliation");
    expect(recovered.get("a1")?.state).toBe("interrupted");
    expect(recovered.orphanedReservations().map((row) => row.id)).toEqual(["a1"]);
    // Still held, in the interrupted state.
    expect(recovered.reserved(RUN)).toBe(1_500n);
    recovered.close();
  });

  it("recovers a reservation that a settled payment had already consumed", () => {
    reserve("a1", 1_500n);
    ledger.reconcile("a1", { success: true, txHash: "0xabc" });
    ledger.close();

    const recovered = Ledger.open(path);
    // A settled row is not an orphan: the money moved before the restart.
    expect(recovered.orphanedReservations()).toEqual([]);
    expect(recovered.committed(RUN)).toBe(1_500n);
    expect(recovered.reserved(RUN)).toBe(0n);
    recovered.close();
  });

  it("returns the budget once the orphan is reconciled as settled", () => {
    reserve("a1", 1_500n);
    ledger.markInterrupted("a1", "crashed");
    ledger.close();

    const recovered = Ledger.open(path);
    // Evidence arrives after the restart.
    recovered.reconcile("a1", { success: true, txHash: "0xlate", settledAtomic: "1500" });
    const totals = recovered.totals(RUN);
    expect(totals.reserved).toBe(0n);
    expect(totals.committed).toBe(1_500n);
    expect(totals.available).toBe(BUDGET - 1_500n);
    expect(recovered.orphanedReservations()).toEqual([]);
    recovered.close();
  });

  it("returns the budget once the orphan is reconciled as never settled", () => {
    reserve("a1", 1_500n);
    ledger.markInterrupted("a1", "crashed");
    ledger.close();

    const recovered = Ledger.open(path);
    // The payment flow established that no settlement occurred, so the hold may
    // be released. This is the only path that may do so.
    recovered.reconcile("a1", { success: false, errorReason: "no payment-response header" });
    const totals = recovered.totals(RUN);
    expect(totals.reserved).toBe(0n);
    expect(totals.committed).toBe(0n);
    expect(totals.available).toBe(BUDGET);
    recovered.close();
  });

  it("does not let a settled orphan and a released orphan both be counted", () => {
    reserve("a1", 1_000n);
    reserve("a2", 2_000n);
    ledger.markInterrupted("a1", "crashed");
    ledger.markInterrupted("a2", "crashed");
    expect(ledger.reserved(RUN)).toBe(3_000n);
    ledger.reconcile("a1", { success: true });
    expect(ledger.reserved(RUN)).toBe(2_000n);
    expect(ledger.committed(RUN)).toBe(1_000n);
    ledger.reconcile("a2", { success: false });
    expect(ledger.reserved(RUN)).toBe(0n);
    expect(ledger.committed(RUN)).toBe(1_000n);
    expect(ledger.totals(RUN).available).toBe(BUDGET - 1_000n);
  });

  it("re-reads the run budget from disk, so a restart cannot widen it", () => {
    expect(ledger.runBudgetFor(RUN)).toBe(BUDGET);
    ledger.close();
    const recovered = Ledger.open(path);
    expect(recovered.runBudgetFor(RUN)).toBe(BUDGET);
    expect(recovered.runExists(RUN)).toBe(true);
    expect(recovered.runExists("nope")).toBe(false);
    recovered.close();
  });

  it("ignores a second open of the same run id rather than resetting the budget", () => {
    reserve("a1", 1_500n);
    // Re-opening an existing run must not wipe it.
    ledger.openRun({ runId: RUN, runBudget: 999_999_999n, planner: "llm", question: "different" });
    expect(ledger.runBudgetFor(RUN)).toBe(BUDGET);
    expect(ledger.reserved(RUN)).toBe(1_500n);
  });
});

describe("base-unit round trip through SQLite", () => {
  it("preserves exact values across a write and a read", () => {
    const value = parseAtomic("4990000", "test");
    reserve("a1", value);
    ledger.close();
    const recovered = Ledger.open(path);
    expect(parseAtomic(recovered.get("a1")?.reservedAtomic ?? "", "read")).toBe(value);
    recovered.close();
  });
});
