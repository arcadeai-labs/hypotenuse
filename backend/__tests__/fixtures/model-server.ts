/**
 * The scripted model server: an in-process HTTP server that speaks the wire
 * formats of the providers Hypotenuse connects to, so the **real** AI SDK
 * provider packages talk to it unchanged and no code of ours is mocked.
 *
 * Each provider lives under its own path prefix, which is the base URL a test
 * gives a model connection:
 *
 * | Prefix | Speaks | Routes |
 * |---|---|---|
 * | `/anthropic/v1` | Anthropic Messages | `GET /models`, `POST /messages` |
 * | `/openai/v1` | OpenAI | `GET /models`, `POST /responses`, `POST /chat/completions` |
 * | `/compatible/v1` | an OpenAI-compatible server | `GET /models`, `POST /chat/completions` |
 * | `/gateway/v4/ai` | Vercel AI Gateway | `GET /config`; and `GET /v1/credits` at the root, as the gateway serves it |
 * | `/leaky/v1` | a broken server that echoes the request's credentials into a 500 | anything |
 *
 * Every request is recorded with its headers and body, so a suite can assert
 * that a key arrived exactly where its provider expects it — and nowhere else.
 * A request carrying any other key is answered 401, as the provider would.
 *
 * **Scenarios.** {@link ModelServer.play} queues responses for the completion
 * routes (Anthropic `POST /messages`, and `POST /chat/completions` for OpenAI
 * and OpenAI-compatible), consumed one per request. Each may carry text,
 * reasoning, tool calls, and usage, reported in the provider's own fields and
 * streamed as the provider streams them (SSE) when the request asks to stream;
 * `expect` assertions on the request; or a failure: an HTTP status, a response
 * that hangs until released or abandoned, or a stream cut after some events.
 * A scenario may also be a file under `model-scenarios/`. With nothing queued,
 * a completion answers the text {@link ModelServer.script} set.
 */

import { readFileSync } from "node:fs";

/** One scripted tool call. */
export interface ScriptedToolCall {
  name: string;
  input: Record<string, unknown>;
  /** The call id; a unique one is generated if omitted. */
  id?: string;
}

/** One scripted answer to a completion request. */
export interface ScriptedResponse {
  text?: string;
  reasoning?: string;
  toolCalls?: ScriptedToolCall[];
  /** Usage as the provider reports it. Defaults: 10 in, 5 out. */
  usage?: {
    input?: number;
    output?: number;
    cachedInput?: number;
    reasoning?: number;
  };
  /** Assertions on the request this answers. A failed one answers 400. */
  expect?: {
    /** The last message (serialized) contains this. */
    lastMessageIncludes?: string;
    /** Some message (serialized) contains this. */
    anyMessageIncludes?: string;
    /** No message (serialized) contains this. */
    noMessageIncludes?: string;
    /** Exactly these tool names are offered (any order). */
    toolsOffered?: string[];
    /** The system prompt contains this. */
    systemIncludes?: string;
  };
  /** Answer with this HTTP status and an error body in the provider's shape. */
  fail?: { status: number; message?: string };
  /** Send nothing until {@link ModelServer.release} or the client gives up. */
  hang?: boolean;
  /** Stream this many events, then cut the connection. */
  dropAfter?: number;
}

/** A completion request, parsed. */
export interface CompletionRequest {
  provider: "anthropic" | "openai";
  path: string;
  body: {
    model: string;
    stream?: boolean;
    system?: unknown;
    messages: unknown[];
    tools?: { name?: string; function?: { name: string } }[];
  };
}

/** One request the server received. */
export interface RecordedRequest {
  method: string;
  /** The path, without the query string. */
  path: string;
  headers: Record<string, string>;
  /** The raw body text ("" for none). */
  body: string;
}

/** A running scripted model server. */
export interface ModelServer {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  /** The base URL to give a connection of a provider kind. */
  baseUrl(
    provider:
      | "anthropic"
      | "openai"
      | "openai-compatible"
      | "gateway"
      | "leaky",
  ): string;
  /** Every request so far, oldest first. */
  requests: RecordedRequest[];
  /** The text completions answer with when no scenario is queued. */
  script(text: string): void;
  /** Queue scripted responses, or a scenario file's, after any already queued. */
  play(scenario: ScriptedResponse[] | string): void;
  /** How many queued responses are left. */
  pending(): number;
  /** Let every hung response finish (with its scripted content). */
  release(): void;
  /** Every completion request, oldest first, with its parsed body. */
  completions: CompletionRequest[];
  /** How many responses the client abandoned before they finished. */
  disconnects(): number;
  /** Every `expect` that did not hold, as sentences. */
  expectationFailures: string[];
  /** Change the key the server accepts. */
  acceptKey(key: string): void;
  /** Forget the recorded requests, the queue, and the counters. */
  reset(): void;
  stop(): Promise<void>;
}

