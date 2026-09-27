/**
 * Spending policy: the rules, and the verdict they produce.
 *
 * This module is **trusted code**. It has no dependency on the agent loop, the
 * LLM client, the tool schema or the ledger, and nothing in it can be reached
 * from a tool argument. That is deliberate and it is the answer to
 * "where must spending policy live so that a model cannot talk its way past it":
 * here, where the model has no vocabulary to reach it with.
 *
 * A policy is frozen on construction. There is no setter, no reload and no
 * merge-from-anywhere, so a tool that tried to widen a limit would be assigning
 * to a frozen object — which throws in strict mode rather than succeeding
 * quietly.
 */

import type { Atomic } from "../money/amount.js";
import { exceedsAtomic, formatAtomic, formatUsd, parseAtomic } from "../money/amount.js";
import {
  type AssetCeiling,
  type AssetRef,
  defaultAllowlist,
  describeAllowlist,
  normaliseAsset,
  normaliseNetwork,
} from "./allowlist.js";

/**
 * Every way the agent can say no, as a stable machine-readable code.
 *
 * These strings appear in the ledger and in the decision record, so a reader can
 * group refusals by cause. They are part of the audit format, not log prose.
 */
/**
 * Every reason a payment attempt can be refused, in one vocabulary.
 *
 * The first eight are policy decisions about a quote. The last four are
 * outcomes of attempting it: the endpoint never asked for money, the ledger
 * would not hold the amount, a signature could not be produced, or the
 * facilitator reported the settlement as failed. They are listed here rather
 * than invented ad hoc at the call site so the morning-after summary can count
 * every refusal reason from one closed set.
 */
export const REFUSAL_CODES = [
  "malformed-requirements",
  "no-acceptable-requirement",
  "scheme-not-allowed",
  "network-not-allowed",
  "asset-not-allowed",
  "per-call-ceiling-exceeded",
  "run-budget-exhausted",
  "payee-not-allowed",
  // Outcomes of attempting an approved quote.
  "not-a-payment",
  "reservation-refused",
  "signing-failed",
  "settlement-failed",
  // The destination was refused, or the socket could not be opened, *before* any
  // signature existed. Nothing was signed and nothing was held, so this is a
  // refusal rather than an interruption.
  "transport-refused",
] as const;

export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** Why a policy refused. `code` is machine-readable; `message` is for a human. */
export interface Refusal {
  readonly code: RefusalCode;
  readonly message: string;
  /** The rule that fired, in the units the operator configured. */
  readonly observed?: string;
  readonly limit?: string;
}

/** The limits, as configured. Every amount is base units. */
export interface PolicyLimits {
  /** Ceiling for one call. `$0.025` = 25 000 base units. */
  readonly perCallCeiling: Atomic;
  /** Ceiling for the whole run. `$5.00` = 5 000 000 base units. */
  readonly runBudget: Atomic;
  /** Optional tighter ceilings for specific `(network, asset)` pairs. */
  readonly assetCeilings: readonly AssetCeiling[];
}

/** The frozen policy object handed to the purse. */
export interface SpendingPolicy {
  readonly limits: PolicyLimits;
  readonly allowlist: {
    readonly networks: ReadonlySet<string>;
    readonly assetsByNetwork: ReadonlyMap<string, ReadonlySet<string>>;
    readonly schemes: ReadonlySet<string>;
  };
  /** Optional payee restriction, as a set of lowercase addresses. */
  readonly allowedPayees: ReadonlySet<string>;
  /** A one-line summary for the audit record. */
  describe(): string;
  /** A structured, log-safe summary. */
  toJSON(): Record<string, unknown>;
}

/** A single payment requirement, as decoded from a 402. */
export interface Quote {
  readonly scheme: string;
  readonly network: string;
  readonly asset: string;
  readonly amount: Atomic;
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  /** Where the requirement came from, for the audit trail. */
  readonly resource: string;
  readonly description: string;
}

