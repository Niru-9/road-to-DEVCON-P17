/**
 * What the record and the runtime promise, and what would break them.
 *
 * The record's whole job is to be *believable and true*. That makes it an odd
 * thing to test in the usual way: the dangerous failure is not a crash, it is a
 * document that reads plausibly while overstating what happened. So most of
 * these tests are about the absence of a claim.
 *
 * The runtime tests cover the wiring claims: the demo pins ports, the transport
 * guard engages, and the policy cannot be moved from outside.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { startPurseRuntime, scriptedPlan, DEMO_MAX_TURNS, portOf, type PurseRuntime, type RunEvent } from "../src/app/runtime.js";
import { buildRunRecord, serialiseRecord, type RunRecord } from "../src/app/record.js";
import { loadConfig } from "../src/config/env.js";
import { startUiServer, type UiServer } from "../src/ui/server.js";
import { BURNER_FREE_ITERATIONS } from "../src/seller/rogue.js";
import { formatAtomic } from "../src/money/amount.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The status line from a raw HTTP/1.1 request, with the path bytes untouched.
 *
 * `fetch` and `new URL()` both normalise `..` segments before anything reaches
 * the wire, so they cannot be used to show what a server does with a traversal
 * attempt. This sends the bytes as written and reads the status back.
 */