/** The models every endpoint lists. */
export const SCRIPTED_MODELS = [
  { id: "scripted-large", name: "Scripted Large" },
  { id: "scripted-small", name: "Scripted Small" },
];

/** Where scenario files live. */
const SCENARIO_DIR = new URL("./model-scenarios/", import.meta.url);

/**
 * Read a scenario file.
 * @param name - The file's name, without `.json`.
 * @returns Its responses.
 */
function loadScenario(name: string): ScriptedResponse[] {
  const text = readFileSync(new URL(`${name}.json`, SCENARIO_DIR), "utf8");
  const parsed = JSON.parse(text) as { responses: ScriptedResponse[] };
  return parsed.responses;
}

/** A unique id for a scripted tool call. */
let callCounter = 0;

/**
 * The SSE events of an Anthropic Messages stream for a response.
 * @param r - The scripted response.
 * @param model - The model asked for.
 * @param calls - The tool calls, with ids.
 * @returns Each event's `event:` name and JSON data.
 */
function anthropicEvents(
  r: ScriptedResponse,
  model: string,
  calls: Required<ScriptedToolCall>[],
): [string, unknown][] {
  const usage = r.usage ?? {};
  const events: [string, unknown][] = [
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: `msg_${++callCounter}`,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: usage.input ?? 10,
            output_tokens: 1,
            cache_read_input_tokens: usage.cachedInput ?? 0,
            cache_creation_input_tokens: 0,
          },
        },
      },
    ],
  ];
  let index = 0;
  if (r.reasoning) {
    events.push(
      [
        "content_block_start",
        {
          type: "content_block_start",
          index,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index,
          delta: { type: "thinking_delta", thinking: r.reasoning },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index,
          delta: { type: "signature_delta", signature: "scripted-signature" },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index }],
    );
    index++;
  }
  if (r.text) {
    events.push([
      "content_block_start",
      {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      },
    ]);
    // Two deltas, so a stream that is cut can be cut mid-text.
    const half = Math.ceil(r.text.length / 2);
    for (const piece of [r.text.slice(0, half), r.text.slice(half)]) {
      if (!piece) continue;
      events.push([
        "content_block_delta",
        {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: piece },
        },
      ]);
    }
    events.push(["content_block_stop", { type: "content_block_stop", index }]);
    index++;
  }
  for (const call of calls) {
    events.push(
      [
        "content_block_start",
        {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: call.id,
            name: call.name,
            input: {},
          },
        },
      ],
      [
        "content_block_delta",
        {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(call.input),
          },
        },
      ],
      ["content_block_stop", { type: "content_block_stop", index }],
    );
    index++;
  }
  events.push(
    [
      "message_delta",
      {
        type: "message_delta",
        delta: {
          stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
          stop_sequence: null,
        },
        usage: { output_tokens: usage.output ?? 5 },
      },
    ],
    ["message_stop", { type: "message_stop" }],
  );
  return events;
}

/**
 * A non-streaming Anthropic Messages answer.
 * @param r - The scripted response.
 * @param model - The model asked for.
 * @param calls - The tool calls, with ids.
 * @returns The JSON body.
 */
function anthropicJson(
  r: ScriptedResponse,
  model: string,
  calls: Required<ScriptedToolCall>[],
) {
  const usage = r.usage ?? {};
  return {
    id: `msg_${++callCounter}`,
    type: "message",
    role: "assistant",
    model,
    content: [
      ...(r.reasoning
        ? [
            {
              type: "thinking",
              thinking: r.reasoning,
              signature: "scripted-signature",
            },
          ]
        : []),
      ...(r.text ? [{ type: "text", text: r.text }] : []),
      ...calls.map((c) => ({
        type: "tool_use",
        id: c.id,
        name: c.name,
        input: c.input,
      })),
    ],
    stop_reason: calls.length > 0 ? "tool_use" : "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: usage.input ?? 10,
      output_tokens: usage.output ?? 5,
      cache_read_input_tokens: usage.cachedInput ?? 0,
      cache_creation_input_tokens: 0,
    },
  };
}

