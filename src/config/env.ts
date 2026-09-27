/**
 * Configuration, read from the environment at startup and frozen.
 *
 * This is the only place environment variables are read. The policy is built
 * here and handed to the purse as a finished object, so no tool, no tool
 * argument and no model output can reach a limit: by the time the agent loop
 * exists, the numbers are already decided and frozen.
 */

import { z } from "zod";
import { parseAtomic } from "../money/amount.js";
import { ETHEREUM_SEPOLIA, ETHEREUM_SEPOLIA_USDC } from "../policy/allowlist.js";
import { createPolicy, type SpendingPolicy } from "../policy/policy.js";

/** `eip155:11155111,eip155:1` → `["eip155:84532", "eip155:1"]` */
function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

const RawEnv = z.object({
  PURSE_PER_CALL_CEILING: z.string().regex(/^(?:0|[1-9][0-9]*)$/, {
    message: "must be a base-unit integer, e.g. 25000 for $0.025",
  }),
  PURSE_RUN_BUDGET: z.string().regex(/^(?:0|[1-9][0-9]*)$/, {
    message: "must be a base-unit integer, e.g. 5000000 for $5.00",
  }),
  PURSE_ALLOWED_NETWORKS: z.string().min(1),
  PURSE_ALLOWED_ASSETS: z.string().min(1),
  PURSE_ALLOWED_SCHEMES: z.string().optional(),
  PURSE_ALLOWED_PAYEES: z.string().optional(),
  PURSE_ASSET_CEILINGS: z.string().optional(),
  PURSE_LEDGER_PATH: z.string().min(1).default("./data/purse.sqlite"),
  EVM_PRIVATE_KEY: z.string().optional(),
  X402_PAY_TO: z.string().optional(),
  X402_FACILITATOR_URL: z.string().url().default("https://facilitator.x402.rs"),
  LLM_BASE_URL: z.string().url().optional(),
  LLM_API_KEY: z.string().optional(),
  LLM_MODEL: z.string().optional(),
  PURSE_PLANNER: z.enum(["scripted", "llm"]).default("scripted"),
  AGENT_ALLOWED_SELLER_HOSTS: z.string().min(1).default("127.0.0.1"),
  // No stall port setting, deliberately. `HONEST_STALL_PORT` / `ROGUE_STALL_PORT`
  // used to be parsed here and then read by nobody, which made `.env.example`
  // document a knob that did nothing. Ephemeral ports are what the sellers use:
  // they are printed when the run starts, they let two demos coexist, and
  // `startPurseRuntime` pins whatever was actually bound.
});

export interface PurseConfig {
  readonly policy: SpendingPolicy;
  readonly ledgerPath: string;
  readonly planner: "scripted" | "llm";
  readonly llm:
    | { readonly baseUrl: string; readonly apiKey: string; readonly model: string }
    | null;
  /**
   * Hosts the `paid_fetch` tool may reach.
   *
   * Separate from the x402 asset allowlist: that one decides what the purse will
   * *spend* on, this one decides where it will *go*. Defaulted to loopback
   * because the demo sellers run locally; a real deployment must set this
   * explicitly, or `paid_fetch` is an unrestricted client.
   */
  readonly allowedSellerHosts: readonly string[];
  readonly payment:
    | {
        readonly privateKey: `0x${string}`;
        readonly payTo: `0x${string}`;
        readonly facilitatorUrl: string;
      }
    | null;
}

/** Raised for a configuration problem, with the variable named. */
export class ConfigError extends Error {
  constructor(variable: string, detail: string) {
    super(`${variable}: ${detail}`);
    this.name = "ConfigError";
  }
}

/**
 * Read the environment into a frozen configuration.
 *
 * `source` is injectable so the test suite can drive the loader without mutating
 * `process.env`, which would make tests order-dependent.
 */
