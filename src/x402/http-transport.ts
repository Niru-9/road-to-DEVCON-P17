/**
 * The real HTTP transport: Khata's gate talking to a seller over a socket.
 *
 * This is the seam where the hermetic unit tests stop and the integration tests
 * start. Everything above it — policy, decode, ledger, reconcile — is unchanged
 * from the tests that never open a socket. Only this file knows that `fetch`
 * exists.
 *
 * Three things it has to get right, and each was a way to get it wrong:
 *
 * 1. **Body decoding cannot throw.** A 402 with no body, a truncated response,
 *    or an `image/png` content type all have to arrive as `undefined` or a
 *    string. If this threw, a seller could turn a refused payment into an
 *    unhandled exception in the buyer — a small denial of service for the price
 *    of nothing.
 * 2. **Headers must survive case.** Node lowercases them, and the gate matches
 *    case-insensitively, but a `Headers` instance is passed through as-is so
 *    the real header names stay visible in a failing assertion.
 * 3. **A network error is a value, not an exception.** A socket reset after the
 *    retry means settlement is unknown, and the gate needs to reach that branch
 *    to mark the attempt interrupted. Throwing past the gate would leave a hold
 *    with no recorded state.
 */

import type { HttpPort, HttpResponse } from "./gate.js";

export interface HttpTransportOptions {
  /** Injected for tests that need a specific failure. Defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Per-request timeout. A hung seller must not hang the run. */
  readonly timeoutMs?: number;
  /** User agent, so a seller can tell a purse from a browser. */
  readonly userAgent?: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = "khata-coin-purse/0.1";

/**
 * Build an `HttpPort` backed by real HTTP.
 *
 * GET only: the gate is a data-fetch purse, and adding a method parameter would
 * put a verb in the caller's hands for no benefit. A seller needing a POST would
 * get a new port, with its own review.
 */
export function createHttpTransport(options: HttpTransportOptions = {}): HttpPort {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("no fetch implementation available; pass options.fetchImpl");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

  return {
    async request(url: string, init: { headers: Record<string, string> }): Promise<HttpResponse> {
      const controller = new AbortController();
      const timer = setTimeout(() => {
        controller.abort();
      }, timeoutMs);
      try {
        const response = await doFetch(url, {
          method: "GET",
          headers: { ...init.headers, "user-agent": userAgent, accept: "application/json" },
          signal: controller.signal,
          redirect: "error",
        });
        return { status: response.status, headers: response.headers, body: await readBodySafely(response) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/**
 * Read a response body without ever throwing.
 *
 * A seller that returns malformed JSON gets its text back as a string, not an
 * exception. The buyer's decision is made from protocol fields, so a body it
 * cannot parse is simply data it did not use.
 */
async function readBodySafely(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 304) return null;

  let text: string;
  try {
    text = await response.text();
  } catch {
    return null;
  }
  if (text === "") return null;

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // Declared JSON, is not JSON. Hand back the bytes rather than throwing:
      // the rogue seller is allowed to be wrong about this.
      return text;
    }
  }
  if (contentType === "") {
    // No declared type. Try JSON, because several of these routes answer with
    // a body and no content-type; fall back to text.
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}
