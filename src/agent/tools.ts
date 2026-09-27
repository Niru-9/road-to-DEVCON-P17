/**
 * The `paid_fetch` tool definition, and the only place a tool argument is parsed.
 *
 * ## Why the schema is this small
 *
 * This object is sent to a language model on every request, and everything in it
 * is an input the model controls. So the rule is not "don't add dangerous
 * fields" but "there is no field from which a limit could be read".
 *
 * Concretely, there is no way to express:
 *
 * - a budget or a per-call ceiling
 * - a network, asset, payee or scheme allowlist
 * - a facilitator URL or an x402 version
 * - a signer, private key, or "skip the ceiling" flag
 *
 * Not because each is validated, but because no such name exists in the
 * schema. An attacker who has the model in hand can send any JSON they like;
 * they cannot send a name we would read. `additionalProperties: false` plus a
 * `.strict()` parser means an unexpected name is a hard refusal rather than a
 * silently dropped argument, so an exploit attempt is *visible* in the record
 * rather than invisible in a default.
 *
 * `label` is the one non-essential field. It exists so the model can refer to
 * what it fetched in its final answer. It is echoed into a log and never read
 * by anything that decides anything.
 */

import { z } from "zod";

/** The name the model must use. One tool, so this is a constant, not a config. */
export const PAID_FETCH_TOOL_NAME = "paid_fetch";

/**
 * JSON Schema for the arguments, exactly as sent to the model.
 *
 * Exported so a test can assert the wire payload against it rather than against
 * a hand-copied literal that would drift.
 */
export const PAID_FETCH_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    url: {
      type: "string",
      description:
        "Absolute https URL of the resource to fetch. Must be on a seller host " +
        "this purse has been configured to pay.",
    },
    label: {
      type: "string",
      maxLength: 64,
      description: "Optional short name for the resource, echoed into the run record.",
    },
  },
  required: ["url"],
  additionalProperties: false,
} as const;

export const PAID_FETCH_TOOL_DESCRIPTION =
  "Fetch a priced dataset. If the seller asks for payment, the purse decides " +
  "whether to pay based on its own frozen policy - you do not set, raise or " +
  "lower any limit. Returns the data, or a refusal explaining which rule fired.";

/** The complete tool object, in OpenAI chat-completions shape. */
export const PAID_FETCH_TOOL = {
  type: "function",
  function: {
    name: PAID_FETCH_TOOL_NAME,
    description: PAID_FETCH_TOOL_DESCRIPTION,
    parameters: PAID_FETCH_TOOL_PARAMETERS,
  },
} as const;

/** Exactly the tools array sent on every model request. One tool. */
export const PAID_FETCH_TOOLS = [PAID_FETCH_TOOL] as const;

/**
 * The runtime schema.
 *
 * `.strict()` is the load-bearing part: an unknown property is an error, not
 * something ignored. The JSON Schema already says `additionalProperties: false`,
 * but a model is not obliged to honour a schema, so the parse is repeated here
 * on the server side. Belt, braces, and a refusal reason in the record.
 */
export const PaidFetchArgs = z
  .object({
    url: z.string().min(1).max(2048),
    label: z.string().min(1).max(64).optional(),
  })
  .strict();

export type PaidFetchArgs = z.infer<typeof PaidFetchArgs>;

/** Why a tool call did not reach the gate. */
export type ToolArgumentError =
  | "malformed-json"
  | "unknown-argument"
  | "bad-url"
  | "scheme-not-allowed"
  | "credentials-in-url"
  | "host-not-allowed"
  | "plaintext-to-remote-host";

export interface ToolArgumentFailure {
  readonly ok: false;
  readonly code: ToolArgumentError;
  readonly message: string;
}

export interface ToolArgumentSuccess {
  readonly ok: true;
  readonly args: PaidFetchArgs;
}

export type ToolArgumentResult = ToolArgumentSuccess | ToolArgumentFailure;

