/**
 * A last-line destination check, applied to the transport rather than the tool.
 *
 * ## Why a second check at all
 *
 * `SellerAllowlist` already refuses a non-allowlisted host before the dispatcher
 * calls the gate, and that is the control the tests attack. This guard is
 * deliberately redundant, and redundancy is the point: it lives at the *last*
 * place before a socket exists, so a bug in URL parsing, an allowlist entry
 * written by mistake, or a future code path that calls the gate directly instead
 * of through the dispatcher still cannot reach a non-loopback host in a local run.
 *
 * The threat it addresses concretely: `paid_fetch` is an SSRF primitive by
 * construction. The allowlist is the thing standing between a steered model and
 * `http://169.254.169.254/` or an internal admin port. Two independent checks on
 * the same question are worth more than one check that has to be correct.
 *
 * ## When it engages
 *
 * Only when the operator's own configuration is loopback-only. If any
 * allowlisted host is not loopback, the guard stands down, because a deployment
 * fetching a real seller over HTTPS is the intended production shape and must not
 * be broken by a guard written for a laptop.
 *
 * ## What it is not
 *
 * Not a production security boundary. A determined local attacker who can start
 * a process on the machine can still be reached on loopback, and DNS rebinding is
 * out of scope. It converts a misconfiguration from "the model can read your local
 * network" into "the model can only read loopback", which is the honest amount of
 * safety available without a network namespace.
 */

import type { HttpPort, HttpResponse } from "./gate.js";

export interface TransportGuardOptions {
  /**
   * Engages the loopback restriction. `true` when every allowlisted host is
   * loopback *and* the ports are pinned; `false` otherwise.
   */
  readonly requireLoopback: boolean;
  /** Injected for tests. Defaults to the global `URL`. */
  readonly parseUrl?: (url: string) => URL | null;
}

/** A denial from the guard, as a value. The gate turns this into an `interrupted` attempt. */
export class TransportGuardError extends Error {
  readonly code = "transport-destination-refused";
  constructor(message: string) {
    super(message);
    this.name = "TransportGuardError";
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

/**
 * Wrap an `HttpPort` so it refuses any destination the configuration did not ask
 * for.
 *
 * Throws `TransportGuardError` rather than returning a synthetic response: a
 * refusal is not a server response, and the gate's `interrupted` branch exists
 * precisely to hold budget when a call fails in a way that is not a clean
 * "no". A silent 403-shaped response here would be a lie about what happened.
 */
export function withTransportGuard(inner: HttpPort, options: TransportGuardOptions): HttpPort {
  const parse = options.parseUrl ?? ((url: string): URL | null => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  });

  return {
    async request(url: string, init: { headers: Record<string, string> }): Promise<HttpResponse> {
      if (options.requireLoopback) {
        const parsed = parse(url);
        if (parsed === null) {
          throw new TransportGuardError(`refused an unparseable destination before opening a socket: ${url.slice(0, 120)}`);
        }
        if (!isLoopbackHost(parsed.hostname)) {
          throw new TransportGuardError(
            `refused a non-loopback destination before opening a socket: host ${parsed.hostname}. ` +
              "This run is configured for local sellers only.",
          );
        }
      }
      return inner.request(url, init);
    },
  };
}

/**
 * Decide whether the guard should engage, from the allowlist alone.
 *
 * Deliberately conservative: it engages only when the configuration is strictly
 * local *and* fully port-pinned. Hostname-only loopback is left unguarded here
 * because a guard that blocks non-loopback adds nothing to a config that already
 * refuses non-loopback hosts by name — and pretending otherwise would overstate
 * what the guard buys.
 */
export function guardRequiredFor(allowlist: { hosts: readonly string[]; pinsPorts: boolean }): boolean {
  return allowlist.pinsPorts && allowlist.hosts.every(isLoopbackHost);
}