export function loadConfig(source: NodeJS.ProcessEnv = process.env): PurseConfig {
  const parsed = RawEnv.safeParse({
    PURSE_PER_CALL_CEILING: source.PURSE_PER_CALL_CEILING ?? "25000",
    PURSE_RUN_BUDGET: source.PURSE_RUN_BUDGET ?? "5000000",
    PURSE_ALLOWED_NETWORKS: source.PURSE_ALLOWED_NETWORKS ?? ETHEREUM_SEPOLIA,
    PURSE_ALLOWED_ASSETS:
      source.PURSE_ALLOWED_ASSETS ??
      `${ETHEREUM_SEPOLIA}=${ETHEREUM_SEPOLIA_USDC}`,
    PURSE_ALLOWED_SCHEMES: source.PURSE_ALLOWED_SCHEMES,
    PURSE_ALLOWED_PAYEES: source.PURSE_ALLOWED_PAYEES,
    PURSE_ASSET_CEILINGS: source.PURSE_ASSET_CEILINGS,
    PURSE_LEDGER_PATH: source.PURSE_LEDGER_PATH,
    EVM_PRIVATE_KEY: source.EVM_PRIVATE_KEY,
    X402_PAY_TO: source.X402_PAY_TO,
    X402_FACILITATOR_URL: source.X402_FACILITATOR_URL,
    LLM_BASE_URL: source.LLM_BASE_URL,
    LLM_API_KEY: source.LLM_API_KEY,
    LLM_MODEL: source.LLM_MODEL,
    PURSE_PLANNER: source.PURSE_PLANNER,
    AGENT_ALLOWED_SELLER_HOSTS: source.AGENT_ALLOWED_SELLER_HOSTS,
  });

  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ConfigError(first?.path.join(".") ?? "config", first?.message ?? "invalid");
  }
  const raw = parsed.data;

  // Throws on a wildcard, a malformed address, or a ceiling above the budget.
  const policy = createPolicy({
    perCallCeiling: raw.PURSE_PER_CALL_CEILING,
    runBudget: raw.PURSE_RUN_BUDGET,
    allowedNetworks: splitList(raw.PURSE_ALLOWED_NETWORKS),
    allowedAssets: splitList(raw.PURSE_ALLOWED_ASSETS),
    allowedSchemes: raw.PURSE_ALLOWED_SCHEMES === undefined ? undefined : splitList(raw.PURSE_ALLOWED_SCHEMES),
    allowedPayees: raw.PURSE_ALLOWED_PAYEES === undefined ? undefined : splitList(raw.PURSE_ALLOWED_PAYEES),
    assetCeilings:
      raw.PURSE_ASSET_CEILINGS === undefined ? undefined : splitList(raw.PURSE_ASSET_CEILINGS),
  });

  // A payment config is only complete if the key is a real-looking key. The
  // `0x000…0` placeholder in .env.example is treated as absent rather than as a
  // key that would be rejected deep inside viem.
  const rawKey = raw.EVM_PRIVATE_KEY?.trim();
  const rawPayTo = raw.X402_PAY_TO?.trim();
  const hasKey = rawKey !== undefined && /^0x[0-9a-fA-F]{64}$/.test(rawKey) && !/^0x0+$/.test(rawKey);
  const hasPayTo =
    rawPayTo !== undefined && /^0x[0-9a-fA-F]{40}$/.test(rawPayTo) && !/^0x0+$/.test(rawPayTo);

  let payment: PurseConfig["payment"] = null;
  if (hasKey !== hasPayTo) {
    throw new ConfigError(
      hasKey ? "X402_PAY_TO" : "EVM_PRIVATE_KEY",
      "both EVM_PRIVATE_KEY and X402_PAY_TO are needed to settle, or neither. " +
        "Refusals and policy checks work without them.",
    );
  }
  if (hasKey && hasPayTo) {
    payment = Object.freeze({
      privateKey: rawKey as `0x${string}`,
      payTo: rawPayTo as `0x${string}`,
      facilitatorUrl: raw.X402_FACILITATOR_URL,
    });
  }

  const planner = raw.PURSE_PLANNER;
  const llm =
    planner === "llm" && raw.LLM_BASE_URL !== undefined && raw.LLM_API_KEY !== undefined
      ? Object.freeze({
          baseUrl: raw.LLM_BASE_URL,
          apiKey: raw.LLM_API_KEY,
          model: raw.LLM_MODEL ?? "gpt-4o-mini",
        })
      : null;
  if (planner === "llm" && llm === null) {
    throw new ConfigError(
      "LLM_API_KEY",
      "PURSE_PLANNER=llm needs LLM_BASE_URL and LLM_API_KEY. Use PURSE_PLANNER=scripted to run without a key.",
    );
  }

  const allowedSellerHosts = splitList(raw.AGENT_ALLOWED_SELLER_HOSTS);
  if (allowedSellerHosts.length === 0) {
    throw new ConfigError(
      "AGENT_ALLOWED_SELLER_HOSTS",
      "at least one host is required. An empty list would make paid_fetch an " +
        "unrestricted fetch client, which is a server-side request forgery primitive.",
    );
  }

  return Object.freeze({
    policy,
    ledgerPath: raw.PURSE_LEDGER_PATH,
    planner,
    llm,
    payment,
    allowedSellerHosts: Object.freeze(allowedSellerHosts),
  });
}

/** The policy's limits, for the run report. */
export function limitsOf(config: PurseConfig): { perCall: string; run: string } {
  return {
    perCall: parseAtomic(config.policy.limits.perCallCeiling.toString()).toString(),
    run: parseAtomic(config.policy.limits.runBudget.toString()).toString(),
  };
}
