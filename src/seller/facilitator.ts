/**
 * A deterministic facilitator, stubbed.
 *
 * The real thing talks to a facilitator over the network to check a payment
 * payload and to settle it on-chain. That is the one part of an x402 flow that
 * genuinely cannot be hermetic, and the whole point of this project is that the
 * *buyer's* decisions must be verifiable without it.
 *
 * So this stands in at the boundary the buyer cares about: "given the payload
 * the client sent, and the requirement I advertised, was this a valid payment
 * for what I asked?" It answers from first principles about the payload's
 * structure, with no randomness and no clock, so a test that passes once passes
 * always.
 *
 * The important property for the rogue seller tests: `settle` is told what to
 * *report*, so a seller that wants to lie about how much it took can lie here,
 * and the buyer has to catch it from the response alone.
 */

import type { Network, PaymentPayload } from "@x402/core/types";
import { ETHEREUM_SEPOLIA, ETHEREUM_SEPOLIA_USDC, type SellerRequirement } from "./wire.js";

/** The address the deterministic test signer claims to pay from. */
export const STUB_PAYER = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8";

/** A fixed, obviously-fake signature. Never a real one; nothing is signed. */
export const STUB_SIGNATURE = "0xstub-signature-not-a-real-key-signature";

export type VerifyFailureCode =
  | "no-payment"
  | "undecodable-payment"
  | "amount-mismatch"
  | "network-mismatch"
  | "asset-mismatch"
  | "scheme-mismatch"
  | "payto-mismatch"
  | "unsupported-network"
  | "unsupported-asset";

export interface VerifyOk {
  readonly ok: true;
  readonly payer: string;
  readonly settled: string;
}

export interface VerifyFailure {
  readonly ok: false;
  readonly code: VerifyFailureCode;
  readonly message: string;
}

export type VerifyResult = VerifyOk | VerifyFailure;

/** What a facilitator is asked to do by a seller. */
export interface Facilitator {
  verify(payload: PaymentPayload | null, required: SellerRequirement): Promise<VerifyResult>;
  /** Turn a verified payment into the settlement the buyer will read back. */
  settle(input: {
    readonly payload: PaymentPayload;
    readonly required: SellerRequirement;
    readonly txHash: string;
    /** Deliberately dishonest reporting, for the bait-and-switch test. */
    readonly reportAmount?: string;
  }): {
    readonly success: true;
    readonly transaction: string;
    readonly network: Network;
    readonly payer: string;
    readonly amount: string;
  };
}

export interface StubFacilitatorOptions {
  /** Networks this facilitator will settle on. Default: Ethereum Sepolia only. */
  readonly networks?: readonly string[];
  /** Assets this facilitator will settle. Default: Ethereum Sepolia USDC only. */
  readonly assets?: readonly string[];
}

/**
 * Deterministic tx hash derived from the payment, so a test can assert the hash
 * without hardcoding a value that changes whenever the payload does.
 */
export function stubTxHash(seed: string): string {
  // FNV-1a, rendered as 32 hex chars. Not a security primitive and not meant
  // to be: this is a reproducible label for a test fixture.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `0x${hash.toString(16).padStart(8, "0").repeat(4)}`;
}

/**
 * Build the deterministic facilitator.
 *
 * Note what it checks and what it does not. It compares the payload against the
 * requirement the seller advertised. It does not independently discover the
 * price — a real facilitator cannot either, it settles what the payload authorises
 * and the *seller* chooses the requirement. That is precisely why the buyer's
 * allowlist and ceiling, not the facilitator, are the security boundary.
 */
export function createStubFacilitator(options: StubFacilitatorOptions = {}): Facilitator {
  const networks = new Set(options.networks ?? [ETHEREUM_SEPOLIA.toLowerCase()]);
  const assets = new Set((options.assets ?? [ETHEREUM_SEPOLIA_USDC]).map((a) => a.toLowerCase()));

  return {
    async verify(payload, required) {
      if (payload === null) {
        return { ok: false, code: "no-payment", message: "no X-PAYMENT header on the request" };
      }

      const accepted = payload.accepted as
        | { scheme?: unknown; network?: unknown; asset?: unknown; amount?: unknown; payTo?: unknown }
        | undefined;
      if (accepted === undefined) {
        return { ok: false, code: "undecodable-payment", message: "payload named no accepted requirement" };
      }

      if (typeof accepted.scheme === "string" && accepted.scheme !== required.scheme) {
        return {
          ok: false,
          code: "scheme-mismatch",
          message: `client accepted scheme ${accepted.scheme}, seller asked for ${required.scheme}`,
        };
      }
      if (typeof accepted.network === "string" && !networks.has(accepted.network.toLowerCase())) {
        return {
          ok: false,
          code: "unsupported-network",
          message: `facilitator will not settle on ${accepted.network}`,
        };
      }
      if (typeof accepted.asset === "string" && !assets.has(accepted.asset.toLowerCase())) {
        return {
          ok: false,
          code: "unsupported-asset",
          message: `facilitator will not settle ${accepted.asset}`,
        };
      }
      if (
        typeof accepted.network === "string" &&
        accepted.network.toLowerCase() !== required.network.toLowerCase()
      ) {
        return {
          ok: false,
          code: "network-mismatch",
          message: `client accepted ${accepted.network}, seller asked for ${required.network}`,
        };
      }
      if (
        typeof accepted.asset === "string" &&
        accepted.asset.toLowerCase() !== required.asset.toLowerCase()
      ) {
        return {
          ok: false,
          code: "asset-mismatch",
          message: `client accepted ${accepted.asset}, seller asked for ${required.asset}`,
        };
      }
      if (
        typeof accepted.payTo === "string" &&
        accepted.payTo.toLowerCase() !== required.payTo.toLowerCase()
      ) {
        return {
          ok: false,
          code: "payto-mismatch",
          message: `payment authorised to ${accepted.payTo}, seller asked for ${required.payTo}`,
        };
      }
      // The load-bearing check: the amount the client authorised is the amount
      // the seller asked for. Not "close enough" — string equality on canonical
      // decimals, so 2500 and 25000 are as different as 1 and 2.
      if (typeof accepted.amount !== "string" || accepted.amount !== required.amount) {
        return {
          ok: false,
          code: "amount-mismatch",
          message: `client authorised ${String(accepted.amount)}, seller asked for ${required.amount}`,
        };
      }

      return { ok: true, payer: STUB_PAYER, settled: required.amount };
    },

    settle({ payload, required, txHash, reportAmount }) {
      const seed = `${required.payTo}:${required.amount}:${payload.accepted?.amount ?? ""}`;
      return {
        success: true,
        transaction: txHash === "" ? stubTxHash(seed) : txHash,
        network: required.network,
        payer: STUB_PAYER,
        // `reportAmount` exists so the rogue seller can report a settlement
        // larger than the one authorised. A real facilitator would not do this,
        // which is the point: the buyer must not depend on the counterparty
        // telling the truth about its own revenue.
        amount: reportAmount ?? required.amount,
      };
    },
  };
}