/** The quote plus what the budget looked like at the moment of the decision. */
export interface DecisionContext {
  /** Base units already settled in this run. */
  readonly committed: Atomic;
  /** Base units currently held by unresolved reservations. */
  readonly reserved: Atomic;
}

export type Verdict =
  | { readonly allowed: true; readonly quote: Quote; readonly context: DecisionContext }
  | { readonly allowed: false; readonly refusal: Refusal; readonly context: DecisionContext };

export interface CreatePolicyInput {
  readonly perCallCeiling: string;
  readonly runBudget: string;
  readonly allowedNetworks: readonly string[];
  readonly allowedAssets: readonly string[];
  readonly allowedSchemes?: readonly string[] | undefined;
  readonly allowedPayees?: readonly string[] | undefined;
  readonly assetCeilings?: readonly string[] | undefined;
}

/**
 * Build a frozen policy from configuration strings.
 *
 * Every limit arrives as a decimal string and is parsed to `bigint` here, at the
 * boundary. Nothing downstream re-parses an amount.
 */
export function createPolicy(input: CreatePolicyInput): SpendingPolicy {
  const perCallCeiling = parseAtomic(input.perCallCeiling, "PURSE_PER_CALL_CEILING");
  const runBudget = parseAtomic(input.runBudget, "PURSE_RUN_BUDGET");

  if (perCallCeiling <= 0n) {
    throw new RangeError("PURSE_PER_CALL_CEILING must be greater than zero");
  }
  if (runBudget <= 0n) {
    throw new RangeError("PURSE_RUN_BUDGET must be greater than zero");
  }
  if (perCallCeiling > runBudget) {
    // Not fatal, but almost certainly a mistake: a per-call ceiling above the
    // whole budget means the run budget can never bind.
    throw new RangeError(
      `PURSE_PER_CALL_CEILING (${formatAtomic(perCallCeiling)}) exceeds PURSE_RUN_BUDGET (${formatAtomic(runBudget)})`,
    );
  }

  const defaults = defaultAllowlist();
  const networks = new Set<string>();
  for (const network of input.allowedNetworks) {
    const normalised = normaliseNetwork(network);
    if (normalised.includes("*")) {
      throw new RangeError(
        `PURSE_ALLOWED_NETWORKS may not contain a wildcard: ${JSON.stringify(network)}`,
      );
    }
    if (!networks.has(normalised)) networks.add(normalised);
  }
  if (networks.size === 0) {
    throw new RangeError("PURSE_ALLOWED_NETWORKS must name at least one network");
  }

  const assetsByNetwork = new Map<string, Set<string>>();
  for (const spec of input.allowedAssets) {
    const separator = spec.indexOf("=");
    if (separator === -1) {
      throw new Error(
        `PURSE_ALLOWED_ASSETS entry must be "network=0xaddress", received ${JSON.stringify(spec)}`,
      );
    }
    const network = normaliseNetwork(spec.slice(0, separator));
    const asset = normaliseAsset(spec.slice(separator + 1));
    if (!networks.has(network)) {
      throw new RangeError(
        `asset ${spec} names network ${network}, which is not in PURSE_ALLOWED_NETWORKS`,
      );
    }
    let assets = assetsByNetwork.get(network);
    if (assets === undefined) {
      assets = new Set<string>();
      assetsByNetwork.set(network, assets);
    }
    assets.add(asset);
  }
  for (const network of networks) {
    if (!assetsByNetwork.has(network)) {
      throw new RangeError(`no allowed asset configured for network ${network}`);
    }
  }

  const schemes = new Set<string>();
  for (const scheme of input.allowedSchemes ?? defaults.schemes) {
    schemes.add(scheme.trim().toLowerCase());
  }
  if (schemes.size === 0) {
    throw new RangeError("at least one payment scheme must be allowed");
  }

  const payees = new Set<string>();
  for (const payee of input.allowedPayees ?? []) {
    payees.add(normaliseAsset(payee));
  }

  const assetCeilings: AssetCeiling[] = [];
  for (const spec of input.assetCeilings ?? []) {
    const parts = spec.split("=");
    if (parts.length !== 3) {
      throw new Error(
        `asset ceiling must be "network=0xaddress=baseUnits", received ${JSON.stringify(spec)}`,
      );
    }
    const [network, asset, ceiling] = parts as [string, string, string];
    assetCeilings.push({
      ref: { network: normaliseNetwork(network), asset: normaliseAsset(asset) },
      ceiling: parseAtomic(ceiling, `asset ceiling for ${network}`),
    });
  }

  const frozenAssets = new Map<string, ReadonlySet<string>>(
    [...assetsByNetwork.entries()].map(([network, set]) => [network, Object.freeze(new Set(set))]),
  );
  const allowlist = Object.freeze({
    networks: Object.freeze(new Set(networks)) as ReadonlySet<string>,
    assetsByNetwork: Object.freeze(frozenAssets),
    schemes: Object.freeze(new Set(schemes)) as ReadonlySet<string>,
  });

  const limits: PolicyLimits = Object.freeze({
    perCallCeiling,
    runBudget,
    assetCeilings: Object.freeze(assetCeilings.map((entry) => Object.freeze({ ...entry }))),
  });

  const policy: SpendingPolicy = Object.freeze({
    limits,
    allowlist,
    allowedPayees: Object.freeze(new Set(payees)) as ReadonlySet<string>,
    describe: () =>
      `per-call ${formatUsd(perCallCeiling)} · run ${formatUsd(runBudget)} · ${describeAllowlist(allowlist)}`,
    toJSON: () => ({
      perCallCeilingAtomic: formatAtomic(perCallCeiling),
      perCallCeilingDisplay: formatUsd(perCallCeiling),
      runBudgetAtomic: formatAtomic(runBudget),
      runBudgetDisplay: formatUsd(runBudget),
      allowedNetworks: [...allowlist.networks].sort(),
      allowedSchemes: [...allowlist.schemes].sort(),
      allowedAssets: Object.fromEntries(
        [...allowlist.assetsByNetwork.entries()].map(([network, set]) => [
          network,
          [...set].sort(),
        ]),
      ),
      allowedPayees: policy.allowedPayees.size === 0 ? "any" : [...policy.allowedPayees].sort(),
    }),
  });

  return policy;
}

