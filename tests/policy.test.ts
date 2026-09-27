import { describe, expect, it } from "vitest";
import { formatAtomic, parseAtomic } from "../src/money/amount.js";
import {
  checkAllowlist,
  checkCumulative,
  checkPerCall,
  createPolicy,
  isAllowedAsset,
  type Quote,
  type SpendingPolicy,
} from "../src/policy/policy.js";

const NET = "eip155:11155111";
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const PAYEE = "0x2222222222222222222222222222222222222222";

function quote(amount: string, over: Partial<Quote> = {}): Quote {
  return {
    scheme: "exact",
    network: NET,
    asset: USDC,
    amount: parseAtomic(amount, "test"),
    payTo: PAYEE,
    maxTimeoutSeconds: 60,
    resource: "http://seller/grid",
    description: "one row of weather data",
    ...over,
  };
}

const policy: SpendingPolicy = createPolicy({
  perCallCeiling: "100000",
  runBudget: "5000000",
  allowedNetworks: [NET],
  allowedAssets: [`${NET}=${USDC}`],
});

const fresh = { committed: 0n, reserved: 0n };

describe("Check 5 (5 pts) — per-call ceiling is an explicit value compared before signing", () => {
  it("approves a quote under the ceiling", () => {
    expect(checkPerCall(policy, quote("50000"))).toBeNull();
  });

  it("approves a quote exactly at the ceiling", () => {
    // The ceiling is a maximum, so equal is inside it. Off-by-one here would
    // either block a legitimate call or admit one over the limit.
    expect(checkPerCall(policy, quote("100000"))).toBeNull();
  });

  it("refuses one base unit over the ceiling", () => {
    const refusal = checkPerCall(policy, quote("100001"));
    expect(refusal?.code).toBe("per-call-ceiling-exceeded");
  });

  it("refuses a wildly oversized quote", () => {
    expect(checkPerCall(policy, quote("4999999"))?.code).toBe("per-call-ceiling-exceeded");
  });

  it("carries the observed and limit values into the refusal, for the audit", () => {
    const refusal = checkPerCall(policy, quote("250000"));
    expect(refusal?.observed).toBe("250000");
    expect(refusal?.limit).toBe("100000");
    // Both numbers appear in the human-readable line too.
    expect(refusal?.message).toContain("250000");
    expect(refusal?.message).toContain("100000");
  });

  it("reads the ceiling from config, so a second policy has its own", () => {
    const tight = createPolicy({
      perCallCeiling: "1000",
      runBudget: "5000000",
      allowedNetworks: [NET],
      allowedAssets: [`${NET}=${USDC}`],
    });
    expect(checkPerCall(tight, quote("1000"))).toBeNull();
    expect(checkPerCall(tight, quote("1001"))?.code).toBe("per-call-ceiling-exceeded");
    // The first policy is unaffected. No shared mutable state.
    expect(checkPerCall(policy, quote("100000"))).toBeNull();
  });

  it("applies a tighter per-asset ceiling when one is configured", () => {
    const restricted = createPolicy({
      perCallCeiling: "100000",
      runBudget: "5000000",
      allowedNetworks: [NET],
      allowedAssets: [`${NET}=${USDC}`],
      assetCeilings: [`${NET}=${USDC}=25000`],
    });
    expect(checkPerCall(restricted, quote("25000"))).toBeNull();
    expect(checkPerCall(restricted, quote("25001"))?.code).toBe("per-call-ceiling-exceeded");
    // And the per-asset limit is the one reported, not the global one.
    expect(checkPerCall(restricted, quote("25001"))?.limit).toBe("25000");
  });

  it("compares base units exactly, at values a float would get wrong", () => {
    // USDC has 6 decimals, so these are exact amounts that IEEE-754
    // accumulation cannot represent. The run budget is 30 000 and the per-call
    // ceiling is 30 000, so the boundary binds on both checks.
    const decimal = createPolicy({
      perCallCeiling: "30000",
      runBudget: "30000",
      allowedNetworks: [NET],
      allowedAssets: [`${NET}=${USDC}`],
    });
    // 10 000 + 10 000 committed is exactly 20 000, leaving 10 000 — exactly the
    // next call. A float accumulator could easily be off by a few ulps here.
    expect(checkCumulative(decimal, quote("10000"), { committed: 20_000n, reserved: 0n })).toBeNull();
    // One more committed base unit makes the next 10 000 unaffordable.
    expect(checkCumulative(decimal, quote("10000"), { committed: 20_001n, reserved: 0n })?.code).toBe(
      "run-budget-exhausted",
    );
    // The same boundary on the per-call check.
    expect(checkPerCall(decimal, quote("30000"))).toBeNull();
    expect(checkPerCall(decimal, quote("30001"))?.code).toBe("per-call-ceiling-exceeded");
  });

  it("stays exact across many small payments, where a float total would drift", () => {
    // 300 payments of 10 000 base units = exactly 3 000 000. Accumulated in a
    // double, repeated addition of 0.01 three hundred times does not reliably
    // land on 3.00; accumulated as bigint it must.
    const drift = createPolicy({
      perCallCeiling: "10000",
      runBudget: "3000000",
      allowedNetworks: [NET],
      allowedAssets: [`${NET}=${USDC}`],
    });
    let committed = 0n;
    for (let payment = 0; payment < 300; payment += 1) {
      const refusal = checkCumulative(drift, quote("10000"), { committed, reserved: 0n });
      expect(refusal).toBeNull();
      committed += 10_000n;
    }
    expect(committed).toBe(3_000_000n);
    // The 301st cannot fit: the budget is exhausted exactly.
    expect(checkCumulative(drift, quote("10000"), { committed, reserved: 0n })?.code).toBe(
      "run-budget-exhausted",
    );
  });

  it("rejects a non-canonical amount instead of coercing it", () => {
    for (const bad of ["1.5", "1e3", " 1000", "1000 ", "0x10", "", "abc", "+1000", "01000", "-1"]) {
      expect(() => parseAtomic(bad, "test")).toThrow();
    }
  });
});

