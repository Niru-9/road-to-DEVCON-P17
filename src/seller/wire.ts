/**
 * Seller-side x402 wire helpers.
 *
 * Deliberately thin: build a `PaymentRequired`, base64 it into the header,
 * read a `PaymentPayload` back out. Every byte that leaves a seller is
 * untrusted by the buyer, and the rogue seller in `rogue.ts` needs the ability
 * to emit deliberately wrong structures, so nothing here "helpfully" repairs
 * a malformed requirement before encoding.
 */

import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeader,
} from "@x402/core/http";
import type { Network, PaymentPayload, PaymentRequired, PaymentRequirements, SettleResponse } from "@x402/core/types";

/** Canonical x402 v2 header names. */
export const HEADER_PAYMENT_REQUIRED = "PAYMENT-REQUIRED";
export const HEADER_PAYMENT = "X-PAYMENT";
export const HEADER_PAYMENT_RESPONSE = "PAYMENT-RESPONSE";

/** Ethereum Sepolia, the only network an honest seller here will talk about. */
export const ETHEREUM_SEPOLIA: Network = "eip155:11155111";
/** Circle USDC on Ethereum Sepolia, 6 decimals. The only asset a real seller here takes. */
export const ETHEREUM_SEPOLIA_USDC = "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238";

/** Where an honest seller collects money. A burner wallet, not a real one. */
export const SELLER_PAYTO = "0x5FbDB2315678afecb367f032d93F642f64180aa3";

export const X402_VERSION = 2;

/** One priced option this seller will accept. */
export interface SellerRequirement {
  readonly scheme: "exact" | "upto";
  /** CAIP-2, as `` `${string}:${string}` ``. Not a loose string: `84532` is not a network. */
  readonly network: Network;
  readonly asset: string;
  /** Canonical decimal string, base units. A string on purpose: see below. */
  readonly amount: string;
  readonly payTo: string;
  readonly maxTimeoutSeconds?: number;
  readonly extra?: Record<string, unknown>;
}

/**
 * Build the `Payment-Required` header a seller sends with a 402.
 *
 * `accepts` is passed through untouched, including anything malformed. A seller
 * that wants to lie about its price, network or asset must be able to put the
 * lie on the wire, or the rogue test is only testing a mock.
 */
export function paymentRequiredHeader(input: {
  readonly resource: string;
  readonly description: string;
  readonly accepts: readonly unknown[];
  readonly error?: string;
  readonly version?: number;
}): string {
  const paymentRequired = {
    x402Version: input.version ?? X402_VERSION,
    error: input.error ?? "X-PAYMENT header is required",
    resource: { url: input.resource, description: input.description, mimeType: "application/json" },
    accepts: input.accepts,
  } as unknown as PaymentRequired;
  return encodePaymentRequiredHeader(paymentRequired);
}

/** Build the `Payment-Response` header a seller sends after a settled payment. */
export function paymentResponseHeader(settle: Partial<SettleResponse> & { success: boolean }): string {
  return encodePaymentResponseHeader(settle as SettleResponse);
}

/** A requirement in the shape an honest seller uses. */
export function requirement(
  amountBaseUnits: string,
  overrides: Partial<SellerRequirement> = {},
): SellerRequirement {
  return {
    scheme: "exact",
    network: ETHEREUM_SEPOLIA,
    asset: ETHEREUM_SEPOLIA_USDC,
    amount: amountBaseUnits,
    payTo: SELLER_PAYTO,
    maxTimeoutSeconds: 60,
    extra: { name: "USDC", version: "2" },
    ...overrides,
  };
}

/** The `Payment-Required` body, as a well-behaved seller would send it. */
export interface PriceTag {
  readonly amount: string;
  readonly description: string;
  readonly resource: string;
  readonly extra?: Record<string, unknown>;
  readonly network?: string;
  readonly asset?: string;
  readonly scheme?: string;
}

/**
 * Read the `X-PAYMENT` header, if there is a decodable one.
 *
 * Returns `null` rather than throwing: a seller that crashes on a malformed
 * header has turned a client bug into a server outage, and the buyer learns
 * nothing about why.
 */
export function readPayment(headerValue: string | undefined): PaymentPayload | null {
  if (headerValue === undefined || headerValue === "") return null;
  try {
    return decodePaymentSignatureHeader(headerValue);
  } catch {
    return null;
  }
}

/** The amount the client claims it authorised, or `null` if it claims nothing. */
export function claimedAmount(payload: PaymentPayload | null): string | null {
  if (payload === null) return null;
  const amount: unknown = payload.accepted?.amount;
  return typeof amount === "string" ? amount : null;
}

/** Compare two canonical decimal strings without going through a number. */
export function decimalEquals(a: string, b: string): boolean {
  return a === b;
}

/** Render a requirement for a human-facing description. Never for a decision. */
export function describeRequirement(r: SellerRequirement): string {
  return `${r.amount} base units of ${r.asset} on ${r.network} (${r.scheme})`;
}

/** A `PaymentRequirements` entry, typed for the facilitator. */
export function asPaymentRequirements(r: SellerRequirement): PaymentRequirements {
  return r as unknown as PaymentRequirements;
}
