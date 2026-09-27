/**
 * Host **and** port** for the seller allowlist, plus the transport-level guard.
 *
 * ## The risk being closed
 *
 * A hostname-only allowlist containing `127.0.0.1` means `paid_fetch` may open a
 * socket to *any* port on the developer's machine - a local Postgres, a metrics
 * exporter, a debug admin port. The allowlist is the SSRF control, so "any port
 * on loopback" is a wide control.
 *
 * The fix is pinning: an entry may be `host:port`, and the demo pins the exact
 * ports of the two sellers it started. This file pins down the behaviour, and
 * pins down the parts that are *not* fixed, because a second, redundant check is
 * only worth anything if its limits are stated.
 */

import { describe, expect, it } from "vitest";
import { SellerAllowlist, validateUrl, parseToolArguments, PAID_FETCH_TOOL_NAME } from "../src/agent/tools.js";
import { withTransportGuard, guardRequiredFor, TransportGuardError, isLoopbackHost } from "../src/x402/guarded-transport.js";
import type { HttpPort, HttpResponse } from "../src/x402/gate.js";

/** A transport that records calls instead of opening a socket. */
function recordingTransport(): HttpPort & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async request(url: string): Promise<HttpResponse> {
      calls.push(url);
      return { status: 200, headers: {}, body: { ok: true } };
    },
  };
}

describe("SellerAllowlist: entry parsing", () => {
  it("keeps hostname-only entries working, so the ephemeral-port tests are unaffected", () => {
    const allowlist = new SellerAllowlist(["127.0.0.1"]);
    expect(allowlist.entries).toEqual(["127.0.0.1"]);
    expect(allowlist.pinsPorts).toBe(false);
  });

  it("accepts host:port and reports the pin", () => {
    const allowlist = new SellerAllowlist(["127.0.0.1:53124"]);
    expect(allowlist.entries).toEqual(["127.0.0.1:53124"]);
    expect(allowlist.pinsPorts).toBe(true);
    expect(allowlist.portsFor("127.0.0.1")).toEqual([53124]);
  });

  it("collects several ports for one host, which is what the two demo sellers need", () => {
    // Both sellers bind 127.0.0.1; only the ports differ. A model that allowed
    // one port per host would have had to pick a winner.
    const allowlist = new SellerAllowlist(["127.0.0.1:53124", "127.0.0.1:53125"]);
    expect(allowlist.pinsPorts).toBe(true);
    expect(allowlist.portsFor("127.0.0.1")).toEqual([53124, 53125]);
    expect(allowlist.entries).toEqual(["127.0.0.1:53124", "127.0.0.1:53125"]);
  });

  it("lets a bare host subsume a pin for the same host", () => {
    const allowlist = new SellerAllowlist(["127.0.0.1:53124", "127.0.0.1"]);
    expect(allowlist.pinsPorts).toBe(false);
    expect(allowlist.portsFor("127.0.0.1")).toEqual([]);
  });

  it("treats a non-numeric port as part of the hostname rather than pinning to nonsense", () => {
    const allowlist = new SellerAllowlist(["example.com:https"]);
    expect(allowlist.hosts).toEqual(["example.com:https"]);
    expect(allowlist.pinsPorts).toBe(false);
  });

  it("handles a bracketed IPv6 host with a port", () => {
    const allowlist = new SellerAllowlist(["[::1]:8080"]);
    expect(allowlist.entries).toEqual(["[::1]:8080"]);
    expect(allowlist.pinsPorts).toBe(true);
    expect(allowlist.allowsLoopback).toBe(true);
  });

  it("treats a bare IPv6 literal as a host, not as host plus port", () => {
    const allowlist = new SellerAllowlist(["::1"]);
    expect(allowlist.hosts).toEqual(["::1"]);
    expect(allowlist.pinsPorts).toBe(false);
  });

  it("refuses port 0 rather than widening the entry", () => {
    expect(() => new SellerAllowlist(["127.0.0.1:0"])).toThrow(/port 0/);
  });

  it("allows the same host repeated with the same pin", () => {
    expect(() => new SellerAllowlist(["127.0.0.1:80", "127.0.0.1:80"])).not.toThrow();
  });

  it("still refuses an empty list", () => {
    expect(() => new SellerAllowlist([])).toThrow();
    expect(() => new SellerAllowlist([" ", ""])).toThrow();
  });
});

