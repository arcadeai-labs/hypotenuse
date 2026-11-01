import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  api,
  CONNECTION_TYPE,
  type Connection,
  config,
  ErrorType,
  Initializer,
  TypedError,
} from "keryx";
import { CLI_TOKEN_PREFIX } from "../ops/CliTokenOps";
import {
  isSandboxOnlyActionName,
  isSandboxToolName,
} from "../ops/McpToolPolicyOps";
import { bearerToken } from "../ops/RawRequestOps";
import { isJobTokenClientId, JOB_TOKEN_PREFIX } from "../ops/SandboxJobOps";

const namespace = "sandboxSplit";

/**
 * **Machine principals and human principals are disjoint.** One `/mcp` and
 * one `/api` serve both people and sandbox jobs, so the split is enforced
 * here, by principal, never by name prefix alone:
 *
 * - a `beforeAct` hook default-denies both ways, on every transport: a
 *   request carrying a job token may run only `SANDBOX_ONLY_ACTION_NAMES`,
 *   and a request from a person (a session, a CLI token, a person's OAuth
 *   token) may run none of them;
 * - each MCP session is given only its own surface: a job's session keeps the
 *   in-sandbox tools and a person's loses them (`remove`, not `disable`, so
 *   the other surface's handlers are freed);
 * - a job's MCP session may not open the Streamable HTTP GET stream: a coding
 *   CLI that pins its HTTP/1.1 connection behind it then hangs its tool calls.
 *
 * `declaresAPIProperty = false`: nothing is attached to `api`.
 */
export class SandboxSplit extends Initializer {
  constructor() {
    super(namespace);
    this.dependsOn = ["mcp", "mcpToolPolicy"];
    this.declaresAPIProperty = false;
  }

  /** Register the hook, and the MCP session hooks when MCP is on. */
  async start(): Promise<void> {
    api.hooks.actions.beforeAct(enforceSandboxSplit);
    if (!config.server.mcp.enabled) return;
    api.hooks.mcp.onConnect(async (sessionId) => {
      await applySessionSurface(sessionId);
    });
    api.hooks.mcp.onMessage(async (sessionId) => {
      if (sessionId) await applySessionSurface(sessionId);
    });
    refuseJobGetStream();
  }
}

/**
 * Who a request is, as far as the split cares.
 * @param params - Its params (the supervisor's token travels as `token`).
 * @param connection - Its connection.
 * @returns Whether it carries a job token, and whether it is a person.
 */
async function principalOf(
  params: Record<string, unknown>,
  connection: Connection,
): Promise<{ job: boolean; person: boolean }> {
  let job = false;
  let person = Boolean(
    (connection.session?.data as { userId?: number } | undefined)?.userId,
  );
  if (connection.type === CONNECTION_TYPE.MCP && connection.sessionId) {
    const verified = await api.oauth.verifyAccessToken(connection.sessionId);
    if (verified && isJobTokenClientId(verified.clientId)) job = true;
    else if (verified?.userId) person = true;
  }
  const bearer = connection.rawRequest
    ? bearerToken(connection.rawRequest)
    : null;
  if (bearer?.startsWith(JOB_TOKEN_PREFIX)) job = true;
  if (bearer?.startsWith(CLI_TOKEN_PREFIX)) person = true;
  if (
    typeof params.token === "string" &&
    params.token.startsWith(JOB_TOKEN_PREFIX)
  ) {
    job = true;
  }
  return { job, person };
}

/**
 * The `beforeAct` hook: default-deny across the human / machine line.
 * @param actionName - The action about to run.
 * @param params - Its validated params.
 * @param connection - The caller's connection.
 * @throws {TypedError} `CONNECTION_CHANNEL_AUTHORIZATION` (403) across the line.
 */
export async function enforceSandboxSplit(
  actionName: string,
  params: Record<string, unknown>,
  connection: Connection,
): Promise<void> {
  const sandboxAction = isSandboxOnlyActionName(actionName);
  const who = await principalOf(params, connection);
  if (who.job && !sandboxAction) {
    throw new TypedError({
      message:
        "This action is not available inside a sandbox. Sandbox tools start with sandbox-.",
      type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
    });
  }
  if (sandboxAction && who.person && !who.job) {
    throw new TypedError({
      message:
        "This action is only available to a coding agent inside a Hypotenuse sandbox. People manage jobs with the sandbox-job actions.",
      type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
    });
  }
}

/**
 * Give one MCP session only its own surface.
 * @param sessionId - The MCP session id.
 */
async function applySessionSurface(sessionId: string): Promise<void> {
  const entry = api.mcp.transports.get(sessionId);
  if (!entry) return;
  const server = api.mcp.mcpServers.find(
    (s) => s.server.transport === entry.transport,
  );
  if (!server) return;
  const job = isJobTokenClientId(entry.clientId);
  const tools = (
    server as unknown as {
      _registeredTools: Record<string, { remove: () => void }>;
    }
  )._registeredTools;
  for (const [name, handle] of Object.entries(tools)) {
    if (job !== isSandboxToolName(name)) handle.remove();
  }
  void (server satisfies McpServer);
}

/**
 * Refuse the Streamable HTTP GET stream to a job's session: tool results
 * already travel on the POST that called the tool.
 */
function refuseJobGetStream(): void {
  const inner = api.mcp.handleRequest;
  if (!inner) return;
  api.mcp.handleRequest = async (req, ip) => {
    if (req.method.toUpperCase() === "GET") {
      const token = bearerToken(req);
      if (token) {
        const verified = await api.oauth.verifyAccessToken(token);
        if (verified && isJobTokenClientId(verified.clientId)) {
          return new Response(null, {
            status: 405,
            headers: { Allow: "POST, DELETE" },
          });
        }
      }
    }
    return inner(req, ip);
  };
}
