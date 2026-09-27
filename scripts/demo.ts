/**
 * `npm run demo` — the whole thing, end to end, in one command.
 *
 * Starts the two local test sellers, runs the agent against them through the real
 * `runAgent` → `ToolDispatcher` → `SigningGate` → HTTP path, writes
 * `record/decision-log.json`, prints a summary, and serves the read-only UI so the
 * run can be inspected in a browser.
 *
 * ## No credentials, no funds, no network
 *
 * The scripted planner needs no model key, and the signer and facilitator are
 * stubs, so this runs offline on a fresh clone. The seller hosts are pinned to
 * the two ports just bound, so the run cannot reach anything else on the machine.
 *
 * ## Shutting down
 *
 * Ctrl-C, or SIGTERM/SIGINT from a script, closes the UI server, the ledger and
 * both sellers, then exits 0. A signal handler that only tears down half of it is
 * how a demo leaves a port bound and the next run fails for the wrong reason, so
 * teardown is a single function used by both the handler and the normal path.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRunRecord } from "../src/app/record.js";
import { DEMO_QUESTION, startPurseRuntime, type PurseRuntime, type RunEvent } from "../src/app/runtime.js";
import { startUiServer, writeRecord } from "../src/ui/server.js";
import { loadConfig } from "../src/config/env.js";
import { formatUsd } from "../src/money/amount.js";
import { BURNER_FREE_ITERATIONS } from "../src/seller/rogue.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..");
const RECORD_PATH = join(PROJECT_ROOT, "record", "decision-log.json");

/** `--headless` skips the UI and exits after the record, for CI. */
const headless = process.argv.includes("--headless");

async function main(): Promise<void> {
  const config = loadConfig();
  // The demo gets its own ledger so it never inherits spend from a previous run
  // and never overwrites one: `openRun` would refuse a run id that already exists
  // with a different budget, and silently sharing a budget would be dishonest.
  const ledgerPath = join(PROJECT_ROOT, "data", "demo.sqlite");
  await mkdir(dirname(ledgerPath), { recursive: true });
  await resetLedger(ledgerPath);

  line("Khata demo");
  line("=".repeat(60));
  line(`question   ${DEMO_QUESTION}`);
  line(
    `policy     ${formatUsd(config.policy.limits.perCallCeiling)} per call, ` +
      `${formatUsd(config.policy.limits.runBudget)} per run`,
  );
  line(`planner    ${config.planner} (no model key needed)`);
  line("settlement local stub: no chain is touched and no real funds move");
  line("");

  const runtime = await startPurseRuntime({ config, ledgerPath });
  const events: RunEvent[] = [];

  try {
    line(`honest stall  ${runtime.honest.url}`);
    line(`rogue stall   ${runtime.rogue.url}`);
    line(`seller pins   ${runtime.allowlist.entries.join(", ")}`);
    line(
      `transport guard ${runtime.transportGuardEngaged ? "ENGAGED" : "stood down"} ` +
        `(ports pinned: ${runtime.allowlist.pinsPorts})`,
    );
    if (runtime.orphanedHolds.length > 0) {
      line(`orphaned holds from a previous process: ${runtime.orphanedHolds.length} (still held, not released)`);
    }
    line("");

    const report = await runtime.run({
      onEvent: (event) => {
        events.push(event);
        line(formatCall(event));
      },
    });

    const record = buildRunRecord({ runtime, report, events });
    await writeRecord(RECORD_PATH, record);

    line("");
    line("Summary");
    line("-".repeat(60));
    line(`run id       ${report.runId}`);
    line(`turns        ${report.turns} (truncated: ${report.truncated})`);
    line(
      `committed    ${formatUsd(report.spentAtomic)} of ${formatUsd(config.policy.limits.runBudget)} ` +
        "(local stub)",
    );
    const totals = runtime.ledger.totals(runtime.runId);
    line(`held         ${formatUsd(totals.reserved)} across ${totals.heldAttemptCount} unresolved call(s)`);
    line(`signatures   ${runtime.signer.callCount}`);
    line(`refusals     ${summariseRefusals(runtime.ledger.refusalSummary(runtime.runId))}`);
    line(`burner cap   ${BURNER_FREE_ITERATIONS} free iterations, then it charges`);
    line(`record       ${relative(RECORD_PATH)}`);
    line("");
    printBySettlement(record);

    if (headless) {
      line("");
      line("Headless mode: not starting the UI.");
      return;
    }

    const ui = await startUiServer({
      createRuntime: () => startPurseRuntime({ config, ledgerPath: join(PROJECT_ROOT, "data", "demo-ui.sqlite") }),
      recordPath: RECORD_PATH,
    });

    line("");
    line(`UI           ${ui.url}`);
    line("             read-only: the policy above cannot be changed from the page or the API");
    line("Press Ctrl-C to stop.");

    await waitForSignal();
    line("");
    line("Shutting down…");
    await ui.close();
  } finally {
    await runtime.close();
  }
}

/** One line per call, in plain words. The UI shows the same events. */
function formatCall(event: RunEvent): string {
  const { result } = event;
  const label = result.label ?? result.callId;

  if (result.kind === "refused") {
    return `  ${pad(String(event.index + 1))} ${pad(label, 30)} REFUSED before the gate (${result.code})`;
  }
  switch (result.outcome.kind) {
    case "paid":
      return (
        `  ${pad(String(event.index + 1))} ${pad(label, 30)} settled-stub ${formatUsd(result.outcome.settledAtomic)}` +
        `  [gate said "paid"; committed ${formatUsd(event.spentAfter)}]`
      );
    case "free":
      return `  ${pad(String(event.index + 1))} ${pad(label, 30)} free (no payment requested)`;
    case "refused":
      return `  ${pad(String(event.index + 1))} ${pad(label, 30)} not-paid (${result.outcome.refusal.code})`;
    case "interrupted":
      return (
        `  ${pad(String(event.index + 1))} ${pad(label, 30)} budget-held ` +
        `${formatUsd(result.outcome.heldAtomic)} (${result.outcome.reason})`
      );
  }
}

function printBySettlement(record: ReturnType<typeof buildRunRecord>): void {
  line("settlement labels in the record");
  line("-".repeat(60));
  for (const [status, count] of Object.entries(record.totals.bySettlement)) {
    line(`  ${pad(status, 16)} ${count}`);
  }
  line("");
  line(`  chainTouched:   ${record.settlement.chainTouched}`);
  line(`  realFundsMoved: ${record.settlement.realFundsMoved}`);
}

function summariseRefusals(summary: Record<string, number>): string {
  const entries = Object.entries(summary);
  if (entries.length === 0) return "none";
  return entries.map(([code, n]) => `${code}×${n}`).join(", ");
}

function pad(value: string, width = 4): string {
  return value.length >= width ? `${value} ` : value + " ".repeat(width - value.length);
}

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function relative(path: string): string {
  return path.startsWith(PROJECT_ROOT) ? path.slice(PROJECT_ROOT.length + 1) : path;
}

/** Start the demo's ledger from empty, so every run tells the same story. */
async function resetLedger(path: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  for (const suffix of ["", "-wal", "-shm"]) {
    await rm(`${path}${suffix}`, { force: true });
  }
}

function waitForSignal(): Promise<void> {
  return new Promise((resolveSignal) => {
    const onSignal = (): void => resolveSignal();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
  });
}

main()
  .then(() => {
    // Everything is closed inside `main`'s finally; exiting explicitly avoids
    // waiting on a handle the sellers or the ledger left registered.
    process.exit(0);
  })
  .catch((error: unknown) => {
    process.stderr.write(`\ndemo failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
