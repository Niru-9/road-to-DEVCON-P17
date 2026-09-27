/**
 * Regression: a second run over the same file, and a reopened runtime.
 *
 * ## The failure this exists for
 *
 * Clicking "Run the demo" twice failed with:
 *
 *     UNIQUE constraint failed: attempts.id
 *
 * `attempts.id` is a global `TEXT PRIMARY KEY`, but ids used to be minted from a
 * counter held in `startPurseRuntime`'s closure. The UI builds a fresh runtime
 * per click, so the second runtime started again at `paid_fetch-1` and collided
 * with the first run's rows. Because the collision lands on the very first
 * insert, the run died before emitting a single event.
 *
 * A second defect rode along: `closeRun` sat on the success path inside `run()`,
 * so every failed run left its `runs` row with `ended_at IS NULL` forever, which
 * is indistinguishable from a run still in progress.
 *
 * ## What is asserted
 *
 * The sequence a user actually performs, against one file-backed ledger:
 * run, run again, then close everything and reopen from disk and run a third
 * time. Audit history from the earlier runs must survive all of it.
 *
 * The ledger used here is a temp file, and the seeded ids are written the way the
 * old build wrote them - directly, with no sequence table - so the seeding path
 * is exercised rather than assumed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Ledger } from "../src/ledger/ledger.js";
import { startPurseRuntime } from "../src/app/runtime.js";
import { loadConfig } from "../src/config/env.js";
import { startUiServer } from "../src/ui/server.js";

const config = loadConfig();

let dir: string;
let ledgerPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "p2-attempt-ids-"));
  ledgerPath = join(dir, "purse.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A planner that throws on its first turn, the way the id collision did. */
function throwingPlanner(message: string) {
  return {
    kind: "scripted" as const,
    description: "test planner that throws",
    next: async (): Promise<never> => {
      throw new Error(message);
    },
  };
}

/** Run the real scripted plan to completion, returning the settled attempt ids. */
async function runOnce(label: string): Promise<{ ids: string[]; runId: string }> {
  const runtime = await startPurseRuntime({ config, ledgerPath });
  try {
    const seen: string[] = [];
    await runtime.run({
      onEvent: (event) => {
        // Only a call that reached the gate has a ledger row and an attempt id;
        // a call refused on its arguments never got one.
        if (event.result.kind !== "settled") return;
        seen.push(event.result.outcome.attemptId);
      },
    });
    return { ids: seen, runId: runtime.runId };
  } finally {
    await runtime.close();
  }
}

describe("attempt ids are unique across repeated runs on one file", () => {
  it("gives a second run on the same ledger fresh ids instead of colliding", async () => {
    const first = await runOnce("first");
    const second = await runOnce("second");

    // Both runs produced a full set of attempts.
    expect(first.ids).toHaveLength(10);
    expect(second.ids).toHaveLength(10);

    // No id is reused across the two runs. This is the exact assertion whose
    // absence let `UNIQUE constraint failed: attempts.id` through.
    const overlap = first.ids.filter((id) => second.ids.includes(id));
    expect(overlap, "attempt ids must not repeat across runs").toEqual([]);

    // And both runs are on disk, not just in memory.
    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    const rows = db.prepare("SELECT id FROM attempts").all() as { id: string }[];
    const runs = db.prepare("SELECT run_id FROM runs").all() as { run_id: string }[];
    db.close();
    expect(rows).toHaveLength(20);
    expect(runs).toHaveLength(2);
    expect(new Set(rows.map((r) => r.id)).size).toBe(20);
  });

  it("keeps counting after the runtime is closed and reopened from disk", async () => {
    await runOnce("first");
    await runOnce("second");
    // `runOnce` closes its runtime, so this is a genuine reopen: a brand new
    // Ledger over the same file, with no in-process state carried across.
    const third = await runOnce("third");

    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    const rows = db.prepare("SELECT id FROM attempts ORDER BY ts, id").all() as { id: string }[];
    db.close();

    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((r) => r.id)).size).toBe(30);
    expect(third.ids).toHaveLength(10);
    // Numbering continued rather than restarting.
    expect(third.ids[0]).not.toBe("paid_fetch-1");
  });
});

describe("seeding an existing ledger", () => {
  it("continues past ids already on disk instead of re-issuing them", async () => {
    // Reproduce the state the manual run left behind: attempts written by the
    // old in-memory allocator, with no `attempt_sequence` table at all.
    const legacy = new DatabaseSync(ledgerPath);
    legacy.exec(`CREATE TABLE attempts (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, ts TEXT NOT NULL, tool TEXT NOT NULL,
      url TEXT NOT NULL, scheme TEXT, network TEXT, asset TEXT, pay_to TEXT,
      quote_atomic TEXT NOT NULL, decision TEXT NOT NULL, reason TEXT, reason_detail TEXT,
      state TEXT NOT NULL, reserved_atomic TEXT NOT NULL, settled_atomic TEXT, tx_hash TEXT,
      committed_before TEXT NOT NULL, reserved_before TEXT NOT NULL, available_before TEXT NOT NULL,
      untrusted TEXT)`);
    const insert = legacy.prepare(
      `INSERT INTO attempts (id, run_id, ts, tool, url, quote_atomic, decision, state,
        reserved_atomic, committed_before, reserved_before, available_before)
       VALUES (?, 'run-legacy', '2026-01-01T00:00:00.000Z', 'paid_fetch', 'http://127.0.0.1:1/x',
        '500', 'approved', 'settled', '500', '0', '0', '5000000')`,
    );
    for (let i = 1; i <= 10; i += 1) insert.run(`paid_fetch-${i}`);
    legacy.close();

    const run = await runOnce("after-legacy");

    // The new run's first id is 11, not 1. This is the seeding path, and it is
    // what makes the fix deployable onto a ledger that already has history.
    expect(run.ids[0]).toBe("paid_fetch-11");

    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    const rows = db.prepare("SELECT id FROM attempts").all() as { id: string }[];
    db.close();
    // The ten legacy rows are still there. Nothing was deleted or rewritten.
    expect(rows).toHaveLength(20);
    for (let i = 1; i <= 10; i += 1) {
      expect(rows.map((r) => r.id)).toContain(`paid_fetch-${i}`);
    }
  });

  it("does not walk the sequence backwards when reopened", async () => {
    await runOnce("first");
    // Advance the durable sequence past the ten ids the run wrote, then drop the
    // handle entirely - a genuine reopen with no in-process state.
    const first = Ledger.open(ledgerPath);
    expect(first.mintAttemptId("paid_fetch")).toBe("paid_fetch-11");
    expect(first.mintAttemptId("paid_fetch")).toBe("paid_fetch-12");
    first.close();

    // Re-seeding from the rows on disk must not lower the sequence it just left
    // at 12, or a reopen would start handing out ids that are already taken.
    const second = Ledger.open(ledgerPath);
    const next = second.mintAttemptId("paid_fetch");
    second.close();
    expect(next).toBe("paid_fetch-13");
  });
});

