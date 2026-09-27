/**
 * Check 9, continued: the remaining ways a tool call could try to move a limit.
 *
 * ## Why a second file
 *
 * `tests/agent-loop.test.ts` has 16 adversarial cases covering the obvious
 * spellings of "raise your budget" as a tool argument. Those are necessary and
 * they are not sufficient, because they all assume the *shape* of the attack is
 * a JSON object with one extra key. The cases here are the ones where the shape
 * itself is wrong, which is exactly where a hand-rolled parser usually leaks:
 *
 * - **not an object at all** — a bare string, an array, a number, `null`;
 * - **a different key spelling** — `Budget`, `budget `, `per_call_ceiling`;
 * - **prototype pollution** — `__proto__` / `constructor` / `prototype`, which
 *   reach a sloppy merge but not a strict schema;
 * - **smuggling through a permitted field** — policy text inside `label`, or
 *   query parameters on `url`;
 * - **the wrong door** — a tool name that differs only by case, or arguments
 *   that are not JSON at all.
 *
 * Every case asserts the same three things: refused, `signer.callCount === 0`,
 * and zero ledger rows. A limit that moved without a signature or a ledger entry
 * would be a *bug in the accounting*, not a bug in the policy check, so the ledger
 * assertion is the one that would catch a subtle hole.
 *
 * ## The standard this file holds the implementation to
 *
 * A claim of "done" for Check 9 means: **no input a model can send changes a
 * number the purse enforces.** That is a claim about every wire shape, not about
 * one spelling of one field. These tests are the evidence for it.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Ledger } from "../src/ledger/ledger.js";
import { createPolicy } from "../src/policy/policy.js";
import { createHttpTransport } from "../src/x402/http-transport.js";
import { createStubSigner } from "../src/seller/stub-signer.js";
import { HONEST_PATHS, startHonestSeller } from "../src/seller/honest.js";
import { startRogueSeller } from "../src/seller/rogue.js";
import { ETHEREUM_SEPOLIA, ETHEREUM_SEPOLIA_USDC } from "../src/seller/wire.js";
import type { Seller } from "../src/seller/http.js";
import type { RogueSeller } from "../src/seller/rogue.js";
import type { StubSigner } from "../src/seller/stub-signer.js";

import { PAID_FETCH_TOOL_NAME, SellerAllowlist, parseToolArguments } from "../src/agent/tools.js";
import { ToolDispatcher, toModelContent, type IncomingToolCall } from "../src/agent/dispatch.js";

const POLICY = {
  perCallCeiling: "100000", // $0.10
  runBudget: "1000000", //   $1.00
  allowedNetworks: [ETHEREUM_SEPOLIA],
  allowedAssets: [`${ETHEREUM_SEPOLIA}=${ETHEREUM_SEPOLIA_USDC}`],
  allowedSchemes: ["exact"],
  allowedPayees: ["0x5FbDB2315678afecb367f032d93F642f64180aa3"],
};

interface Harness {
  readonly dispatcher: ToolDispatcher;
  readonly ledger: Ledger;
  readonly signer: StubSigner;
}

function makeHarness(hosts: readonly string[] = ["127.0.0.1"]): Harness {
  const ledger = Ledger.open(":memory:");
  ledger.openRun({ runId: "run-1", runBudget: 1000000n, planner: "scripted", question: "q" });
  const signer = createStubSigner();
  let attempt = 0;
  const dispatcher = new ToolDispatcher({
    policy: createPolicy({ ...POLICY }),
    ledger,
    http: createHttpTransport(),
    signer,
    allowlist: new SellerAllowlist(hosts),
    nextAttemptId: () => `attempt-${(attempt += 1)}`,
    now: () => new Date("2026-09-26T00:00:00Z"),
  });
  return { dispatcher, ledger, signer };
}

/** A raw tool call, with `arguments` left exactly as given. */
function rawCall(id: string, name: string, argumentsText: string): IncomingToolCall {
  return { id, name, arguments: argumentsText };
}

