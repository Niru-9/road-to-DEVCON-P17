/**
 * Ethereum Sepolia configuration for the purse.
 *
 * ## What this pins
 *
 * The project moved from a Base testnet to Ethereum Sepolia
 * (`eip155:11155111`) so it can settle through the configured facilitator, which
 * advertises x402 v2 `exact` on that network. Three things are asserted here
 * rather than assumed:
 *
 * 1. **The allowlist is Sepolia + Circle USDC only.** A wallet-keyed lookalike
 *    on another network, or the old Base asset, must be refused.
 * 2. **Amounts are integer base units.** There is no SDK default asset for
 *    Ethereum Sepolia, so nothing here may fall back to a dollar string.
 * 3. **The rogue stall's abuse still bites on the new chain** - the
 *    over-priced quote is still far above the per-call ceiling, and the
 *    wrong-network route is still genuinely off-allowlist.
 *
 * ## What this does NOT claim
 *
 * Nothing here moves money. The signer and facilitator are local stubs, so a
 * `settled-stub` label means a local policy and protocol decision and nothing
 * else. Real Sepolia settlement is unverified.
 */
import { describe, expect, it } from "vitest";
import {
  ALLOWED_SCHEMES,
  EIP712_NAME,
  EIP712_VERSION,
  ETHEREUM_SEPOLIA,
  ETHEREUM_SEPOLIA_USDC,
  defaultAllowlist,
  normaliseNetwork,
  parseAssetRef,
} from "../src/policy/allowlist.js";
import { loadConfig } from "../src/config/env.js";
import { ETHEREUM_SEPOLIA as WIRE_NETWORK, ETHEREUM_SEPOLIA_USDC as WIRE_USDC } from "../src/seller/wire.js";
import { HONEST_PRICES } from "../src/seller/honest.js";

/** No payer key and no payTo: the shipped default, and the only state this project supports. */
const CONFIG = {} as NodeJS.ProcessEnv;

describe("the purse is configured for Ethereum Sepolia", () => {
  it("allowlists exactly eip155:11155111", () => {
    expect(ETHEREUM_SEPOLIA).toBe("eip155:11155111");
    expect(WIRE_NETWORK).toBe("eip155:11155111");
    // Policy and sellers must not disagree about the chain, or the honest stall
    // would quote something the agent refuses to pay.
    const allowlist = defaultAllowlist();
    expect([...allowlist.networks]).toEqual(["eip155:11155111"]);
  });

  it("refuses the networks this project used before", () => {
    const allowlist = defaultAllowlist();
    for (const gone of ["eip155:84532", "eip155:8453", "eip155:1"]) {
      expect(allowlist.networks.has(normaliseNetwork(gone))).toBe(false);
    }
  });

  it("allowlists Circle Sepolia USDC and nothing else", () => {
    const allowlist = defaultAllowlist();
    const assets = allowlist.assetsByNetwork.get("eip155:11155111");
    expect(assets).toBeDefined();
    expect([...(assets as ReadonlySet<string>)]).toEqual([
      "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
    ]);
    // The Base asset must no longer be payable.
    expect(allowlist.assetsByNetwork.get("eip155:11155111")!.has("0x036cbd53842c5426634e7929541ec2318f3dcf7e")).toBe(
      false,
    );
  });

  it("the policy and the test sellers name the same asset", () => {
    // A mismatch here would be a silent, permanent failure: every honest quote
    // refused by the agent, with no error anywhere.
    expect(WIRE_USDC.toLowerCase()).toBe(ETHEREUM_SEPOLIA_USDC);
    expect(parseAssetRef(`${ETHEREUM_SEPOLIA}=${WIRE_USDC}`)).toEqual({
      network: "eip155:11155111",
      asset: "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238",
    });
  });

  it("only ever honours the exact scheme", () => {
    expect(ALLOWED_SCHEMES).toEqual(["exact"]);
  });

  it("defaults to Sepolia USDC, and enables no real payment without a payer key", () => {
    const config = loadConfig(CONFIG);
    expect([...config.policy.allowlist.networks]).toEqual(["eip155:11155111"]);
    expect(config.allowedSellerHosts.length).toBeGreaterThan(0);
    // `payment` is non-null only when BOTH a payer private key and a payTo are
    // configured. This project deliberately ships no payer key, so real payment
    // stays off and every run is the labelled local simulation. Asserted so a
    // future change cannot quietly turn a stub run into a real one.
    expect(config.payment, "no payer key => no real payment path").toBeNull();
    // The loader refuses a payTo without a matching payer key, so real payment
    // cannot be switched on by configuration alone.
    expect(() =>
      loadConfig({ X402_PAY_TO: "0x5555555555555555555555555555555555555555" } as NodeJS.ProcessEnv),
    ).toThrow(/both EVM_PRIVATE_KEY and X402_PAY_TO/);
  });

  it("the default facilitator is the one that serves Ethereum Sepolia", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/config/env.ts", import.meta.url), "utf8");
    expect(source).toContain('X402_FACILITATOR_URL: z.string().url().default("https://facilitator.x402.rs")');
    expect(source).not.toContain("x402.org/facilitator");
  });

  it("uses the EIP-712 domain read from the contract", () => {
    expect(EIP712_NAME).toBe("USDC");
    expect(EIP712_VERSION).toBe("2");
  });
});