describe("a failed run is closed, not left open", () => {
  it("sets ended_at even when the run throws", async () => {
    const runtime = await startPurseRuntime({ config, ledgerPath });
    const runId = runtime.runId;
    Object.assign(runtime, { buildPlanner: () => throwingPlanner("boom") });
    await expect(runtime.run({ maxTurns: 1, onEvent: () => undefined })).rejects.toThrow("boom");
    await runtime.close();

    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    const row = db.prepare("SELECT ended_at FROM runs WHERE run_id = ?").get(runId) as
      | { ended_at: string | null }
      | undefined;
    db.close();

    // The point of the fix: an abandoned run is closed, so it cannot be mistaken
    // for one still in progress.
    expect(row).toBeDefined();
    expect(row?.ended_at, "a failed run must not stay open").not.toBeNull();
  });

  it("leaves no open run rows behind after a failed run", async () => {
    await runOnce("good");
    // Drive the UI path, which is where the collision actually surfaced.
    const ui = await startUiServer({
      createRuntime: async () => {
        const runtime = await startPurseRuntime({ config, ledgerPath });
        // Force a failure inside the run by pointing the planner at a throw.
        Object.assign(runtime, { buildPlanner: () => throwingPlanner("boom") });
        return runtime;
      },
      recordPath: join(dir, "record.json"),
    });
    const res = await fetch(new URL("/api/run", ui.url), { method: "POST" });
    const body = await res.text();
    await ui.close();

    expect(body).toContain("event: error");

    const db = new DatabaseSync(ledgerPath, { readOnly: true });
    const open = db.prepare("SELECT COUNT(*) AS n FROM runs WHERE ended_at IS NULL").get() as { n: number };
    const total = db.prepare("SELECT COUNT(*) AS n FROM runs").get() as { n: number };
    db.close();

    expect(total.n).toBe(2);
    expect(open.n, "no run may be left open").toBe(0);
  });
});

describe("UI HTTP semantics", () => {
  async function serve() {
    const ui = await startUiServer({
      createRuntime: () => startPurseRuntime({ config, ledgerPath }),
      recordPath: join(dir, "record.json"),
    });
    return ui;
  }

  it("answers the browser's favicon probe without a console error", async () => {
    const ui = await serve();
    const res = await fetch(new URL("/favicon.ico", ui.url));
    await ui.close();
    // 204, not 405. A 405 on a path that does not exist was a false claim, and it
    // was the only thing in the console during a failing run - which is how a real
    // failure stayed hidden.
    expect(res.status).toBe(204);
  });

  it("404s a path that does not exist and 405s a real route with the wrong method", async () => {
    const ui = await serve();

    const missing = await fetch(new URL("/api/limits", ui.url), {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(missing.status).toBe(404);

    const wrongMethod = await fetch(new URL("/api/run", ui.url), { method: "PATCH" });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toContain("POST");

    await ui.close();
  });

  it("still refuses every policy write", async () => {
    const ui = await serve();
    for (const [method, path] of [
      ["PUT", "/api/policy"],
      ["POST", "/api/policy"],
      ["PATCH", "/api/run"],
      ["DELETE", "/api/record"],
      ["POST", "/api/limits"],
    ] as const) {
      const res = await fetch(new URL(path, ui.url), {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ perCallCeiling: "999999999", runBudget: "999999999999" }),
      });
      // Refused either way. The status is now accurate rather than uniform, so
      // this asserts the property rather than a number.
      expect([404, 405], `${method} ${path} must be refused`).toContain(res.status);
    }
    await ui.close();
  });

  it("names the run and the ledger when a run fails", async () => {
    const ui = await startUiServer({
      createRuntime: async () => {
        const runtime = await startPurseRuntime({ config, ledgerPath });
        Object.assign(runtime, { buildPlanner: () => throwingPlanner("UNIQUE constraint failed: attempts.id") });
        return runtime;
      },
      recordPath: join(dir, "record.json"),
    });
    const res = await fetch(new URL("/api/run", ui.url), { method: "POST" });
    const body = await res.text();
    await ui.close();

    // A bare SQLite string is not something a reader can act on.
    const frame = body.split("\n\n").find((f) => f.includes("event: error"));
    expect(frame).toBeDefined();
    const data = JSON.parse((frame as string).split("\n").find((l) => l.startsWith("data:"))!.slice(5));
    expect(data.runId).toMatch(/^run-/);
    expect(data.ledgerPath).toContain("purse.sqlite");
    expect(data.detail).toMatch(/attempt id/i);
  });
});
