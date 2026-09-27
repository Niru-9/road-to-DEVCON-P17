/**
 * The honest stall.
 *
 * Four priced data routes and one free one, for Arjun's monsoon research. The
 * prices are the seller's own: it decides what a rainfall grid costs, and the
 * buyer's only say is whether to pay it.
 *
 * What makes it honest is not that it is nice — it is that everything it sends
 * is true. The 402 states the amount it will accept, the `Payment-Response`
 * reports exactly what was taken, and the route description matches the route.
 * A buyer that refuses this seller is misconfigured.
 */

import { startSeller, type RouteContext, type Seller, type SellerResponse } from "./http.js";
import { createStubFacilitator, type Facilitator } from "./facilitator.js";
import {
  HEADER_PAYMENT,
  HEADER_PAYMENT_REQUIRED,
  HEADER_PAYMENT_RESPONSE,
  paymentRequiredHeader,
  paymentResponseHeader,
  readPayment,
  requirement,
  type PriceTag,
  type SellerRequirement,
} from "./wire.js";

/**
 * Prices in USDC base units (6 decimals). Chosen so a full research run costs
 * cents, not the $5 budget, and so the per-call ceiling has room to be a real
 * ceiling rather than a token gesture.
 */
export const HONEST_PRICES = {
  rainfallGrid: "500", //  $0.0005
  mandiPrice: "1000", //  $0.001
  satelliteSummary: "2500", //  $0.0025
  monsoonAdvisory: "10000", // $0.01
} as const;

export type HonestRoute = keyof typeof HONEST_PRICES;

/**
 * URL path per route.
 *
 * Exported so a caller cannot drift from the route table by retyping a path.
 * The test suite used to hardcode these strings and silently 404'd, which is
 * exactly the kind of failure that looks like a passing test when the gate
 * treats a 404 as "free".
 */
export const HONEST_PATHS: Readonly<Record<HonestRoute, string>> = {
  rainfallGrid: "/v1/rainfall-grid",
  mandiPrice: "/v1/mandi-price",
  satelliteSummary: "/v1/satellite-summary",
  monsoonAdvisory: "/v1/monsoon-advisory",
};

export const HONEST_ROUTES: readonly HonestRoute[] = [
  "rainfallGrid",
  "mandiPrice",
  "satelliteSummary",
  "monsoonAdvisory",
];

const TAGS: Readonly<Record<HonestRoute, PriceTag>> = {
  rainfallGrid: {
    amount: HONEST_PRICES.rainfallGrid,
    description: "Rainfall grid, 0.25 degree cell, 24h accumulation in mm",
    resource: HONEST_PATHS.rainfallGrid,
  },
  mandiPrice: {
    amount: HONEST_PRICES.mandiPrice,
    description: "Mandi wholesale price for one crop at one market, in INR per quintal",
    resource: HONEST_PATHS.mandiPrice,
  },
  satelliteSummary: {
    amount: HONEST_PRICES.satelliteSummary,
    description: "Satellite-derived cloud and flood summary for one bounding box",
    resource: HONEST_PATHS.satelliteSummary,
  },
  monsoonAdvisory: {
    amount: HONEST_PRICES.monsoonAdvisory,
    description: "Monsoon onset advisory for one district",
    resource: HONEST_PATHS.monsoonAdvisory,
  },
};

/** The data behind each route. Fixed, so tests assert on real content. */
const DATA: Readonly<Record<HonestRoute, unknown>> = {
  rainfallGrid: {
    cell: "12.9716,77.5946",
    windowUtc: "2026-09-25T00:00:00Z/2026-09-26T00:00:00Z",
    accumulationMm: 18.4,
    stations: 7,
  },
  mandiPrice: {
    market: "KR Market, Bengaluru",
    crop: "arhar (tur dal)",
    inrPerQuintal: 7425,
    asOf: "2026-09-25",
  },
  satelliteSummary: {
    bbox: "77.4,12.8,77.8,13.1",
    cloudCoverPct: 62,
    floodRisk: "moderate",
    scene: "S2A_20260925",
  },
  monsoonAdvisory: {
    district: "Bengaluru Urban",
    onsetExpected: "2026-06-02",
    confidencePct: 71,
  },
};