describe("SellerAllowlist: a pinned port is enforced", () => {
  const pinned = new SellerAllowlist(["127.0.0.1:53124", "127.0.0.1:53125"]);

  it("permits a URL on a pinned port", () => {
    const result = validateUrl("http://127.0.0.1:53124/v1/rainfall-grid", pinned);
    expect(result.ok).toBe(true);
  });

  it("permits every pinned port for that host", () => {
    expect(validateUrl("http://127.0.0.1:53125/v1/mandi-price", pinned).ok).toBe(true);
  });

  it("refuses a port on an allowlisted host that is not pinned", () => {
    // This is the case the pin exists for: a *different* local service.
    const result = validateUrl("http://127.0.0.1:5432/", pinned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("host-not-allowed");
    expect(result.message).toMatch(/5432/);
    expect(result.message).toMatch(/only 53124, 53125/);
  });

  it("refuses the scheme default port when a port is pinned", () => {
    // `http://127.0.0.1/` implies port 80. A pin on 53124 must not be walked
    // around by omitting the port.
    const result = validateUrl("http://127.0.0.1/", pinned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toMatch(/default/);
  });

  it("refuses a port on an unlisted host", () => {
    // https, so the cleartext rule is not what refuses it - the host allowlist is.
    const result = validateUrl("https://192.168.1.10:53124/x", pinned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("host-not-allowed");
  });

  it("refuses cleartext to a remote host before the port rule, and does not leak which rule was closer", () => {
    const result = validateUrl("http://192.168.1.10:53124/x", pinned);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("plaintext-to-remote-host");
  });
});

describe("SellerAllowlist: hostname-only still permits any port, deliberately", () => {
  const wide = new SellerAllowlist(["127.0.0.1"]);

  it("permits an arbitrary loopback port", () => {
    // Documented, not accidental: the test suite needs this because each case
    // starts a seller on a fresh ephemeral port. `scripts/demo.ts` pins instead.
    expect(validateUrl("http://127.0.0.1:1/x", wide).ok).toBe(true);
    expect(validateUrl("http://127.0.0.1:65535/x", wide).ok).toBe(true);
  });

  it("pinsPorts is false, so the transport guard stands down", () => {
    expect(wide.pinsPorts).toBe(false);
  });
});

describe("loopback host detection", () => {
  it("recognises the loopback spellings", () => {
    for (const host of ["127.0.0.1", "localhost", "::1", "[::1]", "LOCALHOST"]) {
      expect(isLoopbackHost(host)).toBe(true);
    }
  });

  it("does not treat a lookalike as loopback", () => {
    for (const host of [
      "127.0.0.2",
      "127.0.0.1.evil.example",
      "localhost.evil.example",
      "evil.example",
      "0.0.0.0",
      "169.254.169.254",
      "[::2]",
      "",
    ]) {
      expect(isLoopbackHost(host)).toBe(false);
    }
  });
});

describe("transport guard", () => {
  it("passes loopback through when engaged", async () => {
    const inner = recordingTransport();
    const guarded = withTransportGuard(inner, { requireLoopback: true });
    await guarded.request("http://127.0.0.1:53124/x", { headers: {} });
    expect(inner.calls).toEqual(["http://127.0.0.1:53124/x"]);
  });

  it("refuses a non-loopback destination before the inner transport is called", async () => {
    const inner = recordingTransport();
    const guarded = withTransportGuard(inner, { requireLoopback: true });

    for (const target of [
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.5/admin",
      "https://seller.example/data",
      "http://[::2]:80/",
    ]) {
      await expect(guarded.request(target, { headers: {} })).rejects.toBeInstanceOf(TransportGuardError);
    }
    // The decisive assertion: the inner transport was never reached.
    expect(inner.calls).toEqual([]);
  });

  it("refuses an unparseable destination rather than handing it to fetch", async () => {
    const inner = recordingTransport();
    const guarded = withTransportGuard(inner, { requireLoopback: true });
    await expect(guarded.request("not a url at all", { headers: {} })).rejects.toBeInstanceOf(TransportGuardError);
    expect(inner.calls).toEqual([]);
  });

  it("is inert when not engaged, so a real deployment is not broken", async () => {
    const inner = recordingTransport();
    const guarded = withTransportGuard(inner, { requireLoopback: false });
    await guarded.request("https://seller.example/data", { headers: {} });
    expect(inner.calls).toEqual(["https://seller.example/data"]);
  });

  it("engages only for a pinned, loopback-only configuration", () => {
    const pinnedLoopback = new SellerAllowlist(["127.0.0.1:1", "localhost:2"]);
    expect(guardRequiredFor(pinnedLoopback)).toBe(true);

    const hostnameOnly = new SellerAllowlist(["127.0.0.1"]);
    expect(guardRequiredFor(hostnameOnly)).toBe(false);

    const pinnedRemote = new SellerAllowlist(["seller.example:443"]);
    expect(guardRequiredFor(pinnedRemote)).toBe(false);

    const mixed = new SellerAllowlist(["127.0.0.1:1", "seller.example:443"]);
    expect(guardRequiredFor(mixed)).toBe(false);
  });

  it("carries a refusal code the record can show", async () => {
    const guarded = withTransportGuard(recordingTransport(), { requireLoopback: true });
    await expect(guarded.request("http://10.1.1.1/", { headers: {} })).rejects.toMatchObject({
      code: "transport-destination-refused",
    });
  });
});

describe("pinned allowlist does not widen the tool surface", () => {
  it("still refuses every extra argument while a port is pinned", () => {
    const pinned = new SellerAllowlist(["127.0.0.1:53124"]);
    const result = parseToolArguments(
      JSON.stringify({ url: "http://127.0.0.1:53124/x", perCallCeiling: "999999999" }),
      pinned,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.code).toBe("unknown-argument");
  });

  it("exposes the tool name so a UI can render the schema read-only", () => {
    expect(PAID_FETCH_TOOL_NAME).toBe("paid_fetch");
  });
});
