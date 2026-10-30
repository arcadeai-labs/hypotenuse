import {
  type Action,
  type ActionParams,
  api,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  allowingPattern,
  matchPattern,
  patternProblem,
} from "../../ops/ApprovalPatternOps";
import { idInput } from "../../ops/InputOps";
import { loadMcpServer } from "../../ops/McpServerOps";

/**
 * `mcp-server:match-tools` — which of a server's tools a set of allowlist
 * patterns would let run without approval, so a person sees what a pattern
 * matches before saving it. Requires membership; writes nothing.
 */
export class McpServerMatchTools implements Action {
  name = "mcp-server:match-tools";
  description =
    "Test allowlist patterns (server/tool, server/*, */tool, a bare tool name, or /regex/) against an MCP server's tool catalog: which tools each pattern matches, and which tools none does. Writes nothing. Requires membership in the project.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/mcp-server/:mcpServerId/match",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    mcpServerId: idInput("The server"),
    patterns: z
      .string()
      .max(4000)
      .describe("The patterns, separated by newlines or commas"),
  });

  /**
   * @param params - The inputs.
   * @returns Each pattern's matches, and the tools left gated.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` for a bad pattern.
   */
  async run(params: ActionParams<McpServerMatchTools>) {
    const row = await loadMcpServer(
      api.db.db,
      params.projectId,
      params.mcpServerId,
    );
    const patterns = params.patterns
      .split(/[\n,]/)
      .map((p) => p.trim())
      .filter(Boolean);
    for (const p of patterns) {
      const problem = patternProblem(p);
      if (problem) {
        throw new TypedError({
          message: problem,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "patterns",
        });
      }
    }
    const names = row.toolsCache.map((t) => t.name);
    return {
      matches: patterns.map((pattern) => ({
        pattern,
        tools: names
          .filter((n) => matchPattern(pattern, row.name, n))
          .map((n) => `${row.name}/${n}`),
      })),
      gated: names
        .filter((n) => !allowingPattern(patterns, row.name, n))
        .map((n) => `${row.name}/${n}`),
    };
  }
}