/** The reason from a thrown `Error`, without the stack. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Does the policy permit signing for this `(network, asset)` pair at all? */
export function checkAllowlist(policy: SpendingPolicy, quote: Quote): Refusal | null {
  const scheme = quote.scheme.trim().toLowerCase();
  if (!policy.allowlist.schemes.has(scheme)) {
    return {
      code: "scheme-not-allowed",
      message: `scheme "${quote.scheme}" is not on the allowlist`,
      observed: quote.scheme,
      limit: [...policy.allowlist.schemes].join(", "),
    };
  }

  let network: string;
  try {
    network = normaliseNetwork(quote.network);
  } catch (error) {
    return {
      code: "malformed-requirements",
      message: `network ${JSON.stringify(quote.network)} is not a valid CAIP-2 id: ${errorText(error)}`,
      observed: String(quote.network),
    };
  }
  if (!policy.allowlist.networks.has(network)) {
    return {
      code: "network-not-allowed",
      message: `network "${quote.network}" is not on the allowlist`,
      observed: quote.network,
      limit: [...policy.allowlist.networks].join(", "),
    };
  }

  let asset: string;
  try {
    asset = normaliseAsset(quote.asset);
  } catch (error) {
    return {
      code: "malformed-requirements",
      message: `asset ${JSON.stringify(quote.asset)} is not a valid EVM address: ${errorText(error)}`,
      observed: String(quote.asset),
    };
  }
  const assets = policy.allowlist.assetsByNetwork.get(network);
  if (assets === undefined || !assets.has(asset)) {
    return {
      code: "asset-not-allowed",
      message: `asset ${quote.asset} is not the approved token on ${network}`,
      observed: quote.asset,
      limit: assets === undefined ? "(none)" : [...assets].join(", "),
    };
  }

  if (policy.allowedPayees.size > 0) {
    let payTo: string;
    try {
      payTo = normaliseAsset(quote.payTo);
  } catch {
    return {
      code: "malformed-requirements",
      message: `payTo ${JSON.stringify(quote.payTo)} is not a valid EVM address`,
      observed: String(quote.payTo),
    };
    }
    if (!policy.allowedPayees.has(payTo)) {
      return {
        code: "payee-not-allowed",
        message: `payTo ${quote.payTo} is not an approved payee`,
        observed: quote.payTo,
        limit: [...policy.allowedPayees].join(", "),
      };
    }
  }

  return null;
}

