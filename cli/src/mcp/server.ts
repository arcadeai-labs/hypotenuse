/**
 * `hypotenuse mcp`: the stdio MCP server a coding agent gets for its turn.
 *
 * It holds a session id and a per-turn nonce, nothing else. On start it asks
 * the daemon who it serves (`mcp.hello`) and registers the role's tools; each
 * tool call is `mcp.call` on the daemon's control socket, which makes it as a
 * `daemon:*` action with the runner token the agent never sees. Logs go to
 * stderr, which the agent host captures into the session log.
 *
 * A refused hello — an unknown or expired nonce, or no daemon — still starts
 * the server, with **zero tools** and `instructions` saying why: some agents
 * fail a whole session when an MCP server exits during start-up, and a
 * session without Linear tools can still do its coding.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { type RunnerRole, toolByName } from "../../../protocol/src/index";
import pkg from "../../package.json";
import type { CallAnswer, HelloAnswer } from "../daemon/mcp-broker";
import { checkCall, describeTool } from "./tools";

/** How long one tool call may take end to end. */
export const MCP_CALL_TIMEOUT_MS = 90_000;

/** Calls a control-socket method on the daemon. */
export type DaemonCall = (
  method: string,
  params: Record<string, unknown>,
  timeoutMs?: number,
) => Promise<unknown>;

/** What the server needs. */
export interface McpServerOptions {
  agentSessionId: number;
  nonce: string;
  /** The daemon's control socket. */
  call: DaemonCall;
  /** A line for stderr. */
  log?: (line: string) => void;
}

/**
 * The `instructions` for a server with tools.
 * @param issue - The session's issue identifier.
 * @returns The text many agents show their model.
 */
export function toolInstructions(issue: string | null): string {
  return `Tools for the Linear issue ${issue ?? "this session is about"} you are working on. Your thoughts, tool calls, and final message already appear in Linear automatically — do not post them as comments. Use linear_ask_user when you need a person's decision, then end your turn. Use linear_report_pr as soon as you open a pull request.`;
}

/**
 * The `instructions` for a server that could not reach its turn.
 * @param reason - Why.
 * @returns The text.
 */
export function noToolsInstructions(reason: string): string {
  return `Hypotenuse's Linear tools are not available in this session (${reason}). Do your work without them; your messages still reach Linear.`;
}

/**
 * Build the server: hello, then the role's tools.
 * @param options - The session, nonce, and daemon.
 * @returns The server, not yet connected to a transport.
 */
export async function createMcpServer(
  options: McpServerOptions,
): Promise<Server> {
  const log = options.log ?? (() => {});
  let hello: HelloAnswer | null = null;
  let refusal = "";
  try {
    hello = (await options.call("mcp.hello", {
      agentSessionId: options.agentSessionId,
      nonce: options.nonce,
    })) as HelloAnswer;
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
    log(`hypotenuse mcp: no tools: ${refusal}`);
  }
  const role: RunnerRole | null = hello?.role ?? null;
  const names = new Set(hello?.tools ?? []);

  const server = new Server(
    { name: "hypotenuse", version: pkg.version },
    {
      capabilities: { tools: {} },
      instructions: hello
        ? toolInstructions(hello.issueIdentifier)
        : noToolsInstructions(refusal),
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [...names].flatMap((name) => {
      const tool = toolByName(name);
      return tool ? [describeTool(tool)] : [];
    }),
  }));

  server.setRequestHandler(
    CallToolRequestSchema,
    async (request): Promise<CallToolResult> => {
      const name = request.params.name;
      const failed = (text: string): CallToolResult => ({
        content: [{ type: "text", text }],
        isError: true,
      });
      if (!role || !names.has(name)) {
        return failed(`There is no tool ${name} in this session.`);
      }
      const checked = checkCall(role, name, request.params.arguments);
      if (!checked.ok) return failed(checked.message);
      let answer: CallAnswer;
      try {
        answer = (await options.call(
          "mcp.call",
          {
            agentSessionId: options.agentSessionId,
            nonce: options.nonce,
            tool: name,
            input: checked.input,
          },
          MCP_CALL_TIMEOUT_MS,
        )) as CallAnswer;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log(`hypotenuse mcp: ${name} failed: ${message}`);
        return failed(`Hypotenuse could not run ${name}: ${message}`);
      }
      return {
        content: [{ type: "text", text: answer.text }],
        ...(answer.data ? { structuredContent: answer.data } : {}),
        ...(answer.isError ? { isError: true } : {}),
      };
    },
  );
  return server;
}

/**
 * Serve over stdio until stdin closes.
 * @param options - The session, nonce, and daemon.
 * @returns When the agent has gone.
 */
export async function serveStdio(options: McpServerOptions): Promise<void> {
  const server = await createMcpServer(options);
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
    process.stdin.once("end", () => resolve());
    process.stdin.once("close", () => resolve());
  });
  await server.connect(transport);
  await closed;
  await server.close().catch(() => {});
}
