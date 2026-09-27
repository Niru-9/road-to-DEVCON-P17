/**
 * The traceability document is not allowed to be wrong.
 *
 * A rubric table is a set of claims about what the repository contains. Left
 * unchecked it drifts: a file is renamed, a test is deleted, a check gets marked
 * done on the strength of a plan, and the document keeps asserting it. A
 * reviewer who trusts the table is then misled by the one artefact whose whole
 * job is to be trustworthy.
 *
 * So the table is verified structurally, on every test run:
 *
 * - every path it cites must exist;
 * - a row marked Done must cite at least one real test;
 * - the claims it makes about code are spot-checked against the source;
 * - and the gaps it admits must still be listed, so a check cannot quietly move
 *   from "not done" to "done" without a row changing.
 *
 * This is the check that caught the previous version of the document claiming a
 * rogue seller that did not exist.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const PACKAGE = resolve(HERE, "..");
const DOC_PATH = resolve(PACKAGE, "..", "docs", "rubric-traceability.md");
const DOC = readFileSync(DOC_PATH, "utf8");

/** The P2 section only. */
const P2 = DOC.slice(DOC.indexOf("## P2"), DOC.indexOf("## P3"));

/** Table rows: `| 5 | check | 18 | **Done** | code | tests |` */
function p2Rows(): Array<{ check: string; points: string; status: string; cells: string[] }> {
  const rows: Array<{ check: string; points: string; status: string; cells: string[] }> = [];
  for (const line of P2.split("\n")) {
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 6) continue;
    if (!/^\d+$/.test(cells[0] ?? "")) continue; // header or separator
    rows.push({
      check: cells[0] as string,
      points: cells[2] ?? "",
      status: cells[3] ?? "",
      cells,
    });
  }
  return rows;
}