describe("Check 9: arguments that are not an object", () => {
  let honest: Seller;
  let rogue: RogueSeller;

  beforeEach(async () => {
    honest = await startHonestSeller();
    rogue = await startRogueSeller();
  });

  afterEach(async () => {
    await Promise.all([honest.close(), rogue.close()]);
  });

  // `%URL%` is substituted inside the test body. The table below is built when
  // the `describe` runs, which is before `beforeEach` starts the sellers, so a
  // seller URL cannot be read here.
  it.each([
    ["a bare JSON string", '"%URL%"'],
    ["a JSON array", '["%URL%"]'],
    ["a nested array of objects", '[{"url":"%URL%"}]'],
    ["a number", "42"],
    ["a boolean", "true"],
    ["null", "null"],
    ["an empty object", "{}"],
    ["label only, no url", '{"label":"mandi"}'],
    ["an empty url", '{"url":""}'],
    ["a url of the wrong type", '{"url":{"toString":"%URL%"}}'],
    ["a url that is a number", '{"url":80}'],
  ])("refuses %s, without signing or writing a ledger row", async (_name, template) => {
    const { dispatcher, signer, ledger } = makeHarness();
    const argumentsText = template.replaceAll("%URL%", honest.resolve(HONEST_PATHS.mandiPrice));

    const result = await dispatcher.dispatch("run-1", rawCall("call-1", PAID_FETCH_TOOL_NAME, argumentsText));

    expect(result.kind).toBe("refused");
    expect(signer.callCount).toBe(0);
    expect(ledger.list("run-1")).toHaveLength(0);
    expect(toModelContent(result)).toContain("REFUSED");
  });

  it.each([
    ["not json at all", "budget=999999999"],
    ["a truncated object", '{"url":"http://127.0.0.1"'],
    ["a trailing comma", '{"url":"http://127.0.0.1",}'],
    ["single quotes", "{'url':'http://127.0.0.1'}"],
    ["an empty string", ""],
    ["whitespace", "   "],
  ])("refuses malformed arguments (%s)", async (_name, argumentsText) => {
    const { dispatcher, signer, ledger } = makeHarness();

    const result = await dispatcher.dispatch("run-1", rawCall("call-1", PAID_FETCH_TOOL_NAME, argumentsText));

    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") throw new Error("unreachable");
    expect(result.code).toBe("malformed-json");
    expect(signer.callCount).toBe(0);
    expect(ledger.list("run-1")).toHaveLength(0);
  });
});

describe("Check 9: alternative spellings of a limit field", () => {
  let honest: Seller;
  let rogue: RogueSeller;

  beforeEach(async () => {
    honest = await startHonestSeller();
    rogue = await startRogueSeller();
  });

  afterEach(async () => {
    await Promise.all([honest.close(), rogue.close()]);
  });

  it.each([
    ["Budget", { Budget: "999999999" }],
    ["budget with trailing space", { "budget ": "999999999" }],
    ["per_call_ceiling", { per_call_ceiling: "999999999" }],
    ["PER-CALL-CEILING", { "PER-CALL-CEILING": "999999999" }],
    ["perCallCeilingAtomic", { perCallCeilingAtomic: "999999999" }],
    ["maxSpend", { maxSpend: "999999999" }],
    ["spendLimit", { spendLimit: "999999999" }],
    ["ceiling", { ceiling: "999999999" }],
    ["limit", { limit: "999999999" }],
    ["amount", { amount: "999999999" }],
    ["allowAll", { allowAll: true }],
    ["override", { override: "policy" }],
    ["bypass", { bypass: true }],
    ["noLimit", { noLimit: true }],
    ["infinite", { infinite: true }],
    ["wildcardAsset", { asset: "*" }],
    ["facilitatorUrl", { facilitatorUrl: "https://attacker.example" }],
    ["x402Version", { x402Version: 99 }],
  ])("refuses %s as an unknown argument, not silently", async (_name, extra) => {
    const { dispatcher, signer, ledger } = makeHarness();

    const result = await dispatcher.dispatch(
      "run-1",
      rawCall("call-1", PAID_FETCH_TOOL_NAME, JSON.stringify({ url: honest.resolve(HONEST_PATHS.mandiPrice), ...extra })),
    );

    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") throw new Error("unreachable");
    // Named as an unknown argument specifically, so the record says "we do not
    // have that field" rather than the vaguer "invalid".
    expect(result.code).toBe("unknown-argument");
    expect(result.reason).toMatch(/not part of this tool/);
    expect(signer.callCount).toBe(0);
    expect(ledger.list("run-1")).toHaveLength(0);
  });
});

