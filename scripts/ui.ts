/**
 * `npm run ui` — the read-only UI on its own, without running the demo first.
 *
 * Useful when you want to re-run from the browser, or to read a record that
 * `npm run demo` already wrote. The page cannot change any policy; see
 * `src/ui/server.ts`.
 *
 *   npm run ui              # OS picks a free port
 *   npm run ui -- --port 5173
 *
 * Ctrl-C shuts the server down.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startPurseRuntime } from "../src/app/runtime.js";
import { startUiServer } from "../src/ui/server.js";
import { loadConfig } from "../src/config/env.js";
import { formatUsd } from "../src/money/amount.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RECORD_PATH = join(PROJECT_ROOT, "record", "decision-log.json");

/** `--port 5173`, or undefined to let the OS choose. */
function readPort(argv: readonly string[]): number | undefined {
  const flag = argv.indexOf("--port");
  if (flag === -1) return undefined;
  const value = Number(argv[flag + 1]);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`--port needs a number between 0 and 65535, got ${String(argv[flag + 1])}`);
  }
  return value;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const port = readPort(process.argv.slice(2));
  const ui = await startUiServer({
    // A fresh ledger per browser-initiated run, so two runs never share a budget.
    createRuntime: () => startPurseRuntime({ config, ledgerPath: join(PROJECT_ROOT, "data", "demo-ui.sqlite") }),
    recordPath: RECORD_PATH,
    // Spread rather than `port: readPort(...)`: under `exactOptionalPropertyTypes`
    // an explicit `undefined` is not the same as an absent key.
    ...(port === undefined ? {} : { port }),
  });

  process.stdout.write(`Khata UI      ${ui.url}\n`);
  process.stdout.write(`policy        ${formatUsd(config.policy.limits.perCallCeiling)} per call, `);
  process.stdout.write(`${formatUsd(config.policy.limits.runBudget)} per run (read-only)\n`);
  process.stdout.write("settlement    local stub: no chain is touched and no real funds move\n");
  process.stdout.write("record        record/decision-log.json\n");
  process.stdout.write("Press Ctrl-C to stop.\n");

  await new Promise<void>((resolveSignal) => {
    process.once("SIGINT", () => resolveSignal());
    process.once("SIGTERM", () => resolveSignal());
  });
  await ui.close();
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    process.stderr.write(`ui failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