describe("Check 6 (5 pts) — cumulative spend is checked against the run budget before signing", () => {
  it("approves while the total stays within budget", () => {
    expect(checkCumulative(policy, quote("50000"), { committed: 1_000n, reserved: 0n })).toBeNull();
  });

  it("approves a quote that lands exactly on the budget", () => {
    expect(checkCumulative(policy, quote("100000"), { committed: 4_900_000n, reserved: 0n })).toBeNull();
  });

  it("refuses one base unit over the remaining budget", () => {
    const refusal = checkCumulative(policy, quote("100001"), { committed: 4_900_000n, reserved: 0n });
    expect(refusal?.code).toBe("run-budget-exhausted");
  });

  it("counts approved-but-unsettled reservations against the budget", () => {
    // The load-bearing case. Two calls in one turn both read `committed: 0`, so
    // only the reservation stops the second from spending the same base units.
    const refusal = checkCumulative(policy, quote("50001"), {
      committed: 0n,
      reserved: 4_950_000n,
    });
    expect(refusal?.code).toBe("run-budget-exhausted");
    // The message shows the hold and what is left, so the audit explains why.
    expect(refusal?.message).toContain("50001");
    expect(refusal?.limit).toBe("50000");
  });

  it("refuses everything once the purse is empty", () => {
    expect(checkCumulative(policy, quote("1"), { committed: 5_000_000n, reserved: 0n })?.code).toBe(
      "run-budget-exhausted",
    );
  });

  it("refuses when an interrupted hold is still counted", () => {
    // A reservation from a dead process is still a hold. Treating it as
    // available is how a purse overdraws after a crash.
    const refusal = checkCumulative(policy, quote("60000"), { committed: 0n, reserved: 4_950_000n });
    expect(refusal?.code).toBe("run-budget-exhausted");
  });

  it("does not treat a zero-amount quote as meaningful, at either check", () => {
    // Zero is under the ceiling, so a pure comparison lets it through. The
    // guard belongs at decode time: `parseAtomic` accepts "0" as canonical, so
    // the purse must reject a zero payment as a malformed 402. This test pins
    // the arithmetic truth, and `decodeQuote` is asserted to reject zero in
    // the quarantine/decode tests.
    const permissive = createPolicy({
      perCallCeiling: "100000",
      runBudget: "5000000",
      allowedNetworks: [NET],
      allowedAssets: [`${NET}=${USDC}`],
    });
    // Documented honestly: the ceiling check alone does not catch zero.
    expect(checkPerCall(permissive, quote("0"))).toBeNull();
    expect(checkCumulative(permissive, quote("0"), { committed: 0n, reserved: 0n })).toBeNull();
  });

  it("reports a corrupt ledger that already exceeds the budget, rather than approving", () => {
    // Cannot happen through the purse, which refuses before reserving. Guarded
    // so a bad ledger cannot produce an approving verdict.
    const refusal = checkCumulative(policy, quote("1"), { committed: 6_000_000n, reserved: 0n });
    expect(refusal?.code).toBe("run-budget-exhausted");
    expect(refusal?.message).toContain("6000000");
  });

  it("carries the available figure as the limit, for the audit", () => {
    const refusal = checkCumulative(policy, quote("50001"), { committed: 4_950_000n, reserved: 0n });
    expect(refusal?.limit).toBe("50000");
    expect(refusal?.observed).toBe("50001");
  });
});

