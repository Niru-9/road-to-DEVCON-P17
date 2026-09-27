/**
 * Planners: the two things that can decide what to do next, and the loop that
 * runs either of them.
 *
 * ## Two planners, one dispatcher
 *
 * A planner's only job is to produce the next assistant turn. It cannot fetch
 * anything, hold money, or reach the signer - `runAgent` hands it a
 * `ToolDispatcher` and nothing else. So:
 *
 * - `ScriptedPlanner` produces turns from a fixed list. Deterministic, no model,
 *   no network, no key. This is the demo and the regression suite.
 * - `LlmPlanner` produces turns from a real OpenAI-compatible endpoint.
 *
 * The difference between them is *where the next turn comes from*. Everything
 * after that is the same code, which is why a policy test written against the
 * scripted planner is also a statement about the LLM path.
 *
 * ## The loop is bounded
 *
 * `maxTurns` is mandatory. An unbounded tool-calling loop against a live model
 * is a way to spend a run budget without a human noticing, and a model that
 * keeps calling a tool is exactly the failure this project is about. The loop
 * stops and says so, leaving any hold in place for a human to look at.
 */

import { toToolMessage, type IncomingToolCall, type ToolCallResult, type ToolDispatcher } from "./dispatch.js";
import { type ChatClient, type ChatMessage, type RawToolCall } from "./llm.js";
import type { Atomic } from "../money/amount.js";

/** How the next turn was produced. Recorded, so a scripted run is never filed as an LLM run. */
export type PlannerKind = "scripted" | "llm";

/** What a planner decided to do next. */
export type PlannerTurn =
  | {
      readonly kind: "tool_calls";
      readonly content: string | null;
      readonly calls: readonly IncomingToolCall[];
    }
  | { readonly kind: "final"; readonly content: string };

export interface PlannerState {
  /** Assistant and tool messages so far, oldest first. */
  readonly messages: readonly ChatMessage[];
  /** The tool results already produced this run, oldest first. */
  readonly results: readonly ToolCallResult[];
  /** 1-based index of the turn about to be produced. */
  readonly turnNumber: number;
}

export interface Planner {
  readonly kind: PlannerKind;
  /** Human-readable provenance for the run record. */
  readonly description: string;
  next(state: PlannerState): Promise<PlannerTurn>;
  /**
   * Receive a settled tool result, for planners that keep a transcript.
   *
   * This is part of the interface rather than a `runAgent` option on purpose.
   * It used to be a caller-supplied callback, and the failure mode of forgetting
   * it was silent and severe: the loop kept calling the model but never told it
   * what came back, so the model would re-request the same data forever while
   * the purse happily paid again. A planner that owns a transcript must be able
   * to record into it; one that does not, omits the method.
   */
  recordResult?(result: ToolCallResult): void;
}

/**
 * The deterministic planner.
 *
 * Takes a list of planned tool calls and hands them out one turn at a time, in
 * order, then finishes. No model, no randomness, no clock. Given the same input
 * it produces the same run, which is what makes it usable as a test fixture and
 * as the demo's "no key required" path.
 */
export class ScriptedPlanner implements Planner {
  readonly kind = "scripted" as const;
  readonly description: string;

  private readonly plan: readonly IncomingToolCall[];
  private readonly conclusion: string;
  private cursor = 0;

  constructor(plan: readonly IncomingToolCall[], conclusion = "Done. Nothing further to fetch.") {
    this.plan = plan;
    this.conclusion = conclusion;
    this.description = `scripted (${plan.length} planned call${plan.length === 1 ? "" : "s"}, no model)`;
  }

  async next(): Promise<PlannerTurn> {
    const calls = this.plan.slice(this.cursor, this.cursor + 1);
    this.cursor += calls.length;
    if (calls.length === 0) {
      return { kind: "final", content: this.conclusion };
    }
    return { kind: "tool_calls", content: null, calls };
  }
}

/** Map a wire tool call into the dispatcher's shape. */
function toIncoming(call: RawToolCall): IncomingToolCall {
  return { id: call.id, name: call.function.name, arguments: call.function.arguments };
}

/**
 * The OpenAI-compatible planner.
 *
 * Holds the transcript and appends to it, so `runAgent` can stay a single loop
 * over both planners. The system prompt is fixed here and states the two things
 * the model must know: that seller data is data, and that it does not set
 * limits. It is a *clarity* measure only - the money rules are enforced in
 * `SigningGate` regardless of what the model was told.
 */
