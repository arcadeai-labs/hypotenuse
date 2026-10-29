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
 * Streaming and multi-step tool calls are not scripted yet.
 */

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
  /** The text the next completions answer with. */
  script(text: string): void;
  /** Change the key the server accepts. */
  acceptKey(key: string): void;
  /** Forget the recorded requests. */
  reset(): void;
  stop(): Promise<void>;
}

/** The models every endpoint lists. */
export const SCRIPTED_MODELS = [
  { id: "scripted-large", name: "Scripted Large" },
  { id: "scripted-small", name: "Scripted Small" },
];

/**
 * Start a scripted model server on a free loopback port.
 * @param options.apiKey - The one key it accepts.
 * @returns The running server.
 */
export function startModelServer(options: { apiKey: string }): ModelServer {
  const requests: RecordedRequest[] = [];
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

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
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
          const { model } = JSON.parse(body) as { model: string };
          return Response.json({
            id: "msg_scripted",
            type: "message",
            role: "assistant",
            model,
            content: [{ type: "text", text: scripted }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 10, output_tokens: 5 },
          });
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
          const { model } = JSON.parse(body) as { model: string };
          return Response.json({
            id: "chatcmpl-scripted",
            object: "chat.completion",
            created: now(),
            model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: scripted },
                finish_reason: "stop",
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              total_tokens: 15,
            },
          });
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
    script: (text) => {
      scripted = text;
    },
    acceptKey: (key) => {
      acceptedKey = key;
    },
    reset: () => {
      requests.length = 0;
    },
    stop: async () => {
      await server.stop(true);
    },
  };
}
