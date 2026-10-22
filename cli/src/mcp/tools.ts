/**
 * The Hypotenuse MCP tools as the agent sees them: the shared table in
 * `protocol/src/tools.ts`, filtered by role and turned into MCP tool
 * descriptors. The same zod schema validates a call here, in the daemon's
 * broker, and on the server, so the three cannot disagree.
 */
import { z } from "zod";
import {
  type RunnerRole,
  type ToolDefinition,
  toolByName,
  toolsForRole,
} from "../../../protocol/src/index";

/** One tool as `tools/list` answers it. */
export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: { type: "object"; [key: string]: unknown };
}

/** The tools whose results the daemon caches per turn. */
export const CACHED_TOOLS: ReadonlySet<string> = new Set([
  "linear_get_issue",
  "linear_list_comments",
  "linear_get_project",
  "linear_list_labels",
]);

/**
 * The MCP descriptor of one tool.
 * @param tool - The tool.
 * @returns Its name, description, and JSON Schema.
 */
export function describeTool(tool: ToolDefinition): McpToolDescriptor {
  const { $schema: _schema, ...schema } = z.toJSONSchema(tool.input) as Record<
    string,
    unknown
  >;
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: { ...schema, type: "object" },
  };
}

/**
 * The names of the tools a role gets.
 * @param role - The session's role.
 * @returns The names, in table order.
 */
export function toolNamesFor(role: RunnerRole): string[] {
  return toolsForRole(role).map((t) => t.name);
}

/** A checked tool call. */
export type CheckedCall =
  | { ok: true; tool: ToolDefinition; input: Record<string, unknown> }
  | { ok: false; message: string };

/**
 * Check a call against a role's tools and the tool's schema.
 * @param role - The session's role.
 * @param name - The tool called.
 * @param args - Its arguments.
 * @returns The tool and its parsed input, or why not.
 */
export function checkCall(
  role: RunnerRole,
  name: string,
  args: unknown,
): CheckedCall {
  const tool = toolByName(name);
  if (!tool || !(tool.roles as readonly string[]).includes(role)) {
    return {
      ok: false,
      message: `There is no tool ${name} for a ${role} session.`,
    };
  }
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      message: `Invalid input for ${name}: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "(input)"}: ${i.message}`)
        .join("; ")}`,
    };
  }
  return { ok: true, tool, input: parsed.data as Record<string, unknown> };
}