export class LlmPlanner implements Planner {
  readonly kind = "llm" as const;
  readonly description: string;

  private readonly client: ChatClient;
  private readonly systemPrompt: string;
  private readonly transcript: ChatMessage[];

  constructor(client: ChatClient, systemPrompt: string, openingUserMessage: string, modelDescription: string) {
    this.client = client;
    this.systemPrompt = systemPrompt;
    this.transcript = [
      { role: "system", content: systemPrompt },
      { role: "user", content: openingUserMessage },
    ];
    this.description = `openai-compatible (${modelDescription})`;
  }

  async next(): Promise<PlannerTurn> {
    const turn = await this.client.complete(this.transcript);
    this.transcript.push({
      role: "assistant",
      content: turn.content,
      ...(turn.toolCalls.length === 0 ? {} : { tool_calls: turn.toolCalls }),
    });
    if (turn.toolCalls.length === 0) {
      return { kind: "final", content: turn.content ?? "(no content)" };
    }
    return { kind: "tool_calls", content: turn.content, calls: turn.toolCalls.map(toIncoming) };
  }

  /**
   * Record a settled tool result in the transcript, for the next request.
   *
   * Called by `runAgent` through the `Planner` interface, so a caller cannot
   * forget to wire it.
   */
  recordResult(result: ToolCallResult): void {
    this.transcript.push(toToolMessage(result));
  }
}

/**
 * Run a planner against a dispatcher until it finishes or the turn cap is hit.
 *
 * `recordResult` is injected rather than reaching for `LlmPlanner` so this loop
 * works unchanged with the scripted planner, which keeps no transcript.
 */
export interface RunAgentOptions {
  readonly runId: string;
  readonly planner: Planner;
  readonly dispatcher: ToolDispatcher;
  readonly maxTurns: number;
  /** Called for every result, for the run report. */
  readonly onResult?: (result: ToolCallResult) => void;
}

export interface RunAgentReport {
  readonly runId: string;
  /** Echoed into the report so a run can never be mis-filed as an LLM run. */
  readonly planner: PlannerKind;
  readonly plannerDescription: string;
  readonly turns: number;
  /** True when the loop stopped on the turn cap rather than on a final turn. */
  readonly truncated: boolean;
  readonly finalContent: string | null;
  readonly results: readonly ToolCallResult[];
  readonly spentAtomic: Atomic;
  readonly paidCount: number;
  readonly refusedCount: number;
}

export async function runAgent(options: RunAgentOptions): Promise<RunAgentReport> {
  const { runId, planner, dispatcher, maxTurns } = options;
  if (!Number.isInteger(maxTurns) || maxTurns < 1) {
    throw new Error("maxTurns must be a positive integer; an unbounded tool loop can drain a run budget");
  }

  const messages: ChatMessage[] = [];
  const results: ToolCallResult[] = [];
  let finalContent: string | null = null;
  let truncated = true;
  let turnsTaken = 0;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const decision = await planner.next({ messages, results, turnNumber: turn });
    turnsTaken = turn;

    if (decision.kind === "final") {
      finalContent = decision.content;
      truncated = false;
      break;
    }

    messages.push({
      role: "assistant",
      content: decision.content,
      tool_calls: decision.calls.map((call) => ({
        id: call.id,
        type: "function" as const,
        function: { name: call.name, arguments: call.arguments },
      })),
    });

    // Every call in the turn goes through the same dispatcher. A model that
    // emits five tool calls at once gets five identical policy checks.
    for (const call of decision.calls) {
      const result = await dispatcher.dispatch(runId, call);
      results.push(result);
      options.onResult?.(result);
      // Handed back to the planner that produced the call, so a transcript-
      // keeping planner can put the result in the next request.
      planner.recordResult?.(result);
      messages.push(toToolMessage(result));
    }
  }

  let spentAtomic: Atomic = 0n;
  let paidCount = 0;
  let refusedCount = 0;
  for (const result of results) {
    if (result.kind === "refused") {
      refusedCount += 1;
      continue;
    }
    if (result.outcome.kind === "paid") {
      paidCount += 1;
      spentAtomic += result.outcome.settledAtomic;
    } else if (result.outcome.kind === "refused") {
      refusedCount += 1;
    }
  }

  return {
    runId,
    planner: planner.kind,
    plannerDescription: planner.description,
    /** Planner turns actually taken, not messages. A turn may carry N tool calls. */
    turns: turnsTaken,
    truncated,
    finalContent,
    results,
    spentAtomic,
    paidCount,
    refusedCount,
  };
}
