/**
 * A deterministic signer for tests and for the hermetic demo.
 *
 * It produces a structurally valid x402 `PaymentPayload` and encodes it with
 * the *real* `@x402/core` codec, so the bytes on the wire are the bytes a real
 * client would produce. The only thing faked is the signature itself, which is a
 * fixed string: no key, no wallet, no chain, no funds.
 *
 * This is what makes "the gate paid the honest seller over HTTP" a claim about
 * the buyer's logic rather than about the buyer's ability to spend money. The
 * buyer's decisions — which quote to sign, whether to sign at all, what to write
 * to the ledger — are all fully exercised. The fact that a real signature would
 * require a funded key is a fact about the *environment*, not about the code.
 *
 * For a live run, pass a real `x402Client`'s `createPaymentPayload` and its
 * `encodePaymentSignatureHeader` instead. The `Signer` interface is the same
 * shape, so the gate does not change.
 */

import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { STUB_PAYER, STUB_SIGNATURE, stubTxHash } from "../seller/facilitator.js";
import type { Signer } from "../x402/gate.js";

export interface StubSignerOptions {
  /**
   * Make `createPaymentPayload` throw, to exercise the "signed nothing" branch.
   */
  readonly failWith?: Error;
  /** Make header encoding throw, to exercise the "held then released" branch. */
  readonly failEncode?: boolean;
  /** Override the address claimed as the payer. */
  readonly payer?: string;
}

export interface StubSigner extends Signer {
  /** Every payload this signer was asked to produce, in order. */
  readonly payloads: readonly PaymentPayload[];
  /** How many times signing was attempted. Zero is the number that matters. */
  readonly callCount: number;
  /** How many times `encodePaymentSignatureHeader` was called. */
  readonly encodeCount: number;
}

/**
 * Build the deterministic signer.
 *
 * It signs *whatever single requirement it is handed* and does not second-guess
 * the amount. That is deliberate: the whole security argument is that by the
 * time this is called, the amount has already passed the allowlist, the ceiling,
 * the cumulative check and a durable reservation. A signer that quietly
 * re-priced things would hide exactly the bug the ordering test looks for.
 */
export function createStubSigner(options: StubSignerOptions = {}): StubSigner {
  const payloads: PaymentPayload[] = [];
  const payer = options.payer ?? STUB_PAYER;
  let encodeCount = 0;

  return {
    payloads,
    get callCount() {
      return payloads.length;
    },
    get encodeCount() {
      return encodeCount;
    },

    async createPaymentPayload(paymentRequired: PaymentRequired): Promise<PaymentPayload> {
      if (options.failWith !== undefined) throw options.failWith;

      const accepted = paymentRequired.accepts[0];
      if (accepted === undefined) {
        throw new Error("refusing to sign: no requirement was offered");
      }

      const payload: PaymentPayload = {
        x402Version: paymentRequired.x402Version,
        resource: paymentRequired.resource,
        accepted,
        payload: {
          signature: STUB_SIGNATURE,
          authorization: {
            from: payer,
            // Deterministic and derived from the requirement, so two different
            // payments get different nonces and one payment is idempotent.
            nonce: stubTxHash(`${accepted.payTo}:${accepted.amount}:${accepted.network}`),
          },
        },
      } as PaymentPayload;

      payloads.push(payload);
      return payload;
    },

    encodePaymentSignatureHeader(payload: PaymentPayload): Record<string, string> {
      encodeCount += 1;
      if (options.failEncode === true) {
        throw new Error("could not encode the payment signature");
      }
      // The real codec, the real header name. Only the signature is fake.
      return { "X-PAYMENT": encodePaymentSignatureHeader(payload) };
    },
  };
}