/**
 * Hosts this purse will pay, or fetch from, at all.
 *
 * ## Why this exists
 *
 * Without it, `paid_fetch` is an unrestricted HTTP client with a budget
 * attached: a model (or anyone who can steer it) could point it at a cloud
 * metadata endpoint, an internal admin port, or a file:// URL, and read the
 * response back out of the transcript. That is a server-side request forgery
 * primitive, and it is a *worse* bug than the one this project exists to prevent,
 * because the response arrives as trusted-looking tool output.
 *
 * So the host list is a second, independent allowlist. The x402 asset allowlist
 * in `src/policy/allowlist.ts` decides what the purse will *spend* on; this one
 * decides where it will *go*. They are separate on purpose: an allowlisted
 * seller on a disallowed host is still refused.
 *
 * ## Host *and* port
 *
 * An entry may be `example.com` (any port) or `example.com:8443` (that port
 * only). The distinction matters because hostname-only matching means an
 * allowlisted loopback host is reachable on *every* port, which on a developer
 * machine includes unrelated local services - a database, a metrics endpoint, an
 * admin port.
 *
 * So:
 *
 * - `scripts/demo.ts` pins the exact ports of the two sellers it just started, so
 *   the shipped demo can only reach those two processes and nothing else on the
 *   machine.
 * - the test suite uses hostname-only entries, because it starts a fresh
 *   ephemeral-port seller per case and pinning a port it does not know yet is not
 *   possible. That is a deliberate, recorded concession: a test asserting on
 *   behaviour is not a deployment surface.
 *
 * `permitsUrl` is the check the dispatcher uses. The hostname-only `permits`
 * remains for callers that only have a hostname.
 */
export class SellerAllowlist {
  /** host → the ports pinned for it, or `null` for "any port on this host". */
  private readonly portsByHost: ReadonlyMap<string, ReadonlySet<number> | null>;
  private readonly loopback: boolean;

  constructor(hosts: readonly string[]) {
    const cleaned = hosts.map((host) => host.trim().toLowerCase()).filter((host) => host !== "");
    if (cleaned.length === 0) {
      throw new Error("SellerAllowlist needs at least one host; an empty list would be an open fetcher");
    }

    const map = new Map<string, Set<number> | null>();
    for (const entry of cleaned) {
      const { host, port } = splitEntry(entry);
      const existing = map.get(host);
      if (port === null) {
        // A bare host permits any port, so it subsumes any pin for the same host.
        map.set(host, null);
        continue;
      }
      if (port === 0) {
        throw new Error(`SellerAllowlist entry "${entry}" pins port 0, which is never a real destination`);
      }
      if (existing === null) {
        // Already "any port" from a bare entry; the pin adds nothing.
        continue;
      }
      (map.get(host) ?? map.set(host, new Set()).get(host)!).add(port);
    }

    this.portsByHost = new Map(
      [...map.entries()].map(([host, ports]) => [host, ports === null ? null : new Set(ports)]),
    );
    this.loopback = [...this.portsByHost.keys()].some(isLoopbackHost);
  }

  /** The configured entries, for the run record. */
  get entries(): readonly string[] {
    return [...this.portsByHost.entries()]
      .flatMap(([host, ports]) =>
        ports === null ? [host] : [...ports].sort((a, b) => a - b).map((port) => `${host}:${port}`),
      )
      .sort();
  }

  /** Every configured host, ignoring any pinned port. */
  get hosts(): readonly string[] {
    return [...this.portsByHost.keys()].sort();
  }

  /**
   * True when *no* entry pins a port.
   *
   * The transport guard uses this: hostname-only on loopback means the fetch
   * could reach any local port, so the caller gets a loopback-only guard rather
   * than false confidence.
   */
  get pinsPorts(): boolean {
    return [...this.portsByHost.values()].every((ports) => ports !== null);
  }

  permits(hostname: string): boolean {
    return this.portsByHost.has(hostname.toLowerCase());
  }

  /** Full check, honouring pinned ports. This is what the dispatcher calls. */
  permitsUrl(url: URL): boolean {
    const ports = this.portsByHost.get(url.hostname.toLowerCase());
    if (ports === undefined) {
      return false;
    }
    if (ports === null) {
      return true;
    }
    // A URL with no explicit port uses the scheme default. If the operator pinned
    // ports, the URL must name one of them, otherwise default ports are a way
    // around the pin.
    if (url.port === "") {
      return false;
    }
    return ports.has(Number(url.port));
  }

  /** The pinned ports for a host; empty means "any port", which is not a pin. */
  portsFor(hostname: string): readonly number[] {
    const ports = this.portsByHost.get(hostname.toLowerCase());
    return ports === null || ports === undefined ? [] : [...ports].sort((a, b) => a - b);
  }

  /**
   * Loopback only if the operator allowlisted loopback.
   *
   * Used to decide whether plaintext `http:` is acceptable, so a deployment
   * that allowlists only real hosts cannot be talked into cleartext.
   */
  get allowsLoopback(): boolean {
    return this.loopback;
  }
}

