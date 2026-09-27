/**
 * A minimal, real OpenAI-compatible chat client.
 *
 * Deliberately hand-rolled rather than pulled from the `openai` SDK: the whole
 * point of this project is that the request the model receives is *visible in
 * this repository*. A 200KB SDK makes the request body an implementation
 * detail; here it is an object literal a test can deep-compare.
 *
 * "OpenAI-compatible" is the wire contract of `POST {baseUrl}/chat/completions`
 * with `messages`, `tools` and `tool_choice`. That is what vLLM, llama.cpp,
 * LM Studio, Ollama's compat endpoint, OpenRouter, Together, Groq and OpenAI
 * itself all speak, so the demo runs against a local server and the same code
 * can point at a hosted one.
 *
 * Nothing here decides anything about money. It builds a request, posts it, and
 * parses a response. The tool schema is a constant, not a parameter, so no
 * caller can widen what the model is offered.
 */

import { z } from "zod";
import { PAID_FETCH_TOOLS } from "./tools.js";
import type { ToolResultMessage } from "./dispatch.js";

/**
 * One chat message.
 *
 * `tool_calls` on an assistant message and `tool_call_id` on a tool message are
 * the two halves of the tool-calling protocol; keeping them in one type means a
 * malformed pair is a type error rather than a mystery at the API.
 */
export type ChatMessage =
  | { readonly role: "system"; readonly content: string }
  | { readonly role: "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly tool_calls?: readonly RawToolCall[];
    }
  | ToolResultMessage;

export interface RawToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

const RawToolCallSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("function"),
    function: z
      .object({
        name: z.string().min(1),
        // Models routinely pad or mangle this; it is JSON *text* and is parsed
        // and validated separately, strictly. See `parseToolArguments`.
        arguments: z.string(),
      })
      .strict(),
  })
  .strict();

const UsageSchema = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
  })
  .passthrough();

const ChatResponseSchema = z
  .object({
    choices: z
      .array(
        z
          .object({
            message: z
              .object({
                role: z.string(),
                content: z.string().nullable().optional(),
                tool_calls: z.array(RawToolCallSchema).optional(),
              })
              .passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .min(1),
    usage: UsageSchema.optional(),
  })
  .passthrough();

export interface ChatUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
}

export interface ChatTurn {
  /** The model's prose, if any. May be null on a pure tool-call turn. */
  readonly content: string | null;
  readonly toolCalls: readonly RawToolCall[];
  readonly finishReason: string | null;
  readonly usage: ChatUsage | null;
  /**
   * The exact request body that was sent.
   *
   * Exposed so the test suite can assert the tool schema reached the wire
   * without re-implementing the request builder - a test that rebuilds the body
   * itself can only ever agree with itself.
   */
  readonly requestBody: Readonly<Record<string, unknown>>;
}

export interface ChatClient {
  complete(messages: readonly ChatMessage[]): Promise<ChatTurn>;
}

export interface ChatClientOptions {
  readonly baseUrl: string;
  readonly model: string;
  /** Omitted when talking to a local server, which is the hermetic test path. */
  readonly apiKey?: string | undefined;
  readonly timeoutMs?: number | undefined;
  /** Injectable so tests do not depend on the global fetch. */
  readonly fetchImpl?: typeof fetch | undefined;
}

export class ChatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatError";
  }
}

export interface CreateChatClientDeps {
  readonly fetchImpl?: typeof fetch | undefined;
}

/** Join a base URL and a path without doubling or dropping the slash. */
function endpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

/**
 * Build the request body.
 *
 * The tool definition is attached unconditionally. There is no code path in
 * this file that omits `tools`, so "the paid-fetch definition is passed on every
 * model request" is a property of the code and not of a caller's discipline.
 */
export function buildRequestBody(model: string, messages: readonly ChatMessage[]): Readonly<Record<string, unknown>> {
  return {
    model,
    messages,
    tools: PAID_FETCH_TOOLS,
    tool_choice: "auto",
  };
}

export function createChatClient(options: ChatClientOptions, deps: CreateChatClientDeps = {}): ChatClient {
  const doFetch = options.fetchImpl ?? deps.fetchImpl ?? fetch;
  const url = endpoint(options.baseUrl);
  const timeoutMs = options.timeoutMs ?? 60_000;

  return {
    async complete(messages: readonly ChatMessage[]): Promise<ChatTurn> {
      const body = buildRequestBody(options.model, messages);

      const headers: Record<string, string> = { "content-type": "application/json" };
      if (options.apiKey !== undefined && options.apiKey !== "") {
        headers.authorization = `Bearer ${options.apiKey}`;
      }

      // A hung model must not hang the purse. A timeout surfaces as a refusal
      // to the caller, which stops the run with the hold intact, rather than
      // leaving a promise pending forever.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause);
        throw new ChatError(`model request failed: ${detail}`);
      } finally {
        clearTimeout(timer);
      }

      const text = await response.text();
      if (!response.ok) {
        // Include the provider's own message: a 401 with "invalid api key" is
        // actionable, and a bare 401 is not.
        throw new ChatError(`model returned ${response.status}: ${text.slice(0, 500)}`);
      }

      let json: unknown;
      try {
        json = JSON.parse(text) as unknown;
      } catch {
        throw new ChatError(`model returned ${response.status} with a non-JSON body: ${text.slice(0, 200)}`);
      }

      const parsed = ChatResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new ChatError(`model response did not match the chat-completions shape: ${parsed.error.issues[0]?.message ?? "unknown"}`);
      }

      const choice = parsed.data.choices[0];
      if (choice === undefined) {
        throw new ChatError("model returned no choices");
      }
      const message = choice.message;
      const usage = parsed.data.usage;

      return {
        content: message.content ?? null,
        toolCalls: message.tool_calls ?? [],
        finishReason: choice.finish_reason ?? null,
        usage:
          usage === undefined
            ? null
            : {
                ...(usage.prompt_tokens === undefined ? {} : { promptTokens: usage.prompt_tokens }),
                ...(usage.completion_tokens === undefined ? {} : { completionTokens: usage.completion_tokens }),
              },
        requestBody: body,
      };
    },
  };
}