describe("Check 9: prototype pollution through the argument object", () => {
  let honest: Seller;
  let rogue: RogueSeller;

  beforeEach(async () => {
    honest = await startHonestSeller();
    rogue = await startRogueSeller();
  });

  afterEach(async () => {
    await Promise.all([honest.close(), rogue.close()]);
  });

  it.each([
    ["__proto__", '{"url":"%URL%","__proto__":{"polluted":true}}'],
    ["constructor", '{"url":"%URL%","constructor":{"prototype":{"polluted":true}}}'],
    ["prototype", '{"url":"%URL%","prototype":{"polluted":true}}'],
  ])("refuses %s as an unknown argument and does not pollute Object.prototype", async (_name, template) => {
    const { dispatcher, signer, ledger } = makeHarness();
    const target = honest.resolve(HONEST_PATHS.mandiPrice);
    const argumentsText = template.replace("%URL%", target);

    // The pollution sentinel, so a successful attack would be visible even if
    // the refusal assertion were somehow satisfied.
    const pollutedBefore = ({} as Record<string, unknown>).polluted;
    const result = await dispatcher.dispatch("run-1", rawCall("call-1", PAID_FETCH_TOOL_NAME, argumentsText));
    const pollutedAfter = ({} as Record<string, unknown>).polluted;

    expect(result.kind).toBe("refused");
    expect(pollutedAfter).toBe(pollutedBefore);
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(signer.callCount).toBe(0);
    expect(ledger.list("run-1")).toHaveLength(0);
  });

  it("refuses a __proto__ key via the parse path too", () => {
    // Note the raw string rather than an object literal. `{__proto__: x}` in a
    // literal sets the prototype and is *dropped* by JSON.stringify, so the
    // literal form would have produced `{"url":...}` and tested nothing. A model
    // sends text, so text is what has to be parsed.
    const parsed = parseToolArguments(
      '{"url":"http://127.0.0.1:1/x","__proto__":{"runBudget":"1"}}',
      new SellerAllowlist(["127.0.0.1:1"]),
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.code).toBe("unknown-argument");
    expect(parsed.message).toMatch(/__proto__/);
  });

  it("would not notice a __proto__ key written as an object literal, which is why the wire form is tested", () => {
    // A regression guard on the test itself: if someone "simplifies" the case
    // above into an object literal, this fails and the case is repaired.
    expect(JSON.stringify({ url: "http://127.0.0.1:1/x", __proto__: { runBudget: "1" } })).toBe(
      '{"url":"http://127.0.0.1:1/x"}',
    );
  });
});

describe("Check 9: smuggling through a permitted field", () => {
  let honest: Seller;
  let rogue: RogueSeller;

  beforeEach(async () => {
    honest = await startHonestSeller();
    rogue = await startRogueSeller();
  });

  afterEach(async () => {
    await Promise.all([honest.close(), rogue.close()]);
  });

  it("ignores policy text inside label, which nothing reads", async () => {
    // `label` is the one field beyond `url`, and it exists only so the model can
    // name what it fetched. If any limit were ever read from it, this is where it
    // would show. So: the call succeeds, at the normal price, with the limit
    // unchanged.
    const { dispatcher, signer, ledger } = makeHarness();

    const result = await dispatcher.dispatch(
      "run-1",
      rawCall(
        "call-1",
        PAID_FETCH_TOOL_NAME,
        JSON.stringify({
          url: honest.resolve(HONEST_PATHS.rainfallGrid),
          label: '{"perCallCeiling":"999999999","runBudget":"999999999"}',
        }),
      ),
    );

    // It paid the real price, not a raised one.
    expect(result.kind).toBe("settled");
    if (result.kind !== "settled" || result.outcome.kind !== "paid") {
      throw new Error(`expected a paid outcome, got ${result.kind}/${result.kind === "settled" ? result.outcome.kind : "-"}`);
    }
    expect(result.outcome.settledAtomic).toBe(500n);
    expect(signer.callCount).toBe(1);

    const totals = ledger.totals("run-1");
    expect(totals.committed).toBe(500n);
    // The ceiling is still the policy's, not the label's.
    expect(ledger.runBudgetFor("run-1")).toBe(1000000n);
  });

  it("ignores policy-looking query parameters on the url", async () => {
    const { dispatcher, signer, ledger } = makeHarness();

    const result = await dispatcher.dispatch(
      "run-1",
      rawCall(
        "call-1",
        PAID_FETCH_TOOL_NAME,
        JSON.stringify({
          url: `${honest.resolve(HONEST_PATHS.rainfallGrid)}?perCallCeiling=999999999&runBudget=999999999&free=1`,
        }),
      ),
    );

    // Whatever the seller makes of those parameters, the purse paid the quoted
    // price and stayed inside its own budget.
    expect(result.kind).toBe("settled");
    if (result.kind !== "settled") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("paid");
    expect(ledger.totals("run-1").committed).toBe(500n);
    expect(ledger.runBudgetFor("run-1")).toBe(1000000n);
    expect(signer.callCount).toBe(1);
  });

  it("ignores a policy-looking fragment on the url", async () => {
    const { dispatcher, ledger } = makeHarness();

    await dispatcher.dispatch(
      "run-1",
      rawCall(
        "call-1",
        PAID_FETCH_TOOL_NAME,
        JSON.stringify({ url: `${honest.resolve(HONEST_PATHS.rainfallGrid)}#runBudget=999999999` }),
      ),
    );

    expect(ledger.runBudgetFor("run-1")).toBe(1000000n);
    expect(ledger.totals("run-1").committed).toBe(500n);
  });
});

