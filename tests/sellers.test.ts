/**
 * Seller integration: the buyer's gate against real local sellers over TCP.
 *
 * These tests open actual sockets. No `HttpPort` is stubbed and no route
 * handler is called directly — the gate does a genuine `GET`, the seller
 * answers a genuine 402 with a genuine `PAYMENT-REQUIRED` header, and the
 * retry carries a real encoded `X-PAYMENT` produced by the real
 * `@x402/core` codec. The only fakes are the signature itself and the
 * facilitator's on-chain settlement, both of which are outside the buyer's
 * control anyway.
 *
 * That distinction is the point. A defect in header handling, status handling,
 * body decoding or request ordering can only show up here; it cannot show up in
 * a unit test with a scripted transport, because the scripted transport is
 * already correct.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decodePaymentSignatureHeader } from "@x402/core/http";

import { Ledger } from "../src/ledger/ledger.js";
import { createPolicy } from "../src/policy/policy.js";
import { SigningGate, type GateOutcome } from "../src/x402/gate.js";
import { createHttpTransport } from "../src/x402/http-transport.js";
import { createStubSigner } from "../src/seller/stub-signer.js";
import { createStubFacilitator } from "../src/seller/facilitator.js";
import { HONEST_PATHS, HONEST_PRICES, HONEST_ROUTES, startHonestSeller } from "../src/seller/honest.js";
import { BURNER_FREE_ITERATIONS, startRogueSeller } from "../src/seller/rogue.js";
import { ETHEREUM_SEPOLIA, ETHEREUM_SEPOLIA_USDC } from "../src/seller/wire.js";
import type { Seller } from "../src/seller/http.js";
import type { RogueSeller } from "../src/seller/rogue.js";

/** The policy used unless a test needs a different ceiling. */
const POLICY = {
  perCallCeiling: "100000", // $0.10 — above every honest price, below the rogue's
  runBudget: "1000000", //   $1.00 — enough to not be the thing that stops it
  allowedNetworks: [ETHEREUM_SEPOLIA],
  // Assets are scoped per network: "network=0xaddress". A bare address would
  // mean nothing, which is the point of the format.
  allowedAssets: [`${ETHEREUM_SEPOLIA}=${ETHEREUM_SEPOLIA_USDC}`],
  allowedSchemes: ["exact"],
  allowedPayees: ["0x5FbDB2315678afecb367f032d93F642f64180aa3"],
};

/** A fresh gate over an in-memory ledger, wired to the real transport. */
function makeGate(overrides: Partial<typeof POLICY> = {}): {
  gate: SigningGate;
  ledger: Ledger;
  signer: ReturnType<typeof createStubSigner>;
} {
  const ledger = Ledger.open(":memory:");
  ledger.openRun({ runId: "run-1", runBudget: 1000000n, planner: "planner", question: "q" });
  const policy = createPolicy({ ...POLICY, ...overrides });
  const signer = createStubSigner();
  let attempt = 0;
  const gate = new SigningGate({
    policy,
    ledger,
    http: createHttpTransport(),
    signer,
    nextAttemptId: () => `attempt-${(attempt += 1)}`,
    now: () => new Date("2026-09-26T00:00:00Z"),
  });
  return { gate, ledger, signer };
}

/** One call through the gate, with the real transport. */
async function call(gate: SigningGate, tool: string, url: string): Promise<GateOutcome> {
  return gate.call({ runId: "run-1", tool, url });
}

/**
 * Look a header up case-insensitively in a recorded request.
 *
 * Necessary rather than fussy: the signer returns `X-PAYMENT` as the canonical
 * name, `fetch` lowercases it on the wire, and the seller reads it lowercased.
 * Comparing one spelling against another would pass or fail for reasons that
 * have nothing to do with the buyer's behaviour.
 */