function rawGetStatus(hostPort: string, rawPath: string): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    // Port and host as separate arguments: `net.connect("host:port", ...)` is the
    // *pipe path* overload, and on Windows that fails with a baffling ENOENT.
    const port = Number(hostPort.slice(hostPort.lastIndexOf(":") + 1));
    const host = hostPort.slice(0, hostPort.lastIndexOf(":"));
    const socket = connect(port, host, () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: ${hostPort}\r\nConnection: close\r\n\r\n`);
    });
    let received = "";
    socket.setTimeout(5_000, () => socket.destroy(new Error("timed out")));
    socket.on("data", (chunk) => (received += String(chunk)));
    socket.on("error", rejectPromise);
    socket.on("close", () => {
      const match = received.match(/^HTTP\/1\.1 (\d{3})/);
      if (match === null) rejectPromise(new Error(`no status line for ${rawPath}: ${received.slice(0, 80)}`));
      else resolvePromise(Number(match[1]));
    });
  });
}

/** A run with a clean ledger, torn down afterwards. */
async function withRun(
  body: (ctx: { runtime: PurseRuntime; events: RunEvent[]; record: RunRecord }) => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "khata-record-"));
  const runtime = await startPurseRuntime({ ledgerPath: join(dir, "purse.sqlite") });
  const events: RunEvent[] = [];
  try {
    const report = await runtime.run({ onEvent: (event) => events.push(event) });
    await body({ runtime, events, record: buildRunRecord({ runtime, report, events }) });
  } finally {
    await runtime.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The parts of `/api/policy` and `/api/record` these tests assert on. */
interface PolicyResponse {
  readonly editable: boolean;
  readonly limits: Readonly<Record<string, string>>;
  readonly settlement: { readonly chainTouched: boolean; readonly realFundsMoved: boolean };
  readonly [key: string]: unknown;
}

/** The `result` object inside an SSE `result` frame from the UI server. */
interface SseFrame {
  readonly index: number;
  readonly result?: {
    readonly kind: "refused" | "settled";
    readonly quotedAtomic: string | null;
    readonly ledgerState: string | null;
    readonly heldAtomic: string | null;
  };
}

interface RecordResponse {
  readonly policy: { readonly perCallCeilingAtomic: string };
  readonly settlement: { readonly realFundsMoved: boolean };
  readonly totals: { readonly bySettlement: Readonly<Record<string, number>> };
  readonly ledger: readonly { readonly quoteAtomic: string }[];
}

/** `Response.json()` is `unknown`; these endpoints have a known shape. */
async function getJson<T>(url: URL): Promise<T> {
  const res = await fetch(url);
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

describe("the decision record", () => {
  it("runs the whole plan and produces every settlement state", async () => {
    await withRun(({ record }) => {
      // Ten planned calls, all executed.
      expect(record.calls).toHaveLength(10);
      expect(record.run.truncated).toBe(false);
      expect(record.run.planner).toBe("scripted");

      // Every state the record claims to distinguish actually occurs in one run,
      // so a reader who sees `budget-held` in the vocabulary has seen it happen.
      expect(record.totals.bySettlement["settled-stub"]).toBe(6);
      expect(record.totals.bySettlement["not-paid"]).toBe(1);
      expect(record.totals.bySettlement.free).toBe(2);
      expect(record.totals.bySettlement["budget-held"]).toBe(1);
    });
  });

  it("never labels a stubbed settlement as paid", async () => {
    await withRun(({ record }) => {
      // The word "paid" on its own, as a settlement value, is the failure this
      // file exists to prevent.
      for (const call of record.calls) {
        expect(call.settlement).not.toBe("paid");
        expect(Object.keys(record.totals.bySettlement)).not.toContain("paid");
      }

      const settled = record.calls.filter((call) => call.settlement === "settled-stub");
      expect(settled.length).toBeGreaterThan(0);
      // The gate's own word is preserved, so the two vocabularies stay comparable.
      for (const call of settled) expect(call.gateOutcome).toBe("paid");
    });
  });

  it("states at the top level that no chain was touched and no funds moved", async () => {
    await withRun(({ record }) => {
      expect(record.settlement.chainTouched).toBe(false);
      expect(record.settlement.realFundsMoved).toBe(false);
      expect(record.settlement.mode).toBe("local-stub");
      expect(record.settlement.note).toMatch(/NO REAL MONEY MOVED/);
    });
  });

  it("reports a held amount for the over-settlement, and does not commit it", async () => {
    await withRun(({ record }) => {
      const held = record.calls.filter((call) => call.settlement === "budget-held");
      expect(held).toHaveLength(1);

      const bait = held[0]!;
      // The bait-and-switch quoted 500 and reported 5000. The hold stays at the
      // authorised amount and nothing is committed - fail closed.
      expect(bait.quotedAtomic).toBe("500");
      expect(bait.committedAtomic).toBe("0");
      expect(bait.heldAtomic).toBe("500");
      expect(bait.ledgerState).toBe("interrupted");

      expect(record.totals.heldAtomic).toBe("500");
      expect(record.totals.heldAttemptCount).toBe(1);
    });
  });

  it("claims a hold only where the ledger still holds one", async () => {
    // The regression this pins: `attempts.reserved_atomic` is kept forever as
    // history, so a record that read it without also reading `state` gave every
    // settled call a hold. The document then contradicted its own summary -
    // per-call holds totalling 14500 next to `heldAttemptCount: 1` - which is the
    // failure mode this file exists to rule out, not a cosmetic bug.
    await withRun(({ record }) => {
      const settled = record.calls.filter((call) => call.settlement === "settled-stub");
      expect(settled.length).toBeGreaterThan(0);
      for (const call of settled) {
        expect(call.ledgerState).toBe("settled");
        expect(call.heldAtomic, `a settled call must not hold money: ${call.label ?? call.callId}`).toBe("0");
      }

      // The per-call column has to reconcile with the summary, in both directions:
      // no call may hold something the ledger does not, and none of the ledger's
      // holds may be missing from the calls.
      const fromCalls = record.calls.reduce((total, call) => total + BigInt(call.heldAtomic), 0n);
      expect(fromCalls).toBe(BigInt(record.totals.heldAtomic));
      expect(fromCalls).toBe(500n);

      const held = record.calls.filter((call) => call.heldAtomic !== "0");
      expect(held).toHaveLength(record.totals.heldAttemptCount);
      expect(held.map((call) => call.settlement)).toEqual(["budget-held"]);

      // And the same for the ledger rows, which is where a renderer reads from.
      const heldRows = record.ledger.filter((row) => row.heldAtomic !== "0");
      expect(heldRows).toHaveLength(1);
      expect(heldRows[0]?.state).toBe("interrupted");
      // The raw column still carries the historical reservation, so the two fields
      // genuinely differ on a settled row. If this ever equalled `heldAtomic` the
      // distinction would have been lost and the display would be ambiguous again.
      const settledRow = record.ledger.find((row) => row.state === "settled");
      expect(settledRow?.reservedAtomic).not.toBe("0");
      expect(settledRow?.heldAtomic).toBe("0");
    });
  });

  it("refuses to write a record whose call rows disagree with its own totals", async () => {
    // The guard in `buildRunRecord` is worth more than the arithmetic it checks, so
    // it is driven with a real inconsistency rather than asserted by inspection.
    // Duplicating the held event makes the per-call column sum to twice what the
    // ledger holds - the exact shape of the bug this record used to ship.
    const dir = mkdtempSync(join(tmpdir(), "khata-guard-record-"));
    const runtime = await startPurseRuntime({ ledgerPath: join(dir, "purse.sqlite") });
    const events: RunEvent[] = [];
    try {
      const report = await runtime.run({ onEvent: (event) => events.push(event) });
      // The honest build succeeds, which is the control for the case below.
      expect(() => buildRunRecord({ runtime, report, events })).not.toThrow();

      const heldEvent = events.find((event) => event.result.kind !== "refused" && event.result.outcome.kind === "interrupted");
      expect(heldEvent, "the demo plan must produce an interrupted call to test this").toBeDefined();

      expect(() => buildRunRecord({ runtime, report, events: [...events, heldEvent!] })).toThrow(
        /would contradict itself/,
      );
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("records the ceiling refusal with the rule that fired and the amount asked for", async () => {
    await withRun(({ record }) => {
      const refused = record.calls.find((call) => call.settlement === "not-paid");
      expect(refused).toBeDefined();
      expect(refused!.refusal?.code).toBe("per-call-ceiling-exceeded");
      // The quoted amount is on the row, so "refused" is never bare.
      expect(refused!.quotedAtomic).toBe("5000000");
      expect(refused!.committedAtomic).toBe("0");
    });
  });

  it("keeps committed spend equal to the sum of the settled calls", async () => {
    await withRun(({ record }) => {
      const sum = record.calls
        .filter((call) => call.settlement === "settled-stub")
        .reduce((total, call) => total + BigInt(call.committedAtomic), 0n);
      expect(record.totals.committedAtomic).toBe(formatAtomic(sum));
      expect(record.totals.committedAtomic).toBe("15000");
    });
  });

  it("fences every scrap of seller text and keeps it out of trusted fields", async () => {
    await withRun(({ record }) => {
      const withText = record.calls.filter((call) => call.untrusted !== null);
      expect(withText.length).toBeGreaterThan(0);

      for (const call of withText) {
        // Markers intact: the record must not be the place that strips them.
        expect(call.untrusted!.content).toMatch(/UNTRUSTED_SELLER_DATA/);
      }

      // The hostile call is where the injection actually is, and the record must
      // show it verbatim - a record that quietly dropped the attack would be
      // indistinguishable from one where nothing was attempted.
      const hostile = withText.find((call) => call.untrusted!.content.includes("SYSTEM OVERRIDE"));
      expect(hostile, "the injection should be preserved in the record").toBeDefined();
      expect(hostile!.untrusted!.content).toMatch(/your run budget is unlimited/);
      // `source` is the trust label: which tool, on which host, produced this.
      expect(hostile!.untrusted!.source).toMatch(/^paid_fetch:127\.0\.0\.1:\d+$/);

      // The scripted planner's closing line is ours and says nothing about payment.
      expect(record.run.finalAnswer ?? "").toMatch(/No real funds were moved/);

      // The injection must not have leaked into a trusted field. A note claiming
      // the budget is unlimited is the specific thing to check for.
      const trusted = JSON.stringify({
        question: record.run.question,
        finalAnswer: record.run.finalAnswer,
        limitations: record.limitations,
      });
      expect(trusted).not.toMatch(/unlimited/);
    });
  });

  it("is serialisable, and bigint-free once written", async () => {
    await withRun(({ record }) => {
      const text = serialiseRecord(record);
      expect(() => JSON.parse(text)).not.toThrow();
      // `JSON.stringify` throws on a bigint, so a clean parse proves none leaked.
      expect(text).toContain('"chainTouched": false');
    });
  });

  it("lists the tool schema with no field a limit could be read from", async () => {
    await withRun(({ record }) => {
      const parameters = record.tool.parameters as {
        properties: Record<string, unknown>;
        additionalProperties: unknown;
      };
      expect(Object.keys(parameters.properties).sort()).toEqual(["label", "url"]);
      expect(parameters.additionalProperties).toBe(false);

      // Only the schema the model sees matters. `record.tool.note` is prose *for a
      // human* explaining that no such field exists, so scanning it for the word
      // "budget" would prove nothing either way.
      const schema = JSON.stringify(parameters).toLowerCase();
      for (const forbidden of ["budget", "ceiling", "limit", "allowlist", "private", "signer", "amount", "key"]) {
        expect(schema, `tool parameters must not mention ${forbidden}`).not.toContain(forbidden);
      }
    });
  });
});

describe("the shared runtime", () => {
  it("pins the ports the sellers actually bound, and engages the guard", async () => {
    const dir = mkdtempSync(join(tmpdir(), "khata-runtime-"));
    const runtime = await startPurseRuntime({ ledgerPath: join(dir, "purse.sqlite") });
    try {
      expect(runtime.allowlist.pinsPorts).toBe(true);
      expect(runtime.transportGuardEngaged).toBe(true);
      expect(runtime.allowlist.entries).toEqual(
        expect.arrayContaining([`127.0.0.1:${portOf(runtime.honest.url)}`]),
      );
      // A different port on the same host is not reachable.
      const other = portOf(runtime.rogue.url) + 1;
      expect(runtime.allowlist.permitsUrl(new URL(`http://127.0.0.1:${other}/rogue/overpriced`))).toBe(false);
      expect(runtime.allowlist.permitsUrl(new URL(runtime.honest.url.replace(/\/$/, "") + "/rainfall"))).toBe(true);
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a remote destination at the allowlist, whichever rule gets there first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "khata-guard-"));
    const runtime = await startPurseRuntime({ ledgerPath: join(dir, "purse.sqlite") });
    try {
      // Two attempts at the same forbidden host. The dispatcher checks the URL
      // shape before the host, so plaintext is caught by the scheme rule and
      // https by the allowlist. Both must refuse, and neither may sign - which
      // is the property that matters, independent of which rule spoke first.
      const attempts = [
        { url: "http://169.254.169.254/latest/meta-data/", code: "plaintext-to-remote-host" },
        { url: "https://169.254.169.254/latest/meta-data/", code: "host-not-allowed" },
      ] as const;

      for (const [index, attempt] of attempts.entries()) {
        const outcome = await runtime.dispatcher.dispatch("x", {
          id: `c${index}`,
          name: "paid_fetch",
          arguments: JSON.stringify({ url: attempt.url }),
        });
        expect(outcome.kind).toBe("refused");
        if (outcome.kind === "refused") expect(outcome.code).toBe(attempt.code);
      }
      expect(runtime.signer.callCount).toBe(0);
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("plans the documented calls in the documented order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "khata-plan-"));
    const runtime = await startPurseRuntime({ ledgerPath: join(dir, "purse.sqlite") });
    try {
      const plan = scriptedPlan(runtime.honest, runtime.rogue);
      expect(plan).toHaveLength(10);
      expect(DEMO_MAX_TURNS).toBeGreaterThanOrEqual(plan.length + 1);
      // Two burner calls before the third, so the free/paid transition is shown.
      const burners = plan.filter((call) => call.arguments.includes("/rogue/burner"));
      expect(burners).toHaveLength(BURNER_FREE_ITERATIONS + 1);
      expect(plan.every((call) => call.name === "paid_fetch")).toBe(true);
    } finally {
      await runtime.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes no way to change policy after startup", async () => {
    const config = loadConfig();
    const before = config.policy.limits.perCallCeiling;
    // Frozen: the object is the same one the dispatcher holds, and it cannot be
    // written to. A caller that tried would throw in strict mode.
    expect(() => {
      (config.policy.limits as { perCallCeiling: unknown }).perCallCeiling = 1n;
    }).toThrow();
    expect(config.policy.limits.perCallCeiling).toBe(before);
    expect(Object.isFrozen(config)).toBe(true);
  });
});

