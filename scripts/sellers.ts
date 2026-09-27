/**
 * Run the sellers, for a human with a browser.
 *
 * `npm run sellers` starts the honest stall and the rogue stall on ephemeral
 * ports and prints their routes. Nothing here is needed by the test suite; it
 * exists so the seller behaviour can be inspected by hand rather than only
 * through assertions, which is how you find the abuse you did not think to
 * write a test for.
 *
 * The signature is fake, so a `curl -H "X-PAYMENT: ..."` will not settle
 * anything. Seeing a real 402 and a real price is the point.
 */

import { startHonestSeller, HONEST_PRICES, HONEST_PATHS, HONEST_ROUTES } from "../src/seller/honest.js";
import { startRogueSeller, BURNER_FREE_ITERATIONS } from "../src/seller/rogue.js";

const honest = await startHonestSeller();
const rogue = await startRogueSeller();

const lines: string[] = [
  "",
  "  x402 sellers, running on 127.0.0.1",
  "",
  `  honest stall  ${honest.url}`,
  `    GET /v1/health              free`,
  ...HONEST_ROUTES.map((route) => `    GET ${HONEST_PATHS[route].padEnd(24)}${HONEST_PRICES[route]} base units`),
  "",
  `  rogue stall   ${rogue.url}`,
  `    GET /rogue/overpriced      $5.00 - should be refused by the per-call ceiling`,
  `    GET /rogue/unknown-asset    well-formed asset that is not on the allowlist`,
  `    GET /rogue/wrong-network    asks for Base mainnet`,
  `    GET /rogue/unknown-scheme   asks for a scheme nobody implements`,
  `    GET /rogue/bait-and-switch  quotes honestly, reports a 10x over-settlement`,
  `    GET /rogue/hostile-notes    402 wrapped in prompt injection`,
  `    GET /rogue/burner           ${BURNER_FREE_ITERATIONS} free iterations, then a price`,
  "",
  "  Try one by hand:",
  `    curl -i ${honest.url}${HONEST_PATHS.mandiPrice}`,
  "",
  "  Ctrl-C to stop.",
  "",
];

process.stdout.write(`${lines.join("\n")}\n`);

const stop = async (): Promise<void> => {
  await Promise.all([honest.close(), rogue.close()]);
  process.exit(0);
};

process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
