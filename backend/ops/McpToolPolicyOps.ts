/**
 * Which actions are published as MCP tools for a signed-in person's client.
 *
 * Keryx serves **one** `/mcp`, authenticated by its own OAuth 2.1 server, and
 * the people who reach it are exactly the people who reach the HTTP API. So the
 * rule is "human MCP ≈ HTTP": almost every action with a `web.route` is a tool,
 * and the API and a person's Claude are the same product surface.
 *
 * The exceptions are a closed list, declared here before most of their members
 * exist, so the change that adds one cannot forget it:
 *
 * - **login and sign-up** — a model does not create accounts or sessions;
 * - **unauthenticated introspection** — `status`, `health`, `swagger`,
 *   `actions:permissions` describe the server, not a person's work;
 * - **the CLI's sign-in hops** — `cli-auth:approve` and `cli-auth:activate` are
 *   a person approving a CLI on a dashboard page, and a model approving one
 *   would sign itself in; `cli-auth:device` and `cli-auth:exchange` are the
 *   CLI's half, and the exchange returns a token a model must never hold;
 * - **the sandbox's credential hop** — `sandbox:git-credential`;
 * - **the email-verification hop** — `email-verification:confirm` is a link a
 *   person follows from their inbox; a model holding the token could confirm
 *   an address nobody read;
 * - **the MCP server sign-in hops** — `mcp-server:oauth-start` and
 *   `mcp-server:oauth-callback` send a person's browser through a server's
 *   authorization page and back; a model cannot sign in, and the callback
 *   carries a code a model must never hold;
 * - **binary answers** — `bot:avatar` answers image bytes, which no tool
 *   result carries;
 * - **machine families, by prefix** — `webhooks:*` (signed platform ingress),
 *   `sandbox:*` (run-token actions), and `proxy:*` (the model and MCP gateway
 *   proxies). Asserting a prefix is safe only because no human action shares it;
 * - **structural** — no `web.route`, a clock (`task.frequency > 0`), or an
 *   action flagged as login or sign-up.
 *
 * {@link applyMcpToolPolicy} overwrites every action's `mcp.tool` from
 * {@link shouldPublishAsMcpTool} at boot, and `rbac.test.ts` asserts every
 * action's live flag equals that function.
 */

/**
 * The fields the publish policy reads and the `mcp.tool` flag it writes.
 *
 * Structural rather than `Action` so tests can call {@link shouldPublishAsMcpTool}
 * against the live registry without importing Keryx's action class type.
 */
export interface McpPublishableAction {
  name: string;
  mcp?: {
    tool?: boolean;
    isLoginAction?: boolean;
    isSignupAction?: boolean;
  };
  web?: { route?: string | RegExp } | null;
  task?: { frequency?: number } | null;
}

/**
 * Actions that have (or will have) an HTTP route but must never be MCP tools.
 * See the module comment for why each is here.
 */
export const NEVER_MCP_ACTION_NAMES: ReadonlySet<string> = new Set([
  "user:create",
  "session:create",
  "session:destroy",
  "status",
  "health",
  "swagger",
  "actions:permissions",
  "cli-auth:approve",
  "cli-auth:activate",
  "cli-auth:device",
  "cli-auth:exchange",
  "sandbox:git-credential",
  "email-verification:confirm",
  "mcp-server:oauth-start",
  "mcp-server:oauth-callback",
  "bot:avatar",
]);

/**
 * Action-name prefixes that are never MCP tools: signed machine ingress, the
 * run-token-only family, and the proxies.
 */
export const NEVER_MCP_PREFIXES: readonly string[] = [
  "webhooks:",
  "sandbox:",
  "proxy:",
];

/**
 * Whether this action should be registered as an MCP tool at boot.
 *
 * Publish if it has a `web.route`, unless it is a clock, a login or signup
 * action, a member of {@link NEVER_MCP_ACTION_NAMES}, or under one of
 * {@link NEVER_MCP_PREFIXES}.
 *
 * Class-level `mcp.tool` is the boot default and is overwritten by
 * {@link applyMcpToolPolicy}. `rbac.test.ts` asserts every action's live flag
 * equals this function.
 * @param action - A registered action.
 * @returns True if Keryx should register it as a tool.
 */
export function shouldPublishAsMcpTool(action: McpPublishableAction): boolean {
  if (!action.web?.route) return false;
  if (
    action.task != null &&
    action.task.frequency != null &&
    action.task.frequency > 0
  ) {
    return false;
  }
  if (NEVER_MCP_ACTION_NAMES.has(action.name)) return false;
  if (action.mcp?.isLoginAction || action.mcp?.isSignupAction) return false;
  if (NEVER_MCP_PREFIXES.some((prefix) => action.name.startsWith(prefix))) {
    return false;
  }
  return true;
}

/**
 * Set `mcp.tool` on every registered action from {@link shouldPublishAsMcpTool}.
 *
 * Called at initializer boot, before any MCP session is opened, so Keryx's
 * `registerTools` reads the live flags. Runs even when MCP is disabled:
 * `rbac.test.ts` reads the same flags.
 * @param actions - The live action registry (`api.actions.actions`).
 */
export function applyMcpToolPolicy(actions: McpPublishableAction[]): void {
  for (const action of actions) {
    if (!action.mcp) {
      action.mcp = { tool: false };
    }
    action.mcp.tool = shouldPublishAsMcpTool(action);
  }
}
