import { eq } from "drizzle-orm";
import { api } from "keryx";
import { approvals } from "../../schema/approvals";
import { conversationEntries } from "../../schema/conversation_entries";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  drainQueue,
} from "../agent/harness";
import {
  type FixtureAuth,
  type McpFixture,
  startMcpFixture,
} from "../fixtures/mcp-server";
import { call, type TestUser } from "../setup";

/**
 * The MCP suites' stage: the agent stage (seeded universe, scripted model,
 * Toadsworth) plus a fixture MCP server. Servers are connected and given to
 * bots over HTTP, as a person would.
 */
export interface McpStage extends AgentStage {
  fixture: McpFixture;
}

/**
 * Build the stage.
 * @param auth - How the fixture authenticates.
 * @returns The stage.
 */
export async function buildMcpStage(auth?: FixtureAuth): Promise<McpStage> {
  const stage = await buildAgentStage("anthropic");
  const fixture = startMcpFixture({ auth });
  return { ...stage, fixture };
}

/**
 * Connect a server over HTTP as Peach (an admin).
 * @param stage - The stage.
 * @param body - The `mcp-server:create` inputs (url defaults to the fixture's).
 * @returns The server's id and serialized form.
 */
export async function addServer(
  stage: McpStage,
  body: Record<string, unknown> = {},
) {
  const res = await call<{
    mcpServer: Record<string, unknown> & { id: number };
  }>(
    stage.u.url,
    stage.u.peach,
    "PUT",
    `/project/${stage.u.projectId}/mcp-server`,
    { name: "mail", url: stage.fixture.url, authMode: "none", ...body },
  );
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body.mcpServer;
}

/**
 * Give the stage's bot a server.
 * @param stage - The stage.
 * @param mcpServerId - The server.
 * @param settings - Allowlist and read-only setting.
 * @param user - Who does it (Peach by default).
 * @returns The response.
 */
export async function bindServer(
  stage: McpStage,
  mcpServerId: number,
  settings: { allowedTools?: string[]; autoAllowReadOnly?: boolean } = {},
  user: TestUser = stage.u.peach,
) {
  return call<{ botMcpServer: Record<string, unknown> }>(
    stage.u.url,
    user,
    "PUT",
    `/project/${stage.u.projectId}/bot/${stage.botId}/mcp-server`,
    { mcpServerId, ...settings },
  );
}

/**
 * Run the queued capability regenerations (the `default` queue's
 * `bot:capabilities` jobs).
 */
export async function runCapabilities(): Promise<void> {
  await drainQueue("default", { only: "bot:capabilities" });
}

/**
 * Every approval of a conversation, oldest first.
 * @param conversationId - The conversation.
 * @returns The rows.
 */
export async function approvalsOf(conversationId: number) {
  return api.db.db
    .select()
    .from(approvals)
    .where(eq(approvals.conversationId, conversationId))
    .orderBy(approvals.id);
}

/**
 * The outputs of every result of a tool in a conversation, oldest first.
 * @param conversationId - The conversation.
 * @param toolName - The tool.
 * @returns The outputs.
 */
export async function resultsOf(
  conversationId: number,
  toolName: string,
): Promise<Record<string, unknown>[]> {
  const rows = await api.db.db
    .select()
    .from(conversationEntries)
    .where(eq(conversationEntries.conversationId, conversationId))
    .orderBy(conversationEntries.seq);
  return rows
    .filter((r) => r.kind === "tool_result" && r.toolName === toolName)
    .map(
      (r) => (r.content as { output: Record<string, unknown> }).output ?? {},
    );
}

/** Steps that read a tool's info and call it. */
export function infoThenExec(
  name: string,
  args: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
) {
  return [
    { toolCalls: [{ name: "mcp_info", input: { name } }] },
    { toolCalls: [{ name: "mcp_exec", input: { name, args, ...extra } }] },
  ];
}

/** A step that ends the turn. */
export const replyStep = (text = "Done.") => ({
  toolCalls: [{ name: "reply_and_wait", input: { text } }],
});

export { clearLoopQueues };
