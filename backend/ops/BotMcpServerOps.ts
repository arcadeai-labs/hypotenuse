import { ErrorType, TypedError } from "keryx";
import { z } from "zod";
import type { BotMcpServer } from "../schema/bot_mcp_servers";
import type { McpServer } from "../schema/mcp_servers";
import { MAX_PATTERN_CHARS, patternProblem } from "./ApprovalPatternOps";

/**
 * Which MCP servers a bot may use: inputs and the serializer.
 */

/** The Zod input for a bot's allowlist patterns on one server. */
export const allowedToolsInput = z
  .array(z.string().trim().min(1).max(MAX_PATTERN_CHARS))
  .max(200)
  .describe(
    "Patterns naming the calls this bot may make without a person's approval: server/tool, server/*, */tool, a bare tool name, or /regex/ (matched against server/tool). Empty (the default) means every call waits for approval",
  );

/** The Zod input for the read-only shortcut. */
export const autoAllowReadOnlyInput = z
  .boolean()
  .describe(
    "Let calls to tools the server annotates readOnlyHint run without approval. Off by default: an annotation is the server's claim, not a guarantee",
  );

/**
 * Refuse malformed patterns.
 * @param patterns - The patterns.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` naming the first.
 */
export function assertPatterns(patterns: string[]): void {
  for (const p of patterns) {
    const problem = patternProblem(p);
    if (problem) {
      throw new TypedError({
        message: problem,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "allowedTools",
      });
    }
  }
}

/**
 * Shape a binding for any answer.
 * @param binding - The binding.
 * @param server - Its server.
 * @returns The serialized binding, with the server's name and status.
 */
export function serializeBotMcpServer(
  binding: BotMcpServer,
  server: McpServer,
) {
  return {
    id: binding.id,
    botId: binding.botId,
    mcpServerId: binding.mcpServerId,
    server: {
      id: server.id,
      name: server.name,
      status: server.status,
      enabled: server.enabled,
      toolCount: server.toolsCache.length,
    },
    allowedTools: binding.allowedTools,
    autoAllowReadOnly: binding.autoAllowReadOnly,
    createdAt: binding.createdAt.getTime(),
    updatedAt: binding.updatedAt.getTime(),
  };
}
