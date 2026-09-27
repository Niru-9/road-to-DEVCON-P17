/**
 * The UI server: a read-only window onto a real run.
 *
 * ## The one rule
 *
 * **This process exposes no way to change policy.**
 *
 * There is no endpoint that accepts a ceiling, a budget, a network, an asset, a
 * payee, a host, a port or a key. `GET /api/policy` reports what the purse is
 * using and `POST /api/run` starts a run with whatever the environment already
 * froze — the request body is not read at all, so there is no field for a caller
 * to smuggle a limit into. If someone finds a way to move these numbers, the bug
 * is in `src/config/env.ts`, not in a missing check here, because this file never
 * looks at a limit.
 *
 * ## Same run, not a re-enactment
 *
 * `POST /api/run` calls `PurseRuntime.run`, which is the same `runAgent` +
 * `ToolDispatcher` + `SigningGate` + real HTTP seller path the CLI and the tests
 * use. The UI renders events as they happen; it does not decide anything.
 *
 * ## Bound to loopback
 *
 * The listener is pinned to `127.0.0.1` and a non-loopback bind address is
 * refused rather than honoured. An unauthenticated page that shows spend and
 * tool traffic has no business being reachable from the network, and the whole
 * point of the port-pinning work elsewhere is that loopback is the boundary worth
 * protecting. It is still a boundary a local process can cross — this is a demo
 * UI, not a hardened service.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, resolve, sep } from "node:path";
import { formatUsd } from "../money/amount.js";
import { buildRunRecord, heldNow, serialiseRecord, type RunRecord } from "../app/record.js";
import { toModelContent } from "../agent/dispatch.js";
import { DEMO_MAX_TURNS, DEMO_QUESTION, type PurseRuntime, type RunEvent } from "../app/runtime.js";
import { loadConfig } from "../config/env.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(HERE, "..", "..");
const PUBLIC_DIR = join(PROJECT_ROOT, "public");

/** Content types for the three static files. Nothing else is served. */
const STATIC: Readonly<Record<string, { readonly file: string; readonly type: string }>> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
};

/**
 * The paths this server actually serves, and the methods each one answers.
 *
 * Used to tell a wrong method on a real route (405, with `Allow`) from a path
 * that was never here at all (404). Both are refusals; only one of them is a
 * truthful description of what happened.
 */
const ROUTE_METHODS: Readonly<Record<string, readonly string[]>> = {
  "/": ["GET"],
  "/index.html": ["GET"],
  "/styles.css": ["GET"],
  "/app.js": ["GET"],
  "/favicon.ico": ["GET"],
  "/api/policy": ["GET"],
  "/api/record": ["GET"],
  "/api/run": ["POST"],
};

/** Paths that exist, for the 405-vs-404 decision. `/` also answers as `/index.html`. */
const KNOWN_PATHS: ReadonlySet<string> = new Set(Object.keys(ROUTE_METHODS));

/** Every method any route accepts, for the `Allow` header on a 405. */
const ALLOWED_METHODS: string = [...new Set(Object.values(ROUTE_METHODS).flat())].sort().join(", ");

export interface UiServerOptions {
  /** Builds a fresh runtime. A new one per run, so a run is never a re-enactment. */
  readonly createRuntime: () => Promise<PurseRuntime>;
  /** Where `decision-log.json` is written and read from. */
  readonly recordPath: string;
  /** Defaults to `0`, which asks the OS for a free port. */
  readonly port?: number;
  /** Must be a loopback address. Anything else is refused. */
  readonly host?: string;
}