export interface HonestSellerOptions {
  readonly facilitator?: Facilitator;
  /** Reported settlement amount, for tests that need a specific figure. */
  readonly reportAmount?: (required: SellerRequirement) => string | undefined;
}

/** The requirement this seller advertises for a route. */
export function priceTagFor(route: HonestRoute): SellerRequirement {
  const tag = TAGS[route];
  return requirement(tag.amount, tag.extra);
}

/**
 * Serve a paid route honestly: 402 with the real price, then serve on a
 * verified payment.
 */
async function paidRoute(route: HonestRoute, ctx: RouteContext, options: HonestSellerOptions): Promise<SellerResponse> {
  const tag = TAGS[route];
  const required = priceTagFor(route);
  const resource = `${ctx.url.origin}${tag.resource}${ctx.url.search}`;

  const paymentHeader = ctx.header(HEADER_PAYMENT);
  if (paymentHeader === undefined) {
    // Ask, honestly: here is the price, here is what I take, here is what I
    // will hand over. No persuasion, no urgency.
    return {
      status: 402,
      headers: { [HEADER_PAYMENT_REQUIRED]: paymentRequiredHeader({ resource, description: tag.description, accepts: [required] }) },
      body: {
        error: "payment required",
        price: `${required.amount} base units of USDC (${tag.amount}) on Ethereum Sepolia`,
        documentation: tag.description,
      },
    };
  }

  const payload = readPayment(paymentHeader);
  if (payload === null) {
    return {
      status: 400,
      headers: { "content-type": "application/json" },
      body: { error: "X-PAYMENT header present but not decodable" },
    };
  }

  // Verification is async, so settlement is too.
  return settleHonest(route, ctx, required, payload, options);
}

async function settleHonest(
  route: HonestRoute,
  ctx: RouteContext,
  required: SellerRequirement,
  payload: NonNullable<ReturnType<typeof readPayment>>,
  options: HonestSellerOptions,
): Promise<SellerResponse> {
  const facilitator = options.facilitator ?? createStubFacilitator();
  const verified = await facilitator.verify(payload, required);

  if (!verified.ok) {
    // A refusal is reported as a refusal. The buyer must be able to tell this
    // apart from success, which is why the header carries success: false.
    return {
      status: 402,
      headers: {
        [HEADER_PAYMENT_REQUIRED]: paymentRequiredHeader({
          resource: `${ctx.url.origin}${TAGS[route].resource}`,
          description: TAGS[route].description,
          accepts: [required],
        }),
        [HEADER_PAYMENT_RESPONSE]: paymentResponseHeader({ success: false, errorReason: verified.message }),
      },
      body: { error: "payment not accepted", reason: verified.message },
    };
  }

  const settlement = facilitator.settle({
    payload,
    required,
    txHash: "",
    ...(options.reportAmount === undefined ? {} : { reportAmount: options.reportAmount(required) ?? "" }),
  });

  return {
    status: 200,
    headers: {
      [HEADER_PAYMENT_RESPONSE]: paymentResponseHeader({
        success: true,
        transaction: settlement.transaction,
        network: settlement.network,
        payer: settlement.payer,
        amount: settlement.amount,
      }),
    },
    body: { ...(DATA[route] as Record<string, unknown>), paidWith: required.amount },
  };
}

/** Build the honest seller's route table. */
export function honestRoutes(
  options: HonestSellerOptions = {},
): Record<string, (ctx: RouteContext) => SellerResponse | Promise<SellerResponse>> {
  const routes: Record<string, (ctx: RouteContext) => SellerResponse | Promise<SellerResponse>> = {
    // Free, so a buyer can prove it does not pay for things that cost nothing.
    "GET /v1/health": () => ({ status: 200, body: { ok: true, seller: "honest-stall" } }),
  };
  // Keys come from HONEST_PATHS so the table and the exported paths cannot
  // disagree.
  for (const route of HONEST_ROUTES) {
    routes[`GET ${HONEST_PATHS[route]}`] = (ctx) => paidRoute(route, ctx, options);
  }
  return routes;
}

/** Start the honest seller on an ephemeral port. */
export async function startHonestSeller(options: HonestSellerOptions = {}): Promise<Seller> {
  return startSeller("honest-stall", honestRoutes(options));
}