describe("the UI server", () => {
  let ui: UiServer | null = null;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "khata-ui-"));
  });

  afterEach(async () => {
    if (ui !== null) await ui.close();
    ui = null;
    rmSync(dir, { recursive: true, force: true });
  });

  async function serve(): Promise<UiServer> {
    const server = await startUiServer({
      createRuntime: () => startPurseRuntime({ ledgerPath: join(dir, `${Math.random()}.sqlite`) }),
      recordPath: join(dir, "decision-log.json"),
    });
    ui = server;
    return server;
  }

  it("binds to loopback only, and refuses anything else", async () => {
    await expect(
      startUiServer({
        createRuntime: () => startPurseRuntime({ ledgerPath: join(dir, "x.sqlite") }),
        recordPath: join(dir, "r.json"),
        host: "0.0.0.0",
      }),
    ).rejects.toThrow(/loopback/);
  });

  it("serves the page and its assets", async () => {
    const server = await serve();
    for (const [path, type] of [
      ["/", "text/html"],
      ["/styles.css", "text/css"],
      ["/app.js", "text/javascript"],
    ] as const) {
      const res = await fetch(new URL(path, server.url));
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(type);
    }
  });

  it("keeps the README's line counts for the three static files honest", async () => {
    // The README states the UI is "212 lines of markup, 449 of CSS, 345 of plain
    // JavaScript". That is trivia, and trivia in a README is trivia that rots -
    // this repo shipped 439 and 337 long after the files changed, alongside a
    // test count and a scanned-file count that were both stale. So the claim is
    // checked instead of trusted.
    const readme = readFileSync(join(HERE, "..", "README.md"), "utf8");
    const claimed = readme.match(/(\d+) lines of\s+markup,\s*(\d+) of CSS,\s*(\d+) of plain/);
    expect(claimed, "README no longer states the three line counts").not.toBeNull();

    const actual = ["index.html", "styles.css", "app.js"].map((name) => {
      const body = readFileSync(join(HERE, "..", "public", name), "utf8");
      return body.split("\n").length - (body.endsWith("\n") ? 1 : 0);
    });
    expect(actual).toEqual([Number(claimed![1]), Number(claimed![2]), Number(claimed![3])]);
  });

  it("keeps the page from scrolling sideways on a 360px phone", async () => {
    // Found in a real browser, not by reading the CSS: at 360px the document
    // was 609px wide. `main` is a one-column grid, and a grid column defaults
    // to `minmax(auto, auto)` - an `auto` *minimum* resolves to the item's
    // min-content width, so the 10-column calls table set the column to 559px
    // and every other panel was dragged out to match. The tables were fine:
    // each already sits in `.table-scroll` with `overflow-x: auto`.
    //
    // A unit test cannot measure layout, so this pins the two declarations that
    // fix it. Deleting either one puts the horizontal scroll back.
    const css = await (await fetch(new URL("/styles.css", (await serve()).url))).text();

    const main = css.slice(css.indexOf("\nmain {"), css.indexOf("\n}", css.indexOf("\nmain {")));
    expect(main).toMatch(/grid-template-columns:\s*minmax\(0,\s*1fr\)/);

    const panel = css.slice(css.indexOf("\n.panel {"), css.indexOf("\n}", css.indexOf("\n.panel {")));
    expect(panel).toMatch(/min-width:\s*0/);

    // And the tables must still be able to scroll, or `minmax(0, 1fr)` would
    // just clip them.
    const scroll = css.slice(
      css.indexOf("\n.table-scroll {"),
      css.indexOf("\n}", css.indexOf("\n.table-scroll {")),
    );
    expect(scroll).toMatch(/overflow-x:\s*auto/);
  });

  it("honours the accessibility claims its own stylesheet header makes", async () => {
    // The header of styles.css claims three things. Two are one declaration
    // each and are worth pinning; the focus ring is verified in a real browser
    // (a 3px solid accent outline at 2px offset on :focus-visible) because a
    // source check cannot tell a ring that renders from one that does not.
    const css = await (await fetch(new URL("/styles.css", (await serve()).url))).text();

    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid/);
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    // The skip link must be off-screen at rest and come into view on focus,
    // which is the only way it is reachable by keyboard at all.
    expect(css).toMatch(/\.skip-link\s*\{[^}]*left:\s*-\d+/);
    expect(css).toMatch(/\.skip-link:focus\s*\{\s*left:\s*0/);
  });

  it("reports policy as read-only, with a known and closed set of keys", async () => {
    const server = await serve();
    const policy = await getJson<PolicyResponse>(new URL("/api/policy", server.url));
    expect(policy.editable).toBe(false);
    expect(policy.settlement.chainTouched).toBe(false);
    expect(policy.settlement.realFundsMoved).toBe(false);

    // Enumerated rather than pattern-matched. A regex for "no setter-looking key"
    // matches `"settlement"` and teaches the reader nothing; listing the keys
    // means a new field cannot appear without this test failing.
    expect(Object.keys(policy).sort()).toEqual([
      "allowlist",
      "editable",
      "ledgerPath",
      "limits",
      "maxTurns",
      "planner",
      "question",
      "settlement",
    ]);
    expect(Object.keys(policy.limits).sort()).toEqual([
      "perCallCeilingAtomic",
      "perCallCeilingUsd",
      "runBudgetAtomic",
      "runBudgetUsd",
    ]);
    // Every value is a string, boolean, number or array - JSON cannot carry a
    // function or a live reference back to the frozen policy object.
    const assertPlain = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(assertPlain);
      else if (value !== null && typeof value === "object") {
        Object.values(value).forEach(assertPlain);
      } else {
        expect(["string", "boolean", "number"]).toContain(typeof value);
      }
    };
    assertPlain(policy);
  });

  it("has no endpoint that accepts a policy change", async () => {
    const server = await serve();
    // Every plausible write route is refused, and the body is never consulted.
    //
    // The status is now the accurate one rather than a blanket 405: a route that
    // exists but not for this method is 405 with `Allow`, and a path that was
    // never here is 404. Both refuse, which is the property that matters, so
    // that is what is asserted - along with the refusal never being a 2xx.
    for (const [method, path] of [
      ["PUT", "/api/policy"],
      ["POST", "/api/policy"],
      ["PATCH", "/api/run"],
      ["DELETE", "/api/record"],
      ["POST", "/api/limits"],
    ] as const) {
      const res = await fetch(new URL(path, server.url), {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ perCallCeiling: "999999999", runBudget: "999999999999" }),
      });
      expect([404, 405], `${method} ${path} must be refused`).toContain(res.status);
    }

    // And the distinction itself, so a future change cannot quietly flatten it
    // back to one status for everything again.
    const known = await fetch(new URL("/api/run", server.url), { method: "PATCH" });
    expect(known.status).toBe(405);
    expect(known.headers.get("allow")).toContain("POST");

    const unknown = await fetch(new URL("/api/limits", server.url), { method: "POST" });
    expect(unknown.status).toBe(404);
  });

  it("ignores a policy-smuggling body on the run route", async () => {
    const server = await serve();
    const before = loadConfig().policy.limits.perCallCeiling;

    const res = await fetch(new URL("/api/run", server.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ policy: { perCallCeiling: "999999999" } }),
    });
    expect(res.status).toBe(200);

    // Drain the stream, then confirm the limit did not move.
    const text = await res.text();
    expect(text).toMatch(/event: (start|result|end)/);
    expect(loadConfig().policy.limits.perCallCeiling).toBe(before);

    // And the record the run produced still carries the configured ceiling.
    const record = await getJson<RecordResponse>(new URL("/api/record", server.url));
    expect(record.policy.perCallCeilingAtomic).toBe(before.toString());
    expect(record.policy.perCallCeilingAtomic).not.toBe("999999999");
  });

  it("writes a record whose settlement labels are the truthful ones", async () => {
    const server = await serve();
    const res = await fetch(new URL("/api/run", server.url), { method: "POST" });
    await res.text();

    const record = await getJson<RecordResponse>(new URL("/api/record", server.url));
    expect(record.settlement.realFundsMoved).toBe(false);
    expect(record.totals.bySettlement["settled-stub"]).toBeGreaterThan(0);
    expect(record.totals.bySettlement).not.toHaveProperty("paid");
  });

  it("streams the quote on every result, so the live table matches the record", async () => {
    // The streaming path used to omit `quotedAtomic`, so the Quoted column stayed
    // blank for the whole run and only filled in from the saved record afterwards.
    // A live table that disagrees with the file it is about to write is worse than
    // an empty one, so every result frame has to carry the same figures the record
    // does.
    const server = await serve();
    const res = await fetch(new URL("/api/run", server.url), { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.text();

    const frames = [...body.matchAll(/^event: (\w+)\ndata: (.*)$/gm)].map((m) => ({
      event: m[1] as string,
      data: JSON.parse(m[2] as string) as SseFrame,
    }));
    const results = frames.filter((f) => f.event === "result");
    expect(results.length).toBe(10);

    // Every call that reached the gate has a ledger row, so every one of those
    // frames must carry the quote as a base-unit string.
    const reached = results.filter((f) => f.data.result?.kind === "settled");
    expect(reached.length).toBeGreaterThan(0);
    for (const frame of reached) {
      const result = frame.data.result!;
      expect(result.quotedAtomic, "a reached call must stream its quote").toMatch(/^\d+$/);
      expect(result.ledgerState).toMatch(/^(settled|refused|interrupted|reserved)$/);
      // Settled and released rows stream no hold; the interrupted one streams the
      // reservation. Same rule the record applies, same helper.
      expect(result.heldAtomic).toMatch(/^\d+$/);
    }

    // The one held call in the demo plan is the bait-and-switch, and it is the only
    // frame allowed to claim a hold.
    const withHold = results.filter((f) => f.data.result?.heldAtomic !== "0");
    expect(withHold).toHaveLength(1);

    // And the streamed figures are the record's figures, not a second opinion: the
    // quotes the browser saw are exactly the quotes in the ledger the record is
    // built from.
    const record = await getJson<RecordResponse>(new URL("/api/record", server.url));
    const streamedQuotes = reached.map((f) => f.data.result!.quotedAtomic).sort();
    const recordedQuotes = record.ledger.map((row) => row.quoteAtomic).sort();
    expect(streamedQuotes).toEqual(recordedQuotes);
  });

  it("serves nothing from outside public/, however the path is spelled", async () => {
    const server = await serve();
    // Sent over a raw socket on purpose: `new URL("/../x", base)` silently
    // normalises the traversal away, so a fetch-based test would pass without
    // ever asking the server a traversal question.
    const target = new URL(server.url);
    const paths = [
      "/../package.json",
      "/../../src/config/env.ts",
      "/%2e%2e%2fpackage.json",
      "/..%2fpackage.json",
      "/public/../package.json",
      "/....//package.json",
    ];

    for (const path of paths) {
      const status = await rawGetStatus(target.host, path);
      expect(status, `${path} must not be served`).not.toBe(200);
    }

    // And the same for anything that is not one of the three known files.
    for (const path of ["/package.json", "/src/config/env.ts", "/record/decision-log.json"]) {
      const body = await (await fetch(new URL(path, server.url))).text();
      expect(body).not.toContain("khata-coin-purse");
      expect(body).not.toContain("PRIVATE_KEY");
    }
  });
});