/** The tightest ceiling that applies to this quote. */
export function effectiveCeiling(policy: SpendingPolicy, quote: Quote): Atomic {
  const network = normaliseNetwork(quote.network);
  const asset = normaliseAsset(quote.asset);
  let ceiling = policy.limits.perCallCeiling;
  for (const entry of policy.limits.assetCeilings) {
    if (entry.ref.network === network && entry.ref.asset === asset && entry.ceiling < ceiling) {
      ceiling = entry.ceiling;
    }
  }
  return ceiling;
}

/**
 * The per-call check. Integer comparison of base units, no exceptions.
 */
export function checkPerCall(policy: SpendingPolicy, quote: Quote): Refusal | null {
  const ceiling = effectiveCeiling(policy, quote);
  if (exceedsAtomic(quote.amount, ceiling)) {
    return {
      code: "per-call-ceiling-exceeded",
      message:
        `quoted ${formatAtomic(quote.amount)} base units ` +
        `(${formatUsd(quote.amount)}) for one call, above the ceiling of ` +
        `${formatAtomic(ceiling)} (${formatUsd(ceiling)})`,
      observed: formatAtomic(quote.amount),
      limit: formatAtomic(ceiling),
    };
  }
  return null;
}

/**
 * The cumulative check, in its reservation-aware form.
 *
 * `available = runBudget − committed − reserved`
 *
 * `reserved` is the load-bearing term. An approved-but-unsettled payment has
 * already been signed for, and the next call must not be allowed to spend the
 * same base units a second time. Without it, a run of ten slow payments could
 * each independently observe "spent 0 so far" and together overdraw the purse.
 */
export function checkCumulative(
  policy: SpendingPolicy,
  quote: Quote,
  context: DecisionContext,
): Refusal | null {
  const { committed, reserved } = context;
  const used = committed + reserved;
  if (used > policy.limits.runBudget) {
    // Cannot happen through the purse, which refuses before reserving. Guarded
    // anyway so a corrupt ledger cannot produce a nonsensical verdict.
    return {
      code: "run-budget-exhausted",
      message:
        `the ledger already holds ${formatAtomic(used)} base units, above the run ` +
        `budget of ${formatAtomic(policy.limits.runBudget)}`,
      observed: formatAtomic(used),
      limit: formatAtomic(policy.limits.runBudget),
    };
  }
  const available = policy.limits.runBudget - used;
  if (exceedsAtomic(quote.amount, available)) {
    return {
      code: "run-budget-exhausted",
      message:
        `quoting ${formatAtomic(quote.amount)} base units would need ` +
        `${formatAtomic(used + quote.amount)} in total; the run budget is ` +
        `${formatAtomic(policy.limits.runBudget)} and only ` +
        `${formatAtomic(available)} is unspent`,
      observed: formatAtomic(quote.amount),
      limit: formatAtomic(available),
    };
  }
  return null;
}

/** Convenience: is this `(network, asset)` pair payable at all? */
export function isAllowedAsset(policy: SpendingPolicy, ref: AssetRef): boolean {
  const assets = policy.allowlist.assetsByNetwork.get(normaliseNetwork(ref.network));
  return assets !== undefined && assets.has(normaliseAsset(ref.asset));
}