/** `example.com:8443` → `{host, port: 8443}`; `example.com` → `{host, port: null}`. */
function splitEntry(entry: string): { host: string; port: number | null } {
  // Bracketed IPv6 (`[::1]:8080`) puts the port after a bracket; a bare IPv6
  // literal has many colons and no port. Handle both.
  const bracketed = /^\[(.+)\]:(\d+)$/.exec(entry);
  if (bracketed !== null) {
    return { host: `[${bracketed[1]}]`, port: Number(bracketed[2]) };
  }
  const lastColon = entry.lastIndexOf(":");
  if (lastColon === -1 || entry.indexOf(":") !== lastColon) {
    // No colon, or more than one colon: a bare IPv6 literal, port-less.
    return { host: entry, port: null };
  }
  const portText = entry.slice(lastColon + 1);
  if (!/^\d+$/.test(portText)) {
    // Something like `example.com:https` - a hostname, not a host:port.
    return { host: entry, port: null };
  }
  const host = entry.slice(0, lastColon);
  if (host === "") {
    throw new Error(`SellerAllowlist entry "${entry}" has a port but no host`);
  }
  return { host, port: Number(portText) };
}

function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bare === "127.0.0.1" || bare === "localhost" || bare === "::1";
}

/** Parse and validate tool arguments from a model response. */
export function parseToolArguments(rawArguments: string | unknown, allowlist: SellerAllowlist): ToolArgumentResult {
  let candidate: unknown;
  if (typeof rawArguments === "string") {
    // Models emit a JSON *string* here. An empty string is what several models
    // send for a no-argument call, and this tool has one required argument, so
    // it cannot be legitimate - but it should fail as "missing url", not as
    // "malformed json".
    if (rawArguments.trim() === "") {
      return { ok: false, code: "malformed-json", message: "arguments were empty; url is required" };
    }
    try {
      candidate = JSON.parse(rawArguments) as unknown;
    } catch {
      return { ok: false, code: "malformed-json", message: "arguments were not valid JSON" };
    }
  } else {
    candidate = rawArguments;
  }

  const parsed = PaidFetchArgs.safeParse(candidate);
  if (!parsed.success) {
    // Distinguish "sent a name we do not have" from "sent the wrong shape",
    // because the first is the interesting attack.
    const unknownKey =
      typeof candidate === "object" && candidate !== null
        ? Object.keys(candidate as object).find((key) => key !== "url" && key !== "label")
        : undefined;
    if (unknownKey !== undefined) {
      return {
        ok: false,
        code: "unknown-argument",
        message: `argument "${unknownKey}" is not part of this tool and was refused`,
      };
    }
    const first = parsed.error.issues[0];
    return {
      ok: false,
      code: "unknown-argument",
      message: `arguments rejected: ${first?.path.join(".") || "(root)"} ${first?.message ?? "invalid"}`,
    };
  }

  const url = validateUrl(parsed.data.url, allowlist);
  if (!url.ok) return url;
  return {
    ok: true,
    args: {
      url: url.args.url,
      // `exactOptionalPropertyTypes` is on, so an absent label must be absent,
      // not `undefined`.
      ...(parsed.data.label === undefined ? {} : { label: parsed.data.label }),
    },
  };
}

/** Apply the host and scheme rules to an already-parsed URL string. */
export function validateUrl(url: string, allowlist: SellerAllowlist): ToolArgumentResult {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, code: "bad-url", message: `not an absolute URL: ${url.slice(0, 120)}` };
  }

  // Credentials in a URL are a classic way to make a request look like it is
  // going somewhere it is not, and they leak into logs. Refuse them outright.
  if (parsed.username !== "" || parsed.password !== "") {
    return { ok: false, code: "credentials-in-url", message: "URLs with embedded credentials are refused" };
  }

  const isLoopback = parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    return {
      ok: false,
      code: "scheme-not-allowed",
      message: `scheme ${parsed.protocol} is not allowed; use https (or http for a loopback seller)`,
    };
  }
  if (parsed.protocol === "http:" && !isLoopback) {
    // Cleartext to anything that is not loopback. The local demo sellers are
    // loopback HTTP; nothing else should be.
    return {
      ok: false,
      code: "plaintext-to-remote-host",
      message: "cleartext http is only permitted to a loopback seller host",
    };
  }

  if (!allowlist.permits(parsed.hostname)) {
    return {
      ok: false,
      code: "host-not-allowed",
      message: `host ${parsed.hostname} is not an allowlisted seller (allowed: ${allowlist.entries.join(", ")})`,
    };
  }

  // The host is right; the port may still not be, if the operator pinned one.
  if (!allowlist.permitsUrl(parsed)) {
    const pinned = allowlist.portsFor(parsed.hostname);
    return {
      ok: false,
      code: "host-not-allowed",
      message:
        `port ${parsed.port === "" ? `(default)` : parsed.port} is not allowed for ${parsed.hostname}` +
        (pinned.length === 0 ? "" : `; only ${pinned.join(", ")} ${pinned.length === 1 ? "is" : "are"} allowed`),
    };
  }

  return { ok: true, args: { url: parsed.toString() } };
}