/**
 * The SSE `data:` payloads of an OpenAI Chat Completions stream.
 * @param r - The scripted response.
 * @param model - The model asked for.
 * @param calls - The tool calls, with ids.
 * @returns Each chunk, then the `[DONE]` sentinel.
 */
function chatChunks(
  r: ScriptedResponse,
  model: string,
  calls: Required<ScriptedToolCall>[],
): unknown[] {
  const id = `chatcmpl-${++callCounter}`;
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: unknown, finish: string | null = null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  });
  const usage = r.usage ?? {};
  const out: unknown[] = [chunk({ role: "assistant", content: "" })];
  if (r.reasoning) out.push(chunk({ reasoning_content: r.reasoning }));
  if (r.text) {
    const half = Math.ceil(r.text.length / 2);
    for (const piece of [r.text.slice(0, half), r.text.slice(half)]) {
      if (piece) out.push(chunk({ content: piece }));
    }
  }
  calls.forEach((c, index) => {
    out.push(
      chunk({
        tool_calls: [
          {
            index,
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.input) },
          },
        ],
      }),
    );
  });
  out.push(chunk({}, calls.length > 0 ? "tool_calls" : "stop"));
  out.push({
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
    usage: {
      prompt_tokens: usage.input ?? 10,
      completion_tokens: usage.output ?? 5,
      total_tokens: (usage.input ?? 10) + (usage.output ?? 5),
      prompt_tokens_details: { cached_tokens: usage.cachedInput ?? 0 },
      completion_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
    },
  });
  out.push("[DONE]");
  return out;
}

/**
 * A non-streaming OpenAI Chat Completions answer.
 * @param r - The scripted response.
 * @param model - The model asked for.
 * @param calls - The tool calls, with ids.
 * @returns The JSON body.
 */