function headerOf(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

describe("honest seller over real HTTP", () => {
  let seller: Seller;

  beforeEach(async () => {
    seller = await startHonestSeller();
  });

  afterEach(async () => {
    await seller.close();
  });

  it("serves a free route without asking for money or signing anything", async () => {
    const { gate, signer } = makeGate();

    const outcome = await call(gate, "health", seller.resolve("/v1/health"));

    expect(outcome.kind).toBe("free");
    expect(outcome.status).toBe(200);
    expect(signer.callCount).toBe(0);
  });

  it("answers an unpaid request with a real 402 and no signature attached", async () => {
    const { gate, signer } = makeGate();

    // Prove the seller's 402 independently of the gate, over a real socket.
    const raw = await fetch(seller.resolve(HONEST_PATHS.mandiPrice));
    expect(raw.status).toBe(402);
    const required = raw.headers.get("payment-required");
    expect(required).toBeTruthy();
    expect(signer.callCount).toBe(0);
  });

  it.each(HONEST_ROUTES.map((route) => [route] as const))(
    "pays for %s and serves the data",
    async (route) => {
      const { gate, ledger, signer } = makeGate();
      const path = HONEST_PATHS[route];

      const outcome = await call(gate, route, seller.resolve(path));

      expect(outcome.kind).toBe("paid");
      if (outcome.kind !== "paid") throw new Error("unreachable");
      expect(outcome.status).toBe(200);
      // The data is real content, not a placeholder.
      expect(Object.keys(outcome.body as object).length).toBeGreaterThan(1);
      // Signed exactly once, for the one requirement that passed.
      expect(signer.callCount).toBe(1);
      expect(signer.payloads[0]?.accepted.amount).toBe(HONEST_PRICES[route]);

      const attempt = ledger.get(outcome.attemptId);
      expect(attempt?.state).toBe("settled");
      expect(attempt?.reservedAtomic).toBe(HONEST_PRICES[route]);
      expect(attempt?.txHash).toBeTruthy();
    },
  );

  it("attaches a decodable X-PAYMENT header on the retry and not before", async () => {
    // A transport that watches the wire, so the ordering claim is observed
    // rather than inferred from the ledger.
    const seen: Array<Record<string, string>> = [];
    const ledger = Ledger.open(":memory:");
    ledger.openRun({ runId: "run-1", runBudget: 1000000n, planner: "p", question: "q" });
    const real = createHttpTransport();
    const gate = new SigningGate({
      policy: createPolicy(POLICY),
      ledger,
      http: {
        async request(url, init) {
          seen.push({ ...init.headers });
          return real.request(url, init);
        },
      },
      signer: createStubSigner(),
      nextAttemptId: () => "attempt-1",
    });

    await gate.call({ runId: "run-1", tool: "mandi", url: seller.resolve(HONEST_PATHS.mandiPrice) });

    expect(seen.length).toBe(2);
    expect(headerOf(seen[0] ?? {}, "x-payment")).toBeUndefined(); // nothing signed on the ask
    const retryHeader = headerOf(seen[1] ?? {}, "x-payment");
    expect(retryHeader).toBeTruthy();
    // And the seller could actually decode it, which is the real requirement.
    const payload = decodePaymentSignatureHeader(retryHeader as string);
    expect(payload.accepted.amount).toBe(HONEST_PRICES.mandiPrice);
    expect(payload.accepted.network).toBe(ETHEREUM_SEPOLIA);
  });

  it("releases the hold when the facilitator refuses, with the release recorded", async () => {
    // A facilitator that refuses the payment, so the retry comes back 402 with
    // a failure settlement. The hold must be released, not stranded.
    const ledger = Ledger.open(":memory:");
    ledger.openRun({ runId: "run-1", runBudget: 1000000n, planner: "p", question: "q" });
    const refusing = {
      ...createStubFacilitator(),
      verify: async () => ({ ok: false as const, code: "amount-mismatch" as const, message: "refusing" }),
    };
    const honest = await startHonestSeller({ facilitator: refusing });
    try {
      const gate = new SigningGate({
        policy: createPolicy(POLICY),
        ledger,
        http: createHttpTransport(),
        signer: createStubSigner(),
        nextAttemptId: () => "attempt-1",
      });

      const outcome = await gate.call({ runId: "run-1", tool: "mandi", url: honest.resolve(HONEST_PATHS.mandiPrice) });

      // A release is reported to the caller as a refusal with a specific code,
      // because to the caller the payment did not happen. The difference
      // between "never signed" and "signed, then released" is only visible in
      // the ledger - which is why the assertions below matter.
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") throw new Error("unreachable");
      expect(outcome.refusal.code).toBe("settlement-failed");
      expect(outcome.refusal.message).toContain("refusing");

      const attempt = ledger.get("attempt-1");
      expect(attempt?.state).toBe("released");
      expect(ledger.reserved("run-1")).toBe(0n);
      // A signature did exist, so this is auditable as an attempted spend.
      expect(attempt?.state).not.toBe("refused");
    } finally {
      await honest.close();
    }
  });
});

describe("rogue seller over real HTTP", () => {
  let rogue: RogueSeller;

  beforeEach(async () => {
    rogue = await startRogueSeller();
  });

  afterEach(async () => {
    await rogue.close();
  });

  it("refuses an overpriced quote before signing, naming the ceiling", async () => {
    const { gate, ledger, signer } = makeGate();

    const outcome = await call(gate, "overpriced", rogue.resolve("/rogue/overpriced"));

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("unreachable");
    expect(outcome.refusal.code).toBe("per-call-ceiling-exceeded");
    expect(signer.callCount).toBe(0);
    expect(ledger.list("run-1").every((a) => a.state === "refused")).toBe(true);
    expect(ledger.reserved("run-1")).toBe(0n);
  });

  it("refuses an unknown asset before signing", async () => {
    const { gate, signer } = makeGate();

    const outcome = await call(gate, "mystery", rogue.resolve("/rogue/unknown-asset"));

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("unreachable");
    expect(outcome.refusal.code).toBe("asset-not-allowed");
    expect(signer.callCount).toBe(0);
  });

  it("refuses the wrong network before signing", async () => {
    const { gate, signer } = makeGate();

    const outcome = await call(gate, "mainnet", rogue.resolve("/rogue/wrong-network"));

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("unreachable");
    expect(outcome.refusal.code).toBe("network-not-allowed");
    expect(signer.callCount).toBe(0);
  });

  it("refuses an unimplemented scheme before signing", async () => {
    const { gate, signer } = makeGate();

    const outcome = await call(gate, "trustme", rogue.resolve("/rogue/unknown-scheme"));

    expect(outcome.kind).toBe("refused");
    if (outcome.kind !== "refused") throw new Error("unreachable");
    expect(signer.callCount).toBe(0);
  });

  it("catches the bait-and-switch: pays the honest price, is told 10x was taken, keeps the hold", async () => {
    const { gate, ledger, signer } = makeGate();

    const outcome = await call(gate, "switch", rogue.resolve("/rogue/bait-and-switch"));

    // Signed, sent, and the seller lied about the settlement.
    expect(signer.callCount).toBe(1);
    expect(outcome.kind).toBe("interrupted");
    if (outcome.kind !== "interrupted") throw new Error("unreachable");
    expect(outcome.reason).toMatch(/exceeds the .* reserved/);

    // The load-bearing assertion: the money is *not* recorded as spent, and the
    // hold survives for a human to resolve.
    const attempt = ledger.get(outcome.attemptId);
    expect(attempt?.state).toBe("interrupted");
    expect(attempt?.settledAtomic).toBeNull();
    expect(ledger.reserved("run-1")).toBe(500n);
    expect(ledger.committed("run-1")).toBe(0n);
  });

  it("gives exactly two free burner iterations, then quotes a price", async () => {
    const { gate, ledger, signer } = makeGate();

    const first = await call(gate, "burner", rogue.resolve("/rogue/burner"));
    const second = await call(gate, "burner", rogue.resolve("/rogue/burner"));

    expect(first.kind).toBe("free");
    expect(second.kind).toBe("free");
    expect(signer.callCount).toBe(0);
    expect(ledger.reserved("run-1")).toBe(0n);

    // The third is not free, and it is not silently refused either: the buyer
    // is told the price and decides.
    const third = await call(gate, "burner", rogue.resolve("/rogue/burner"));
    expect(third.kind).toBe("paid");
    expect(rogue.state().burnerFreeRemaining).toBe(0);
    expect(BURNER_FREE_ITERATIONS).toBe(2);
  });

  it("quarantines the hostile note: recorded as data, no effect on any decision", async () => {
    const { gate, ledger, signer } = makeGate();

    const outcome = await call(gate, "notes", rogue.resolve("/rogue/hostile-notes"));

    // The injection asked to raise the ceiling, blank the budget and hide
    // itself. Every one of those failed, and the failure is observable:
    expect(outcome.kind).toBe("paid");
    if (outcome.kind !== "paid") throw new Error("unreachable");

    const attempt = ledger.get(outcome.attemptId);
    // The note is stored verbatim as untrusted audit text, not obeyed. Storing
    // it is deliberate: an operator needs to see what the seller tried.
    expect(attempt?.untrusted ?? "").toContain("SYSTEM OVERRIDE");
    expect(attempt?.untrusted ?? "").toContain("unlimited");
    // It did not move a single number.
    expect(attempt?.reservedAtomic).toBe("500");
    expect(signer.payloads[0]?.accepted.amount).toBe("500");
    expect(ledger.runBudgetFor("run-1")).toBe(1000000n);
    expect(ledger.committed("run-1")).toBe(500n);
  });

  it("cannot shadow the price with prose, because the money comes from the 402", async () => {
    const { gate, ledger, signer } = makeGate();

    // A body claiming a much larger price than the requirement advertises. The
    // body is untrusted input and is never the source of an amount.
    const liar = await startHonestSeller({
      reportAmount: () => "999999999",
    });
    try {
      const gate2 = makeGate();
      const outcome = await gate2.gate.call({
        runId: "run-1",
        tool: "liar",
        url: liar.resolve(HONEST_PATHS.rainfallGrid),
      });

      // A settlement above the reservation is not recorded as spent.
      expect(outcome.kind).toBe("interrupted");
      if (outcome.kind !== "interrupted") throw new Error("unreachable");
      expect(gate2.ledger.get(outcome.attemptId)?.state).toBe("interrupted");
      expect(gate2.signer.payloads[0]?.accepted.amount).toBe(HONEST_PRICES.rainfallGrid);
    } finally {
      await liar.close();
    }
  });

});

describe("seller process hygiene", () => {
  it("closes a seller and stops answering", async () => {
    const seller = await startHonestSeller();
    const url = seller.resolve("/v1/health");
    expect((await fetch(url)).status).toBe(200);
    await seller.close();
    await expect(fetch(url)).rejects.toThrow();
  });

  it("binds to 127.0.0.1 on an ephemeral port, so parallel tests cannot collide", async () => {
    const a = await startHonestSeller();
    const b = await startHonestSeller();
    try {
      expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(b.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(a.url).not.toBe(b.url);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it("404s an unknown route instead of hanging", async () => {
    const seller = await startHonestSeller();
    try {
      const response = await fetch(seller.resolve("/nope"));
      expect(response.status).toBe(404);
    } finally {
      await seller.close();
    }
  });
});