export interface UiServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export async function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    // Refused rather than clamped, so the caller learns the bind was wrong
    // instead of silently getting a loopback server it did not ask for.
    throw new Error(`refusing to bind the demo UI to ${host}: it exposes spend and tool traffic, so it stays on loopback`);
  }

  /** The run currently being rendered, if any. */
  let active: PurseRuntime | null = null;

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, { error: messageOf(error) });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", `http://${host}`);
    const path = url.pathname;

    if (req.method === "GET" && STATIC[path] !== undefined) {
      return await sendStatic(res, STATIC[path].file, STATIC[path].type);
    }
    if (req.method === "GET" && path === "/api/policy") {
      return sendJson(res, 200, policyView());
    }
    if (req.method === "GET" && path === "/api/record") {
      return await sendRecord(res);
    }
    if (req.method === "POST" && path === "/api/run") {
      return await runOverSse(req, res);
    }
    // A browser asks for /favicon.ico unprompted. Answering it is cheaper than
    // letting the request fail: a console full of red is the first thing a
    // reader sees, and it buries the one error that matters.
    if (req.method === "GET" && path === "/favicon.ico") {
      res.writeHead(204, { "cache-control": "public, max-age=86400" });
      res.end();
      return;
    }
    // Everything else is refused, and the body is never read on any route:
    // there is nowhere for a limit to enter.
    //
    // The status distinguishes "no such thing here" from "that exists, not like
    // that". Both refuse equally - neither reads the body, neither can change a
    // limit - but a 405 on a path that does not exist is a false claim, and it
    // is what made a routine favicon probe look like a server fault.
    const knownPath = KNOWN_PATHS.has(path);
    if (knownPath) {
      res.writeHead(405, { allow: ALLOWED_METHODS, "content-type": "text/plain; charset=utf-8" });
      res.end("method not allowed");
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }

  /**
   * The read-only policy view.
   *
   * Built from a fresh `loadConfig()` rather than from a running runtime, so it
   * answers before any run has started. It is the same frozen numbers the gate
   * will use.
   */
  function policyView() {
    const config = loadConfig();
    const { limits, allowlist } = config.policy;
    return {
      question: DEMO_QUESTION,
      editable: false,
      limits: {
        perCallCeilingAtomic: limits.perCallCeiling.toString(),
        perCallCeilingUsd: formatUsd(limits.perCallCeiling),
        runBudgetAtomic: limits.runBudget.toString(),
        runBudgetUsd: formatUsd(limits.runBudget),
      },
      allowlist: {
        networks: [...allowlist.networks].sort(),
        schemes: [...allowlist.schemes].sort(),
        payees: [...config.policy.allowedPayees].sort(),
        sellerHosts: [...config.allowedSellerHosts],
      },
      planner: config.planner,
      settlement: {
        chainTouched: false,
        realFundsMoved: false,
        mode: "local-stub" as const,
        note:
          "No chain is touched. The signer is a deterministic stub and the facilitator is " +
          "an in-process stub, so any 'paid' result in this UI means a local policy and " +
          "protocol decision - never money that moved.",
      },
      ledgerPath: config.ledgerPath,
      maxTurns: DEMO_MAX_TURNS,
    };
  }

  async function sendRecord(res: ServerResponse): Promise<void> {
    try {
      const text = await readFile(options.recordPath, "utf8");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
      res.end(text);
    } catch {
      sendJson(res, 404, {
        error: "no run recorded yet",
        hint: "POST /api/run, or run `npm run demo`",
      });
    }
  }

  /**
   * Run, streaming progress as server-sent events.
   *
   * The browser gets the same `RunEvent`s the record is built from, so what the
   * page showed and what `decision-log.json` says cannot diverge.
   */
  async function runOverSse(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (active !== null) {
      sendJson(res, 409, { error: "a run is already in progress" });
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    const send = (event: string, data: unknown): void => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    // Held separately from the runtime so the `finally` can close it without the
    // closure below having to reason about a nullable `let`. A run that created a
    // runtime owns it, whether it finished or threw.
    let closeRuntime: (() => Promise<void>) | null = null;
    // Kept so a failure can name the file it was writing to. The demo points the
    // UI at its own ledger, which is not the configured one.
    let failedRuntime: PurseRuntime | null = null;
    try {
      const runtime = await options.createRuntime();
      closeRuntime = runtime.close;
      failedRuntime = runtime;
      active = runtime;
      send("start", {
        runId: runtime.runId,
        planner: runtime.plannerKind,
        plannerDescription: runtime.buildPlanner().description,
        transportGuardEngaged: runtime.transportGuardEngaged,
        allowedSellerHosts: runtime.allowlist.entries,
      });

      const events: RunEvent[] = [];
      const report = await runtime.run({
        onEvent: (event) => {
          events.push(event);
          // The quote is not on the gate outcome, so it is read from the ledger row
          // the attempt just wrote - the same row `buildRunRecord` reads. Streaming
          // a figure the record would not agree with would make the live table and
          // the saved file tell different stories, which is the one thing this UI
          // is for.
          const row =
            event.result.kind === "settled" ? runtime.ledger.get(event.result.outcome.attemptId) : null;
          send("result", {
            index: event.index,
            spentAfter: event.spentAfter.toString(),
            spentAfterUsd: event.spentAfterUsd,
            result: {
              kind: event.result.kind,
              callId: event.result.callId,
              tool: event.result.toolName,
              label: event.result.label,
              code: event.result.kind === "refused" ? event.result.code : null,
              reason: event.result.kind === "refused" ? event.result.reason : null,
              gateOutcome: event.result.kind === "settled" ? event.result.outcome.kind : null,
              quotedAtomic: row?.quoteAtomic ?? null,
              ledgerState: row?.state ?? null,
              heldAtomic: row === null ? null : heldNow(row),
              settledAtomic:
                event.result.kind === "settled" && event.result.outcome.kind === "paid"
                  ? event.result.outcome.settledAtomic.toString()
                  : null,
              httpStatus: event.result.kind === "settled" ? event.result.outcome.status : null,
              untrusted:
                event.result.kind === "settled" && event.result.untrusted !== null
                  ? { source: event.result.untrusted.source, content: event.result.untrusted.render() }
                  : null,
              modelContent: toModelContent(event.result),
            },
          });
        },
      });

      const record: RunRecord = buildRunRecord({ runtime, report, events, maxTurns: DEMO_MAX_TURNS });
      await writeRecord(options.recordPath, record);
      send("end", { runId: report.runId, turns: report.turns, truncated: report.truncated, recordPath: options.recordPath });
    } catch (error) {
      // A bare SQLite message tells a reader nothing they can act on. Say which
      // run died, what the message means here, and which file to look at, so the
      // page reports the failure instead of making the reader guess.
      send("error", {
        message: messageOf(error),
        runId: failedRuntime?.runId ?? "unknown",
        detail: describeRunFailure(error),
        ledgerPath: ledgerPathOf(failedRuntime),
      });
    } finally {
      if (closeRuntime !== null) await closeRuntime();
      active = null;
      res.end();
    }
  }

  /**
   * Turn a thrown error into something a reader can act on.
   *
   * The one failure worth naming explicitly is a unique-constraint violation on
   * `attempts.id`: it means the ledger already holds an id the run tried to
   * reuse, which is a bug in id allocation rather than a seller being hostile.
   * Without that distinction it reads like one of the refusals above it.
   */
  function describeRunFailure(error: unknown): string {
    const message = messageOf(error);
    if (/UNIQUE constraint failed:\s*attempts\.id/i.test(message)) {
      return (
        "The ledger already holds an attempt id this run tried to reuse. Attempt ids are " +
        "allocated by the ledger now, so this should be impossible; if you are seeing it, " +
        "the ledger was written by a build that minted ids in memory."
      );
    }
    if (/UNIQUE constraint failed/i.test(message)) {
      return "The ledger refused a duplicate row. The run stopped before it could finish; nothing was settled.";
    }
    return "The run stopped partway through. No record was written, so the tables above are empty rather than partial.";
  }

  /** The ledger this run is writing to, for a reader who needs to look. */
  function ledgerPathOf(runtime: PurseRuntime | null): string {
    // From the runtime, not from `loadConfig()`: the demo deliberately points the
    // UI at its own ledger file, so the configured path would name the wrong one.
    return runtime === null ? "unknown" : runtime.ledger.location;
  }

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(options.port ?? 0, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : (options.port ?? 0);

  return {
    url: `http://${host}:${port}/`,
    port,
    close: () =>
      new Promise<void>((resolveClose) => {
        server.closeAllConnections();
        server.close(() => resolveClose());
      }),
  };
}

async function sendStatic(res: ServerResponse, file: string, type: string): Promise<void> {
  // Resolve inside PUBLIC_DIR and confirm containment, so a crafted path cannot
  // read the ledger or a private key out of the project.
  const target = resolve(PUBLIC_DIR, normalize(file));
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + sep)) {
    sendJson(res, 403, { error: "refused" });
    return;
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("not found");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}


export async function writeRecord(path: string, record: RunRecord): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialiseRecord(record), "utf8");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