describe("amounts are integer base units", () => {
  it("keeps the honest prices as exact integers at 6 decimals", () => {
    // Unchanged by the migration: 500 / 1000 / 2500 / 10000 base units.
    expect(HONEST_PRICES).toEqual({
      rainfallGrid: "500",
      mandiPrice: "1000",
      satelliteSummary: "2500",
      monsoonAdvisory: "10000",
    });
    for (const amount of Object.values(HONEST_PRICES)) {
      expect(amount).toMatch(/^\d+$/);
      expect(BigInt(amount)).toBeGreaterThan(0n);
    }
  });

  it("the rogue over-price still clears the per-call ceiling decisively", () => {
    const config = loadConfig(CONFIG);
    const ceiling = config.policy.limits.perCallCeiling;
    const OVERPRICED = 5_000_000n;
    // 200x. If this ever fell under the ceiling the attack would simply be paid
    // and the test suite would prove nothing about the ceiling.
    expect(OVERPRICED).toBeGreaterThan(ceiling * 100n);
  });

  it("no dollar string is used as a price anywhere in the money path", async () => {
    const { readFileSync } = await import("node:fs");
    const files = [
      "src/seller/honest.ts",
      "src/seller/rogue.ts",
      "src/seller/wire.ts",
      "src/policy/policy.ts",
    ];
    for (const file of files) {
      const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
      // A `$0.00`-shaped literal would be a price the SDK would have to resolve
      // against a default-asset table that has no entry for Sepolia.
      expect(source, `${file} must not price with a dollar string`).not.toMatch(/price:\s*"\$/);
    }
  });
});

describe("the rogue stall still abuses on the new chain", () => {
  it("its wrong-network route targets a chain that is genuinely off-allowlist", async () => {
    // `/rogue/wrong-network` quotes WRONG_NETWORK in src/seller/rogue.ts. Assert
    // against the source so this test breaks if someone "fixes" the rogue route
    // to quote Sepolia, which would quietly turn the attack into a valid payment.
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/seller/rogue.ts", import.meta.url), "utf8");
    const match = /const WRONG_NETWORK = "([^"]+)"/.exec(source);
    expect(match, "rogue.ts must declare WRONG_NETWORK").not.toBeNull();
    const wrongNetwork = match![1] as string;
    expect(normaliseNetwork(wrongNetwork)).not.toBe("eip155:11155111");
    expect(defaultAllowlist().networks.has(normaliseNetwork(wrongNetwork))).toBe(false);
  });

  it("its unknown-asset route targets a token that is genuinely off-allowlist", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync(new URL("../src/seller/rogue.ts", import.meta.url), "utf8");
    const match = /const MYSTERY_ASSET = `0x\$\{"b0"\.repeat\(20\)\}`/.exec(source);
    expect(match, "rogue.ts must declare MYSTERY_ASSET").not.toBeNull();
    const assets = defaultAllowlist().assetsByNetwork.get("eip155:11155111") as ReadonlySet<string>;
    expect(assets.has(`0x${"b0".repeat(20)}`)).toBe(false);
  });
});
