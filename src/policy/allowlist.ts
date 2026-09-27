/**
 * What the agent is willing to sign for, stated as literal sets.
 *
 * Two properties this file is responsible for:
 *
 *  1. **No wildcards.** The x402 quickstart registers schemes with
 *     `"eip155:*"`, which means the agent will sign for any EVM chain a seller
 *     names. A seller asking to be paid in `eip155:1` — where a `payTo` is
 *     under its own control and the token is not USDC — is the exact attack this
 *     allowlist exists to stop. A wildcard is a non-answer.
 *
 *  2. **Assets are per network.** A bare asset list would let a trusted address
 *     on one chain authorise an untrusted token with the same address on
 *     another, so the pair `(network, asset)` is the unit of permission.
 *
 * Case is normalised: EIP-55 checksummed and lowercase addresses are the same
 * address, and a seller that spells `0xABC…` differently from us has still named
 * the token we meant.
 */

import type { Atomic } from "../money/amount.js";
import { parseAtomic } from "../money/amount.js";

/**
 * Ethereum Sepolia. The only network in this project.
 *
 * Chosen because the configured facilitator advertises x402 v2 `exact` on
 * `eip155:11155111`. A chain the facilitator does not serve cannot settle.
 */
export const ETHEREUM_SEPOLIA = "eip155:11155111";

/**
 * Circle-issued USDC on Ethereum Sepolia. The only token this agent will pay in.
 *
 * 6 decimals, EIP-712 domain name `USDC` version `2` - both read from the
 * contract, not guessed. There is no SDK default asset for this chain, so every
 * requirement in this project names the asset and an integer amount outright
 * rather than a dollar string.
 */
export const ETHEREUM_SEPOLIA_USDC = "0x1c7d4b196cb0c7b01d743fbc6116a902379c7238";

/** The EIP-712 domain the payer must sign against. */
export const EIP712_NAME = "USDC";
export const EIP712_VERSION = "2";

/** The only payment scheme this agent knows how to honour. */
export const ALLOWED_SCHEMES: readonly string[] = ["exact"];

/** An `(network, asset)` pair, both normalised to lowercase. */
export interface AssetRef {
  readonly network: string;
  readonly asset: string;
}

/** Lowercase a network id. CAIP-2 ids are case-sensitive only in their namespace. */
/**
 * Normalise a CAIP-2 network id, and reject anything that is not one.
 *
 * A shape check, not a registry lookup: the requirement is `<namespace>:<ref>`
 * where the namespace is lowercase alphanumeric and the reference is
 * `[a-z0-9-]+`. Validation matters here because a 402 body is attacker-controlled
 * input, and the caller distinguishes "this was malformed" from "this was not
 * allowed" when it writes the audit record.
 *
 * A wildcard is rejected outright rather than normalised. `eip155:*` is what
 * the x402 quickstart registers, and treating it as a network would mean
 * accepting whatever chain a seller named.
 */
export function normaliseNetwork(network: string): string {
  const trimmed = network.trim().toLowerCase();
  const separator = trimmed.indexOf(":");
  if (separator < 1) {
    throw new Error(`not a CAIP-2 id (expected namespace:reference): ${JSON.stringify(network)}`);
  }
  const namespace = trimmed.slice(0, separator);
  const reference = trimmed.slice(separator + 1);
  if (!/^[a-z0-9]+$/.test(namespace)) {
    throw new Error(`CAIP-2 namespace must be alphanumeric: ${JSON.stringify(network)}`);
  }
  if (reference.length === 0) {
    throw new Error(`CAIP-2 reference is empty: ${JSON.stringify(network)}`);
  }
  if (!/^[a-z0-9-]+$/.test(reference)) {
    // This is where a wildcard lands, so the error names the real problem.
    throw new Error(
      `CAIP-2 reference must be [a-z0-9-]+ with no wildcard: ${JSON.stringify(network)}`,
    );
  }
  return trimmed;
}

/** `normaliseNetwork` that reports failure as `null` instead of throwing. */
export function tryNormaliseNetwork(network: string): string | null {
  try {
    return normaliseNetwork(network);
  } catch {
    return null;
  }
}

/**
 * Lowercase an EVM address for comparison.
 *
 * Only a shape check, deliberately. Verifying an EIP-55 checksum would reject
 * addresses that are valid but not checksummed, and a seller is entitled to
 * spell an address in lowercase.
 */
export function normaliseAsset(asset: string): string {
  const trimmed = asset.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(trimmed)) {
    throw new Error(`not an EVM address: ${JSON.stringify(asset)}`);
  }
  return trimmed;
}

/** Parse a `network=0xaddress` pair, as used in `PURSE_ALLOWED_ASSETS`. */
export function parseAssetRef(spec: string): AssetRef {
  const separator = spec.indexOf("=");
  if (separator === -1) {
    throw new Error(`asset spec must be "network=0xaddress", received ${JSON.stringify(spec)}`);
  }
  const network = spec.slice(0, separator);
  const asset = spec.slice(separator + 1);
  return { network: normaliseNetwork(network), asset: normaliseAsset(asset) };
}

/** The default allowlist: Ethereum Sepolia, USDC only, `exact` only. */
export function defaultAllowlist(): {
  networks: ReadonlySet<string>;
  assetsByNetwork: ReadonlyMap<string, ReadonlySet<string>>;
  schemes: ReadonlySet<string>;
} {
  return {
    networks: new Set([normaliseNetwork(ETHEREUM_SEPOLIA)]),
    assetsByNetwork: new Map([
      [normaliseNetwork(ETHEREUM_SEPOLIA), new Set([normaliseAsset(ETHEREUM_SEPOLIA_USDC)])],
    ]),
    schemes: new Set(ALLOWED_SCHEMES),
  };
}

/** Human-readable summary for the audit record. */
export function describeAllowlist(allowlist: {
  networks: ReadonlySet<string>;
  assetsByNetwork: ReadonlyMap<string, ReadonlySet<string>>;
  schemes: ReadonlySet<string>;
}): string {
  const assets = [...allowlist.assetsByNetwork.entries()]
    .map(([network, set]) => `${network} {${[...set].join(", ")}}`)
    .join("; ");
  return `networks {${[...allowlist.networks].join(", ")}} · assets ${assets} · schemes {${[
    ...allowlist.schemes,
  ].join(", ")}}`;
}

/**
 * A per-asset ceiling, used when a cheap token deserves a tighter cap than the
 * headline per-call figure.
 */
export interface AssetCeiling {
  readonly ref: AssetRef;
  readonly ceiling: Atomic;
}

/** Parse a `network=0xaddress=ceiling` spec from configuration. */
export function parseAssetCeiling(spec: string): AssetCeiling {
  const parts = spec.split("=");
  if (parts.length !== 3) {
    throw new Error(
      `asset ceiling must be "network=0xaddress=baseUnits", received ${JSON.stringify(spec)}`,
    );
  }
  const [network, asset, ceiling] = parts as [string, string, string];
  return {
    ref: { network: normaliseNetwork(network), asset: normaliseAsset(asset) },
    ceiling: parseAtomic(ceiling, `asset ceiling for ${network}`),
  };
}