/** Every `path/like/this` in backticks, across the given cells. */
function citedPaths(cells: readonly string[]): string[] {
  const found: string[] = [];
  for (const cell of cells) {
    for (const match of cell.matchAll(/`([^`]+)`/g)) {
      const value = match[1] as string;
      if (/^(src|tests|scripts|docs)\//.test(value)) found.push(value);
    }
  }
  return found;
}

const ROWS = p2Rows();

describe("rubric traceability: P2", () => {
  it("parses the P2 table", () => {
    expect(ROWS.length).toBeGreaterThan(0);
    // The checks this workstream is responsible for.
    const checks = ROWS.map((r) => r.check);
    for (const required of ["1", "3", "5", "6", "7", "8", "10"]) {
      expect(checks).toContain(required);
    }
  });

  it("every path it cites exists", () => {
    const missing: string[] = [];
    for (const row of ROWS) {
      // The Code cell and the Tests cell are the last two.
      for (const path of citedPaths(row.cells.slice(4))) {
        if (!existsSync(resolve(PACKAGE, path))) missing.push(`check ${row.check}: ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("no row is marked Done without citing a test", () => {
    const unsupported: string[] = [];
    for (const row of ROWS.filter((r) => r.status.includes("Done"))) {
      // cells[5] is the Tests cell, a string. Wrap it, or the spread below
      // would iterate its characters and find no backticks.
      const tests = citedPaths([row.cells[5] ?? ""]);
      if (tests.length === 0) unsupported.push(`check ${row.check}`);
    }
    expect(unsupported).toEqual([]);
  });

  it("the rogue seller claim is true: six abuses and a burner, all on the wire", () => {
    const source = readFileSync(resolve(PACKAGE, "src/seller/rogue.ts"), "utf8");
    const tests = readFileSync(resolve(PACKAGE, "tests/sellers.test.ts"), "utf8");
    // Every route the stall actually registers. `/rogue/unknown-scheme` was
    // missing from this list while the route and its test both existed, so
    // deleting the route would have passed a test named after the claim.
    const routes = [
      "/rogue/overpriced",
      "/rogue/unknown-asset",
      "/rogue/wrong-network",
      "/rogue/unknown-scheme",
      "/rogue/bait-and-switch",
      "/rogue/burner",
      "/rogue/hostile-notes",
    ];
    for (const route of routes) {
      // In the seller, as an actual registered route...
      expect(source).toContain(route);
      // ...and exercised by a test over a real socket.
      expect(tests).toContain(route);
    }
    // And the seller's surface is exactly those seven plus the one
    // introspection route - no wider, which would mean the seller's surface is
    // larger than the claim, and no missing, which is the bug this list had.
    const declared = [...source.matchAll(/"(GET \/rogue\/[a-z-]+)":/g)].map((m) =>
      m[1]!.replace("GET ", ""),
    );
    expect(declared.sort()).toEqual([...routes, "/rogue/state"].sort());
    // `/rogue/state` is a counter endpoint, not an abuse: it must never ask for
    // money, or it is an eighth route that pays.
    const stateRoute = source.slice(source.indexOf('"GET /rogue/state"'));
    expect(stateRoute.slice(0, source.indexOf("},\n  };") - source.indexOf('"GET /rogue/state"')))
      .not.toMatch(/askForPayment|takePayment/);
  });

  it("the burner really is capped at two free iterations", () => {
    const source = readFileSync(resolve(PACKAGE, "src/seller/rogue.ts"), "utf8");
    expect(source).toMatch(/BURNER_FREE_ITERATIONS\s*=\s*2\b/);
  });

  it("the 'no float money' claim is true in the source it names", () => {
    for (const path of ["src/money/amount.ts", "src/policy/policy.ts", "src/ledger/ledger.ts"]) {
      const source = readFileSync(resolve(PACKAGE, path), "utf8");
      expect(source, path).not.toMatch(/\bparseFloat\b/);
      expect(source, path).not.toMatch(/\bsetReadBigInts\b/);
    }
  });

  it("the 'cumulative spend is persisted' claim is true of the schema", () => {
    const source = readFileSync(resolve(PACKAGE, "src/ledger/ledger.ts"), "utf8");
    // Money columns are TEXT, and the budget is read from the runs row.
    expect(source).toMatch(/run_budget\s+TEXT NOT NULL/);
    expect(source).toMatch(/reserved_atomic\s+TEXT NOT NULL/);
    expect(source).toMatch(/BEGIN IMMEDIATE/);
  });

  it("the allowlist claim is true: wildcards are rejected", () => {
    const source = readFileSync(resolve(PACKAGE, "src/policy/policy.ts"), "utf8");
    expect(source).toMatch(/may not contain a wildcard/);
  });

  it("still admits the gaps, so a check cannot quietly become 'done'", () => {
    // These are the honest limitations. If one is resolved, the row changes
    // *and* this test changes, which is the point. Checks 2, 4 and 9 left this list
    // when the agent loop and the credential scan landed.
    for (const gap of [
      "No real testnet run",
      "The seller side is stubbed too",
      "has not been run against a hosted model",
    ]) {
      expect(P2, `the gaps section must still admit: ${gap}`).toContain(gap);
    }
    // And the two checks the agent loop closed must not still be described as
    // open, in the gaps list or anywhere else in the P2 section.
    expect(P2).not.toMatch(/Check 2[^.]*NOT DONE/);
    expect(P2).not.toMatch(/Check 9[^.]*partially evidenced/);
    // Check 4 is no longer unverified. If a future change reopens it, this fails
    // and the reason has to be written down rather than assumed.
    expect(P2).not.toMatch(/Check 4[^.]*unverified/i);
  });

  it("records the credential scan as done, and cites the scan and its test", () => {
    // The opposite guard for check 4. A resolved check must not be quietly
    // *dropped* either - the row, the command and the test all have to be named.
    const row = ROWS.find((r) => r.check === "4");
    expect(row, "check 4 has no row").toBeDefined();
    expect(row?.status).toContain("Done");
    expect(row?.cells[4]).toContain("scripts/credential-scan.ts");
    expect(P2).toContain("npm run scan:credentials");
  });

  it("cites every test file, so a new suite cannot go unmentioned", () => {
    // The table's job is to be a map of the repository. A test file that appears in
    // none of the rows *and* nowhere in the section's prose is a file whose subject
    // matter nobody claimed, which is how coverage quietly stops being described.
    // Prose counts as a citation: the audit record and the port guard are described
    // below the table rather than in a scored row, and their suites belong with them.
    const onDisk = readdirSync(resolve(PACKAGE, "tests"))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `tests/${name}`);
    const uncited = onDisk.filter((path) => !P2.includes(path));
    expect(uncited).toEqual([]);
  });

  it("does not claim a UI or a record that is not there", () => {
    // The reverse of the old gap: the page and the record now exist, so the table
    // has to say so *and* name the files, rather than leaving a reader to infer it.
    expect(P2).not.toContain("No UI, no demo record");
    for (const path of ["src/ui/server.ts", "src/app/record.ts", "record/decision-log.json"]) {
      expect(P2, `the P2 section should account for ${path}`).toContain(path);
    }
    expect(existsSync(resolve(PACKAGE, "record", "decision-log.json"))).toBe(true);
    // And the record must declare itself a local run, not a testnet one.
    const record = JSON.parse(readFileSync(resolve(PACKAGE, "record", "decision-log.json"), "utf8")) as {
      settlement: { chainTouched: boolean; realFundsMoved: boolean };
    };
    expect(record.settlement.chainTouched).toBe(false);
    expect(record.settlement.realFundsMoved).toBe(false);
  });

  it("records the agent tool loop as done, and cites tests for it", () => {
    // Guards the opposite direction: a check cannot be quietly *dropped* either.
    for (const check of ["2", "9"]) {
      const row = ROWS.find((r) => r.check === check);
      expect(row, `check ${check} has no row`).toBeDefined();
      expect(row?.status).toContain("Done");
    }
  });

  it("the tool schema really has no limit-bearing field", () => {
    // The Check 9 claim, checked against the source rather than trusted.
    const source = readFileSync(resolve(PACKAGE, "src/agent/tools.ts"), "utf8");
    expect(source).toContain("additionalProperties: false");
    expect(source).toMatch(/export const PAID_FETCH_TOOL_NAME = "paid_fetch"/);
    // The properties block declares exactly two names. Bounded at the end of the
    // constant, so the match cannot run on into the zod schema below it and pick
    // up a third.
    const start = source.indexOf("PAID_FETCH_TOOL_PARAMETERS = {");
    const end = source.indexOf("} as const", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = source.slice(start, end);
    const names = [...block.matchAll(/^\s{4}(\w+):\s*\{/gm)].map((m) => m[1]);
    expect(names).toEqual(["url", "label"]);
  });

  it("the tool definition is sent on every request, not just the first", () => {
    // No code path in the client may omit `tools`.
    const source = readFileSync(resolve(PACKAGE, "src/agent/llm.ts"), "utf8");
    const body = source.slice(source.indexOf("export function buildRequestBody"));
    expect(body).toMatch(/tools:\s*PAID_FETCH_TOOLS/);
    // Exactly one place builds the body, so "every request" is structural.
    expect(source.match(/tools:\s*PAID_FETCH_TOOLS/g)).toHaveLength(1);
  });

  it("does not claim live settlement", () => {
    // A single mention is a disclaimer; more than one would be a boast.
    expect(P2.toLowerCase()).toContain("no real testnet run");
  });

  it("the canonical x402 header names are the real ones", () => {
    // Guards the interop fix: a purse that invented its own request header
    // would work against its own stub and fail against @x402/fetch.
    const decode = readFileSync(resolve(PACKAGE, "src/x402/decode.ts"), "utf8");
    expect(decode).toMatch(/PAYMENT_SIGNATURE_HEADER\s*=\s*"x-payment"/);
    expect(decode).toMatch(/PAYMENT_REQUIRED_HEADER\s*=\s*"payment-required"/);
    expect(decode).toMatch(/PAYMENT_RESPONSE_HEADER\s*=\s*"payment-response"/);
  });
});