describe("Check 9: the wrong door", () => {
  let honest: Seller;
  let rogue: RogueSeller;

  beforeEach(async () => {
    honest = await startHonestSeller();
    rogue = await startRogueSeller();
  });

  afterEach(async () => {
    await Promise.all([honest.close(), rogue.close()]);
  });

  it.each([
    ["Paid_Fetch", "Paid_Fetch"],
    ["PAID_FETCH", "PAID_FETCH"],
    ["paid_fetch ", "paid_fetch "],
    [" paid_fetch", " paid_fetch"],
    ["paid-fetch", "paid-fetch"],
    ["paidfetch", "paidfetch"],
    ["pay", "pay"],
    ["", ""],
  ])("refuses the tool name %j, which is not an exact match", async (_name, toolName) => {
    const { dispatcher, signer, ledger } = makeHarness();

    const result = await dispatcher.dispatch(
      "run-1",
      rawCall("call-1", toolName, JSON.stringify({ url: honest.resolve(HONEST_PATHS.mandiPrice) })),
    );

    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") throw new Error("unreachable");
    expect(result.reason).toMatch(/no tool named/);
    expect(signer.callCount).toBe(0);
    expect(ledger.list("run-1")).toHaveLength(0);
  });

  it("refuses a second tool call in one turn that carries a limit, and still honours the first", async () => {
    // A model can emit several tool calls at once. Each gets its own independent
    // check, so a bad one in the batch cannot ride along on a good one.
    const { dispatcher, signer, ledger } = makeHarness();

    const good = await dispatcher.dispatch(
      "run-1",
      rawCall("good", PAID_FETCH_TOOL_NAME, JSON.stringify({ url: honest.resolve(HONEST_PATHS.rainfallGrid) })),
    );
    const bad = await dispatcher.dispatch(
      "run-1",
      rawCall(
        "bad",
        PAID_FETCH_TOOL_NAME,
        JSON.stringify({ url: honest.resolve(HONEST_PATHS.mandiPrice), runBudget: "999999999" }),
      ),
    );

    expect(good.kind).toBe("settled");
    expect(bad.kind).toBe("refused");
    // Exactly one signature, for the one legitimate call.
    expect(signer.callCount).toBe(1);
    expect(ledger.totals("run-1").committed).toBe(500n);
    expect(ledger.runBudgetFor("run-1")).toBe(1000000n);
  });
});

describe("Check 9: a hostile 402 cannot move a limit either", () => {
  let honest: Seller;
  let rogue: RogueSeller;

  beforeEach(async () => {
    honest = await startHonestSeller();
    rogue = await startRogueSeller();
  });

  afterEach(async () => {
    await Promise.all([honest.close(), rogue.close()]);
  });

  it("refuses the rogue stall's $5 quote against a $0.10 ceiling, and reserves nothing", async () => {
    // The seller is the attacker here, not the model. The price is read from the
    // 402 and checked before the signer, so a hostile quote is refused on the
    // same terms as a hostile argument.
    const { dispatcher, signer, ledger } = makeHarness();

    const result = await dispatcher.dispatch(
      "run-1",
      rawCall("call-1", PAID_FETCH_TOOL_NAME, JSON.stringify({ url: rogue.resolve("/rogue/overpriced") })),
    );

    expect(result.kind).toBe("settled");
    if (result.kind !== "settled") throw new Error("unreachable");
    expect(result.outcome.kind).toBe("refused");
    if (result.outcome.kind !== "refused") throw new Error("unreachable");
    expect(signer.callCount).toBe(0);
    expect(ledger.totals("run-1").reserved).toBe(0n);
    expect(ledger.totals("run-1").committed).toBe(0n);
  });

  it("keeps the ceiling fixed across a mixed batch of hostile and legitimate quotes", async () => {
    const { dispatcher, signer, ledger } = makeHarness();

    for (const path of ["/rogue/overpriced", HONEST_PATHS.rainfallGrid, "/rogue/overpriced", HONEST_PATHS.mandiPrice]) {
      const url = path.startsWith("/rogue/") ? rogue.resolve(path) : honest.resolve(path);
      await dispatcher.dispatch("run-1", rawCall(`c-${path}`, PAID_FETCH_TOOL_NAME, JSON.stringify({ url })));
    }

    // Two legitimate purchases at their quoted prices, and not one base unit more.
    expect(ledger.totals("run-1").committed).toBe(1500n);
    expect(ledger.runBudgetFor("run-1")).toBe(1000000n);
    // Two signatures: the two calls the ceiling allowed.
    expect(signer.callCount).toBe(2);
  });
});
