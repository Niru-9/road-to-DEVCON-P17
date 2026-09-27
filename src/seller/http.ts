/**
 * A minimal HTTP server for the local test sellers.
 *
 * Node's `node:http` directly, no Express. P1's install surface is already
 * larger than it needs to be, and a test seller that depends on a framework
 * buries the thing being tested under a dependency tree. The whole point of
 * these servers is to be boring enough to trust.
 *
 * Servers bind to `127.0.0.1` on an ephemeral port, so tests can run
 * concurrently and in any order without a port table.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { once } from "node:events";

export interface RouteContext {
  readonly method: string;
  readonly url: URL;
  readonly request: IncomingMessage;
  /** A header value, case-insensitively. */
  header(name: string): string | undefined;
  /** A query parameter, or `fallback`. */
  param(name: string, fallback?: string): string;
}

export interface SellerResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  /** Serialised as JSON with `content-type: application/json`. */
  readonly body?: unknown;
  /** Sent verbatim, overriding `body`. Used to serve deliberately bad JSON. */
  readonly rawBody?: string;
}

export type RouteHandler = (ctx: RouteContext) => SellerResponse | Promise<SellerResponse>;

export interface Seller {
  readonly name: string;
  /** e.g. `http://127.0.0.1:53124` */
  readonly url: string;
  /** Absolute URL for a path on this seller. */
  resolve(path: string): string;
  /** How many requests this seller has served. Handy in assertions. */
  readonly requestCount: () => number;
  close(): Promise<void>;
}

/** Read a request body as text, bounded so a runaway client cannot OOM us. */
async function readBody(request: IncomingMessage, limit = 1_000_000): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > limit) throw new Error("request body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Start a seller on an ephemeral port.
 *
 * `routes` maps `METHOD /path` to a handler. An exact path match only — the
 * routes here are few and the parameters live in the query string, so a router
 * with patterns would be complexity bought for nothing.
 */
export async function startSeller(name: string, routes: Readonly<Record<string, RouteHandler>>): Promise<Seller> {
  let served = 0;
  // Set once the port is known. Handlers close over this rather than a literal,
  // so a `resource.url` in a 402 is a link the client can actually follow
  // instead of one that silently points at port 80.
  let boundBase = "http://127.0.0.1";

  const server: Server = createServer((request, response) => {
    served += 1;
    void handle(request, response).catch((error: unknown) => {
      // A crash in one handler must not take the seller down mid-suite.
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain" });
      }
      response.end(`seller ${name} handler failed: ${errorText(error)}`);
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", boundBase);
    const key = `${request.method ?? "GET"} ${url.pathname}`;

    const handler = routes[key];
    if (handler === undefined) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: `no route for ${key}` }));
      return;
    }

    const ctx: RouteContext = {
      method: request.method ?? "GET",
      url,
      request,
      header: (wanted: string) => {
        const value = request.headers[wanted.toLowerCase()];
        return Array.isArray(value) ? value[0] : value;
      },
      param: (paramName: string, fallback?: string) => url.searchParams.get(paramName) ?? fallback ?? "",
    };

    // Drain the body so a keep-alive connection is not left half-read.
    const body = await readBody(request);
    void body;

    const result = await handler(ctx);
    const headers: Record<string, string> = { ...(result.headers ?? {}) };
    let payload: string;
    if (result.rawBody !== undefined) {
      payload = result.rawBody;
    } else if (result.body === undefined) {
      payload = "";
    } else {
      headers["content-type"] = headers["content-type"] ?? "application/json";
      payload = JSON.stringify(result.body);
    }
    if (payload !== "" && headers["content-length"] === undefined) {
      headers["content-length"] = String(Buffer.byteLength(payload));
    }

    response.writeHead(result.status, headers);
    response.end(payload);
  }

  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("seller did not bind to a TCP port");
  }

  const base = `http://127.0.0.1:${address.port}`;
  boundBase = base;

  return {
    name,
    url: base,
    resolve: (path: string) => `${base}${path.startsWith("/") ? path : `/${path}`}`,
    requestCount: () => served,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
