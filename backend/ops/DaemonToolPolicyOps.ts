/**
 * Which agent tools each role may call, as the server enforces it.
 *
 * The tools themselves — names, schemas, descriptions, and the `daemon:*`
 * action behind each — are one table in `protocol/src/tools.ts`, shared with
 * the daemon's `hypotenuse mcp` server so the two sides cannot drift. This
 * module reads that table as action names: {@link WORKER_TOOLS} ⊂
 * {@link MANAGER_TOOLS}, both closed, and `DaemonSessionScopeMiddleware`
 * refuses an action outside the session's role. The daemon filters the tool
 * list by role too, but only this check is a boundary.
 */
import {
  HYPOTENUSE_TOOLS,
  type RunnerRole,
  type ToolDefinition,
  toolsForRole,
} from "@hypotenuse/protocol";

/** Every tool action, in table order. */
export const TOOL_ACTION_NAMES: readonly string[] = HYPOTENUSE_TOOLS.map(
  (t) => t.action,
);

/** The actions a worker session's tools may call. */
export const WORKER_TOOLS: ReadonlySet<string> = new Set(
  toolsForRole("worker").map((t) => t.action),
);

/** The actions a manager session's tools may call: every worker tool, and more. */
export const MANAGER_TOOLS: ReadonlySet<string> = new Set(
  toolsForRole("manager").map((t) => t.action),
);

/**
 * The tool an action serves.
 * @param actionName - A `daemon:linear-*` or `daemon:dispatch` action.
 * @returns The tool definition.
 * @throws {Error} For an action that is not a tool's.
 */
export function toolForAction(actionName: string): ToolDefinition {
  const tool = HYPOTENUSE_TOOLS.find((t) => t.action === actionName);
  if (!tool) throw new Error(`${actionName} is not an agent tool's action`);
  return tool as unknown as ToolDefinition;
}

/**
 * Whether a session in a role may call a tool action.
 * @param role - The session's role.
 * @param actionName - The action.
 * @returns True when the role's allowlist holds it.
 */
export function roleMayCall(role: RunnerRole, actionName: string): boolean {
  return (role === "manager" ? MANAGER_TOOLS : WORKER_TOOLS).has(actionName);
}