function chatJson(
  r: ScriptedResponse,
  model: string,
  calls: Required<ScriptedToolCall>[],
) {
  const usage = r.usage ?? {};
  return {
    id: `chatcmpl-${++callCounter}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: r.text ?? null,
          ...(r.reasoning ? { reasoning_content: r.reasoning } : {}),
          ...(calls.length > 0
            ? {
                tool_calls: calls.map((c) => ({
                  id: c.id,
                  type: "function",
                  function: {
                    name: c.name,
                    arguments: JSON.stringify(c.input),
                  },
                })),
              }
            : {}),
        },
        finish_reason: calls.length > 0 ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: usage.input ?? 10,
      completion_tokens: usage.output ?? 5,
      total_tokens: (usage.input ?? 10) + (usage.output ?? 5),
      prompt_tokens_details: { cached_tokens: usage.cachedInput ?? 0 },
      completion_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
    },
  };
}

/**
 * Check a response's `expect` against the request it answers.
 * @param r - The scripted response.
 * @param req - The parsed request.
 * @returns A sentence per failed assertion.
 */
function checkExpect(r: ScriptedResponse, req: CompletionRequest): string[] {
  const failures: string[] = [];
  const e = r.expect;
  if (!e) return failures;
  const messages = req.body.messages ?? [];
  const last = JSON.stringify(messages[messages.length - 1] ?? null);
  if (e.lastMessageIncludes && !last.includes(e.lastMessageIncludes)) {
    failures.push(
      `expected the last message to include ${JSON.stringify(e.lastMessageIncludes)}, got ${last.slice(0, 500)}`,
    );
  }
  const all = JSON.stringify(messages);
  if (e.anyMessageIncludes && !all.includes(e.anyMessageIncludes)) {
    failures.push(
      `expected some message to include ${JSON.stringify(e.anyMessageIncludes)}`,
    );
  }
  if (e.noMessageIncludes && all.includes(e.noMessageIncludes)) {
    failures.push(
      `expected no message to include ${JSON.stringify(e.noMessageIncludes)}`,
    );
  }
  if (e.toolsOffered) {
    const offered = (req.body.tools ?? [])
      .map((t) => t.name ?? t.function?.name ?? "")
      .sort();
    const wanted = [...e.toolsOffered].sort();
    if (JSON.stringify(offered) !== JSON.stringify(wanted)) {
      failures.push(
        `expected tools ${JSON.stringify(wanted)}, got ${JSON.stringify(offered)}`,
      );
    }
  }
  if (e.systemIncludes) {
    const system =
      req.provider === "anthropic"
        ? JSON.stringify(req.body.system ?? "")
        : JSON.stringify(
            messages.filter((m) => (m as { role?: string }).role === "system"),
          );
    if (!system.includes(e.systemIncludes)) {
      failures.push(
        `expected the system prompt to include ${JSON.stringify(e.systemIncludes)}`,
      );
    }
  }
  return failures;
}

/**
 * Start a scripted model server on a free loopback port.
 * @param options.apiKey - The one key it accepts.
 * @returns The running server.
 */
export function startModelServer(options: { apiKey: string }): ModelServer {
  const requests: RecordedRequest[] = [];
  const completions: CompletionRequest[] = [];
  const queue: ScriptedResponse[] = [];
  const expectationFailures: string[] = [];
  const hung = new Set<() => void>();
  let disconnects = 0;
  let acceptedKey = options.apiKey;
  let scripted = "Hello from the scripted model.";

  const unauthorized = (shape: "anthropic" | "openai") =>
    Response.json(
      shape === "anthropic"
        ? {
            type: "error",
            error: {
              type: "authentication_error",
              message: "invalid x-api-key",
            },
          }
        : {
            error: {
              message: "Incorrect API key provided.",
              type: "invalid_request_error",
              code: "invalid_api_key",
            },
          },
      { status: 401 },
    );
  const bearerOk = (req: Request) =>
    req.headers.get("authorization") === `Bearer ${acceptedKey}`;
  const now = () => Math.floor(Date.now() / 1000);

  /**
   * Answer a completion request from the queue (or the default text).
   * @param provider - Whose wire format.
   * @param path - The request path.
   * @param raw - The raw body.
   * @param signal - The request's signal, which aborts on disconnect.
   * @returns The response.
   */
  const complete = async (
    provider: "anthropic" | "openai",
    path: string,
    raw: string,
    signal: AbortSignal,
  ): Promise<Response> => {
    const body = JSON.parse(raw) as CompletionRequest["body"];
    const parsed: CompletionRequest = { provider, path, body };
    completions.push(parsed);
    const r: ScriptedResponse = queue.shift() ?? { text: scripted };

    const failures = checkExpect(r, parsed);
    if (failures.length > 0) {
      expectationFailures.push(...failures);
      return Response.json(
        provider === "anthropic"
          ? {
              type: "error",
              error: {
                type: "invalid_request_error",
                message: `scripted expectation failed: ${failures.join("; ")}`,
              },
            }
          : {
              error: {
                message: `scripted expectation failed: ${failures.join("; ")}`,
                type: "invalid_request_error",
              },
            },
        { status: 400 },
      );
    }
    if (r.fail) {
      const message = r.fail.message ?? `scripted failure ${r.fail.status}`;
      return Response.json(
        provider === "anthropic"
          ? {
              type: "error",
              error: {
                type: r.fail.status === 529 ? "overloaded_error" : "api_error",
                message,
              },
            }
          : { error: { message, type: "server_error" } },
        { status: r.fail.status },
      );
    }

    const calls = (r.toolCalls ?? []).map((c) => ({
      ...c,
      id:
        c.id ??
        `${provider === "anthropic" ? "toolu" : "call"}_${++callCounter}_${Math.random().toString(36).slice(2, 8)}`,
    }));
    const model = body.model;

    if (r.hang) {
      // Wait for release; a client that gives up is a disconnect.
      const released = await new Promise<boolean>((resolve) => {
        const done = () => {
          hung.delete(done);
          resolve(true);
        };
        hung.add(done);
        signal.addEventListener(
          "abort",
          () => {
            if (!hung.has(done)) return;
            hung.delete(done);
            disconnects++;
            resolve(false);
          },
          { once: true },
        );
      });
      if (!released) return new Response(null, { status: 499 });
    }

    if (!body.stream) {
      return Response.json(
        provider === "anthropic"
          ? anthropicJson(r, model, calls)
          : chatJson(r, model, calls),
      );
    }

    const lines =
      provider === "anthropic"
        ? anthropicEvents(r, model, calls).map(
            ([event, data]) =>
              `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`,
          )
        : chatChunks(r, model, calls).map(
            (data) =>
              `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`,
          );
    const encoder = new TextEncoder();
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (r.dropAfter !== undefined && sent >= r.dropAfter) {
          // Bun prints this on the console: the connection really is cut,
          // which a clean close of a short stream would not prove.
          controller.error(new Error("scripted drop"));
          return;
        }
        const line = lines[sent++];
        if (line === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(line));
        await Bun.sleep(1);
      },
      cancel() {
        disconnects++;
      },
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
      },
    });
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = await req.text();
      requests.push({
        method: req.method,
        path: url.pathname,
        headers: Object.fromEntries(req.headers),
        body,
      });
      const route = `${req.method} ${url.pathname}`;

      // Anthropic.
      if (url.pathname.startsWith("/anthropic/")) {
        if (req.headers.get("x-api-key") !== acceptedKey) {
          return unauthorized("anthropic");
        }
        if (route === "GET /anthropic/v1/models") {
          return Response.json({
            data: SCRIPTED_MODELS.map((m) => ({
              type: "model",
              id: m.id,
              display_name: m.name,
              created_at: "2026-01-01T00:00:00Z",
            })),
            has_more: false,
            first_id: SCRIPTED_MODELS[0].id,
            last_id: SCRIPTED_MODELS[SCRIPTED_MODELS.length - 1].id,
          });
        }
        if (route === "POST /anthropic/v1/messages") {
          return complete("anthropic", url.pathname, body, req.signal);
        }
      }

      // OpenAI, and an OpenAI-compatible server.
      if (
        url.pathname.startsWith("/openai/") ||
        url.pathname.startsWith("/compatible/")
      ) {
        if (!bearerOk(req)) return unauthorized("openai");
        const path = url.pathname.replace(/^\/(openai|compatible)/, "");
        if (req.method === "GET" && path === "/v1/models") {
          return Response.json({
            object: "list",
            data: SCRIPTED_MODELS.map((m) => ({
              id: m.id,
              object: "model",
              created: 1767225600,
              owned_by: "scripted",
            })),
          });
        }
        if (req.method === "POST" && path === "/v1/chat/completions") {
          return complete("openai", url.pathname, body, req.signal);
        }
        if (req.method === "POST" && path === "/v1/responses") {
          const { model } = JSON.parse(body) as { model: string };
          return Response.json({
            id: "resp_scripted",
            object: "response",
            created_at: now(),
            status: "completed",
            model,
            output: [
              {
                type: "message",
                id: "msg_scripted",
                status: "completed",
                role: "assistant",
                content: [
                  { type: "output_text", text: scripted, annotations: [] },
                ],
              },
            ],
            incomplete_details: null,
            usage: {
              input_tokens: 10,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens: 5,
              output_tokens_details: { reasoning_tokens: 0 },
              total_tokens: 15,
            },
          });
        }
      }

      // A server that quotes the request, credentials and all, in its error.
      if (url.pathname.startsWith("/leaky/")) {
        return Response.json(
          {
            error: `upstream failed for ${req.headers.get("authorization")}`,
          },
          { status: 500 },
        );
      }

      // Vercel AI Gateway: the catalog under the base URL, credits at the root.
      if (route === "GET /gateway/v4/ai/config") {
        return Response.json({
          models: SCRIPTED_MODELS.map((m) => ({
            id: `scripted/${m.id}`,
            name: m.name,
            specification: {
              specificationVersion: "v4",
              provider: "scripted",
              modelId: m.id,
            },
            modelType: "language",
          })),
        });
      }
      if (route === "GET /v1/credits") {
        if (!bearerOk(req)) {
          return Response.json(
            {
              error: {
                message: "Invalid API key",
                type: "authentication_error",
              },
            },
            { status: 401 },
          );
        }
        return Response.json({ balance: "10.00", total_used: "0.00" });
      }

      return Response.json(
        { error: { message: `No scripted route for ${route}` } },
        { status: 404 },
      );
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    baseUrl: (provider) =>
      ({
        anthropic: `${url}/anthropic/v1`,
        openai: `${url}/openai/v1`,
        "openai-compatible": `${url}/compatible/v1`,
        gateway: `${url}/gateway/v4/ai`,
        leaky: `${url}/leaky/v1`,
      })[provider],
    requests,
    completions,
    expectationFailures,
    script: (text) => {
      scripted = text;
    },
    play: (scenario) => {
      queue.push(
        ...(typeof scenario === "string" ? loadScenario(scenario) : scenario),
      );
    },
    pending: () => queue.length,
    release: () => {
      for (const done of [...hung]) done();
    },
    disconnects: () => disconnects,
    acceptKey: (key) => {
      acceptedKey = key;
    },
    reset: () => {
      requests.length = 0;
      completions.length = 0;
      queue.length = 0;
      expectationFailures.length = 0;
      disconnects = 0;
    },
    stop: async () => {
      for (const done of [...hung]) done();
      await server.stop(true);
    },
  };
}