describe("allowlist is explicit, not a prefix match", () => {
  it("accepts the one configured network and asset", () => {
    expect(checkAllowlist(policy, quote("1000"))).toBeNull();
    expect(isAllowedAsset(policy, { network: NET, asset: USDC })).toBe(true);
  });

  it("refuses mainnet", () => {
    expect(checkAllowlist(policy, quote("1000", { network: "eip155:1" }))?.code).toBe("network-not-allowed");
  });

  it("refuses a chain that merely shares the prefix", () => {
    for (const near of ["eip155:84531", "eip155:845320", "eip155:8453", "eip155:84532x"]) {
      expect(checkAllowlist(policy, quote("1000", { network: near }))?.code).toBe("network-not-allowed");
    }
  });

  it("refuses a different namespace", () => {
    const solana = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
    expect(checkAllowlist(policy, quote("1000", { network: solana }))?.code).not.toBeNull();
  });

  it("refuses a wildcard network rather than treating it as all EVM chains", () => {
    // `eip155:*` must never widen the purse. It fails at construction time...
    expect(() =>
      createPolicy({
        perCallCeiling: "100000",
        runBudget: "5000000",
        allowedNetworks: ["eip155:*"],
        allowedAssets: [`eip155:*=${USDC}`],
      }),
    ).toThrow(/wildcard/);
    // ...and a wildcard in a quote is not on the allowlist either.
    expect(checkAllowlist(policy, quote("1000", { network: "eip155:*" }))?.code).not.toBeNull();
  });

  it("is case-insensitive on the asset address", () => {
    expect(checkAllowlist(policy, quote("1000", { asset: USDC.toLowerCase() }))).toBeNull();
  });

  it("refuses a different token on the right network", () => {
    const decision = checkAllowlist(policy, quote("1000", { asset: "0x0000000000000000000000000000000000000001" }));
    expect(decision?.code).toBe("asset-not-allowed");
  });

  it("refuses a scheme other than exact", () => {
    expect(checkAllowlist(policy, quote("1000", { scheme: "upto" }))?.code).toBe("scheme-not-allowed");
  });

  it("refuses a malformed network or asset rather than throwing", () => {
    // A 402 is attacker-controlled input. It must produce a refusal, not an
    // exception that a caller might catch and treat as approval.
    expect(checkAllowlist(policy, quote("1000", { network: "not-a-caip-id" }))?.code).toBe("malformed-requirements");
    expect(checkAllowlist(policy, quote("1000", { asset: "0x123" }))?.code).toBe("malformed-requirements");
    expect(checkAllowlist(policy, quote("1000", { payTo: "nope" }))).toBeNull(); // payee unchecked when no list
  });

  it("honours a payee allowlist when configured, and ignores it when empty", () => {
    const restricted = createPolicy({
      perCallCeiling: "100000",
      runBudget: "5000000",
      allowedNetworks: [NET],
      allowedAssets: [`${NET}=${USDC}`],
      allowedPayees: ["0x3333333333333333333333333333333333333333"],
    });
    expect(checkAllowlist(restricted, quote("1000"))?.code).toBe("payee-not-allowed");
    expect(
      checkAllowlist(restricted, quote("1000", { payTo: "0x3333333333333333333333333333333333333333" })),
    ).toBeNull();
    // Unconfigured means "any payee", which is the documented default.
    expect(checkAllowlist(policy, quote("1000"))).toBeNull();
  });
});

