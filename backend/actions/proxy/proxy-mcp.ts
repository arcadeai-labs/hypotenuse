import { type Action, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  actingBot,
  actingJob,
  type JobConnection,
  JobTokenMiddleware,
  JobTokenRateLimitMiddleware,
} from "../../middleware/jobToken";
import { allowance } from "../../ops/ApprovalPatternOps";
import { botServers } from "../../ops/McpCatalogOps";
import { callServerTool, McpUnauthorized } from "../../ops/McpClientOps";
import { credentialValues } from "../../ops/McpServerOps";
import {
  rawRequestOf,
  readCappedBody,
  requestPath,
} from "../../ops/RawRequestOps";
import { touchJobActivity } from "../../ops/SandboxJobOps";
import { scrubCredentials } from "../../tools/mcp-exec";

/** The largest JSON-RPC request accepted. */
const MAX_REQUEST_BYTES = 4 * 1024 * 1024;

/** The most JSON-RPC messages one request may carry. */
const MAX_BATCH = 5;

/** The protocol version answered when the client names none we know. */
const PROTOCOL_VERSION = "2025-06-18";

/** One JSON-RPC message. */
interface RpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

/**
 * A JSON-RPC answer.
 * @param id - The request's id.
 * @param result - The result.
 * @returns The envelope.
 */
function ok(id: RpcMessage["id"], result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

/**
 * A JSON-RPC error.
 * @param id - The request's id.
 * @param code - The error code.
 * @param message - What went wrong.
 * @returns The envelope.
 */
function rpcError(id: RpcMessage["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

/**
 * A tool result that is an error the agent reads.
 * @param id - The request's id.
 * @param text - What to tell it.
 * @returns The envelope.
 */
function toolRefusal(id: RpcMessage["id"], text: string) {
  return ok(id, { content: [{ type: "text", text }], isError: true });
}

/**
 * `proxy:mcp` — the gateway to one of the project's shared MCP servers, for a
 * sandbox job. It is a small stateless MCP server of its own (Streamable
 * HTTP, JSON answers): `initialize`, `tools/list`, and `tools/call`, served
 * from the server's cached catalog and called through the same client pool
 * as `mcp_exec` — so the server's credentials are attached here, server-side,
 * and never reach the sandbox.
 *
 * The bot's allowlist applies: `tools/list` shows only the tools the bot may
 * call without asking, and a call to any other is refused with a sentence
 * the agent can act on. A sandbox cannot park for an approval — ask with
 * `sandbox-ask` instead. A server the bot is not bound to is a 404.
 * Not audited: machine traffic.
 */
export class ProxyMcp implements Action {
  name = "proxy:mcp";
  description =
    "Serve a sandbox job one of its bot's shared MCP servers, attaching the server's credentials. Reachable only from inside a sandbox, with a live job token.";
  mcp = { tool: false };
  middleware = [JobTokenMiddleware, JobTokenRateLimitMiddleware];
  web = {
    route: /^\/proxy\/mcp\/\d+$/,
    method: HTTP_METHOD.POST,
    rawBody: true,
  };
  timeout = 0;
  inputs = z.object({});

  /**
   * Answer one JSON-RPC message (or a batch).
   * @param _params - Unused; everything is read from the raw request.
   * @param connection - The job's connection.
   * @returns The JSON-RPC answer, or 202 for notifications.
   */
  async run(_params: unknown, connection: JobConnection) {
    const request = rawRequestOf(connection);
    const job = actingJob(connection);
    const bot = actingBot(connection);
    const body = await readCappedBody(request, MAX_REQUEST_BYTES);
    let parsed: RpcMessage | RpcMessage[];
    try {
      parsed = JSON.parse(new TextDecoder().decode(body.bytes));
    } catch {
      return Response.json(rpcError(null, -32700, "Parse error"), {
        status: 400,
      });
    }
    const messages = Array.isArray(parsed) ? parsed : [parsed];
    // A batch is a few messages, never a way to run many tools per request
    // past the rate limit.
    if (messages.length > MAX_BATCH) {
      return Response.json(
        rpcError(
          null,
          -32600,
          `A batch may hold at most ${MAX_BATCH} messages.`,
        ),
        { status: 400 },
      );
    }
    const serverId = Number(requestPath(request).split("/").pop());
    const bound = (await botServers(api.db.db, bot.id)).find(
      (b) => b.server.id === serverId,
    );
    if (!bound) {
      return Response.json(
        rpcError(null, -32001, "This MCP server is not available to this job."),
        { status: 404 },
      );
    }
    const answers: unknown[] = [];
    for (const message of messages) {
      if (message.id === undefined || message.id === null) continue;
      answers.push(await this.answer(message, bound, bot, job.id));
    }
    if (answers.length === 0) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(parsed) ? answers : answers[0]);
  }

  /**
   * Answer one request.
   * @param message - The request.
   * @param bound - The server and the bot's binding to it.
   * @param bot - The bot.
   * @param jobId - The job.
   * @returns The JSON-RPC answer.
   */
  private async answer(
    message: RpcMessage,
    bound: Awaited<ReturnType<typeof botServers>>[number],
    bot: Parameters<typeof callServerTool>[1],
    jobId: number,
  ) {
    const { server, binding } = bound;
    const allowed = (name: string) => {
      const tool = server.toolsCache.find((t) => t.name === name);
      return tool && allowance(binding, server.name, tool).allowed
        ? tool
        : null;
    };
    switch (message.method) {
      case "initialize":
        return ok(message.id, {
          protocolVersion:
            typeof message.params?.protocolVersion === "string"
              ? message.params.protocolVersion
              : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: server.name, version: "1.0.0" },
        });
      case "ping":
        return ok(message.id, {});
      case "tools/list":
        return ok(message.id, {
          tools: server.toolsCache
            .filter((t) => allowed(t.name))
            .map((t) => ({
              name: t.name,
              ...(t.title ? { title: t.title } : {}),
              description: t.description ?? "",
              inputSchema: t.inputSchema ?? { type: "object" },
              ...(t.annotations ? { annotations: t.annotations } : {}),
            })),
        });
      case "tools/call": {
        const name = String(message.params?.name ?? "");
        if (!allowed(name)) {
          return toolRefusal(
            message.id,
            `${server.name}/${name} is not a tool this job may call without a person's approval, and a sandbox cannot wait for one. Ask with sandbox-ask whether to go ahead another way, or say in your result that it is needed.`,
          );
        }
        await touchJobActivity(api.db.db, jobId);
        try {
          const result = await callServerTool(
            server,
            bot,
            name,
            (message.params?.arguments as Record<string, unknown>) ?? {},
          );
          const secrets = credentialValues(server, bot);
          return ok(message.id, {
            content: [
              { type: "text", text: scrubCredentials(result.text, secrets) },
            ],
            ...(result.structuredContent !== undefined
              ? {
                  structuredContent: JSON.parse(
                    scrubCredentials(
                      JSON.stringify(result.structuredContent),
                      secrets,
                    ),
                  ),
                }
              : {}),
            isError: result.isError,
          });
        } catch (e) {
          return toolRefusal(
            message.id,
            e instanceof McpUnauthorized
              ? `${server.name}'s credentials need attention from a project admin.`
              : `${server.name}/${name} failed: ${scrubCredentials(
                  (e instanceof Error ? e.message : String(e)).slice(0, 500),
                  credentialValues(server, bot),
                )}`,
          );
        }
      }
      default:
        return rpcError(
          message.id,
          -32601,
          `Method not found: ${message.method}`,
        );
    }
  }
}