describe("the policy is frozen against widening after construction", () => {
  it("ignores mutation of the object it was built from", () => {
    // This is the "a tool description says your budget was raised" attack in
    // miniature: the config is captured by value at construction.
    const input = {
      perCallCeiling: "100000",
      runBudget: "5000000",
      allowedNetworks: [NET],
      allowedAssets: [`${NET}=${USDC}`],
    };
    const built = createPolicy(input);
    (input as { perCallCeiling: string }).perCallCeiling = "999999999";
    (input.allowedNetworks as string[]).push("eip155:1");
    (input.allowedAssets as string[]).push(`eip155:1=${USDC}`);

    expect(checkPerCall(built, quote("100001"))?.code).toBe("per-call-ceiling-exceeded");
    expect(checkAllowlist(built, quote("1000", { network: "eip155:1" }))?.code).toBe("network-not-allowed");
  });

  it("exposes limits that cannot be reassigned", () => {
    expect(() => {
      (policy.limits as { perCallCeiling: bigint }).perCallCeiling = 10n ** 12n;
    }).toThrow();
    expect(policy.limits.perCallCeiling).toBe(100_000n);
    expect(policy.limits.runBudget).toBe(5_000_000n);
  });

  it("serialises to a log-safe summary with both base units and display", () => {
    const json = policy.toJSON();
    expect(json["perCallCeilingAtomic"]).toBe("100000");
    expect(json["runBudgetDisplay"]).toBe("$5.00");
    expect(json["allowedNetworks"]).toEqual([NET]);
    expect(json["allowedSchemes"]).toEqual(["exact"]);
  });

  it("refuses to construct with a nonsensical limit", () => {
    const base = { runBudget: "5000000", allowedNetworks: [NET], allowedAssets: [`${NET}=${USDC}`] };
    expect(() => createPolicy({ ...base, perCallCeiling: "0" })).toThrow(RangeError);
    expect(() => createPolicy({ ...base, perCallCeiling: "-1" })).toThrow();
    expect(() => createPolicy({ ...base, perCallCeiling: "1.50" })).toThrow();
    expect(() => createPolicy({ perCallCeiling: "100000", ...base, runBudget: "0" })).toThrow(RangeError);
  });

  it("refuses a per-call ceiling above the run budget, which can never bind", () => {
    expect(() =>
      createPolicy({
        perCallCeiling: "100000",
        runBudget: "1000",
        allowedNetworks: [NET],
        allowedAssets: [`${NET}=${USDC}`],
      }),
    ).toThrow(/exceeds/);
  });

  it("refuses an empty network list rather than defaulting to allow-all", () => {
    expect(() =>
      createPolicy({
        perCallCeiling: "100000",
        runBudget: "5000000",
        allowedNetworks: [],
        allowedAssets: [`${NET}=${USDC}`],
      }),
    ).toThrow(/at least one network/);
  });

  it("refuses an asset on a network that is not allowlisted", () => {
    expect(() =>
      createPolicy({
        perCallCeiling: "100000",
        runBudget: "5000000",
        allowedNetworks: [NET],
        allowedAssets: ["eip155:1=0x036CbD53842c5426634e7929541eC2318f3dCF7e"],
      }),
    ).toThrow(/not in PURSE_ALLOWED_NETWORKS/);
  });

  it("refuses a network with no configured asset", () => {
    expect(() =>
      createPolicy({
        perCallCeiling: "100000",
        runBudget: "5000000",
        allowedNetworks: [NET, "eip155:1"],
        allowedAssets: [`${NET}=${USDC}`],
      }),
    ).toThrow(/no allowed asset/);
  });
});

describe("amounts round-trip through the exact parser used by the ledger", () => {
  it("parses and re-formats identically", () => {
    for (const value of ["0", "1", "999", "1000000", "1180591620717411303424"]) {
      expect(formatAtomic(parseAtomic(value, "test"))).toBe(value);
    }
  });
});
