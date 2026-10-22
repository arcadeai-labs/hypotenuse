import {
  HYPOTENUSE_TOOLS,
  type HypotenuseToolName,
} from "@hypotenuse/protocol";
import { and, asc, eq } from "drizzle-orm";
import { api } from "keryx";
import { type AgentSession, agentSessions } from "../../schema/agent_sessions";
import { workItems } from "../../schema/work_items";
import type { Finear } from "../linear/sessions";
import {
  delegatedSession,
  itemsOf,
  type ScriptedDaemon,
} from "../routing/helpers";
import { daemonHeaders } from "../runners/helpers";

/**
 * What the dispatch and review suites share: a manager session a scripted
 * daemon holds, tool calls as that daemon, and reads of the dispatch tree.
 */

/** A live session and the turn its runner holds. */
export interface Held {
  sessionId: number;
  externalSessionId: string;
  issue: { id: string; identifier: string };
  workItemId: number;
}

/**
 * Start a session by delegation and have a daemon claim its first turn.
 * @param linear - The finear harness.
 * @param appUserId - The app user.
 * @param daemon - Who claims it.
 * @param title - The issue's title.
 * @param role - The role the session is given before the claim.
 * @returns The held session.
 */
export async function heldSession(
  linear: Finear,
  appUserId: string,
  daemon: ScriptedDaemon,
  title: string,
  role: "worker" | "manager" = "manager",
): Promise<Held> {
  const { issue, externalSessionId, session } = await delegatedSession(
    linear,
    appUserId,
    title,
  );
  const [first] = await itemsOf(session.id);
  await api.db.db
    .update(agentSessions)
    .set({ role })
    .where(eq(agentSessions.id, session.id));
  await api.db.db
    .update(workItems)
    .set({ role })
    .where(eq(workItems.id, first.id));
  const assignment = await daemon.claim([first.id]);
  if (!assignment) throw new Error(`${daemon.runner.name} could not claim`);
  return {
    sessionId: session.id,
    externalSessionId,
    issue,
    workItemId: assignment.workItemId,
  };
}

/** A tool call's answer. */
export interface Called {
  status: number;
  body: {
    result?: { text: string; data: Record<string, unknown> };
    error?: { message: string };
  };
}

/**
 * Call one tool's action as a runner.
 * @param url - The server.
 * @param daemon - The calling runner.
 * @param tool - The MCP tool name.
 * @param agentSessionId - The session the call names.
 * @param input - The tool input.
 * @returns The status and parsed body.
 */
export async function callTool(
  url: string,
  daemon: ScriptedDaemon,
  tool: HypotenuseToolName,
  agentSessionId: number,
  input: Record<string, unknown> = {},
): Promise<Called> {
  const def = HYPOTENUSE_TOOLS.find((t) => t.name === tool)!;
  const res = await fetch(`${url}/api${def.route}`, {
    method: "POST",
    headers: daemonHeaders(daemon.runner.token),
    body: JSON.stringify({ ...input, agentSessionId }),
  });
  return { status: res.status, body: (await res.json()) as Called["body"] };
}

/**
 * Create a sub-issue of the manager's issue through its own tool.
 * @param url - The server.
 * @param daemon - The manager's runner.
 * @param manager - The manager session.
 * @param title - The title.
 * @returns The sub-issue's identifier.
 */
export async function subIssue(
  url: string,
  daemon: ScriptedDaemon,
  manager: Held,
  title: string,
): Promise<string> {
  const made = await callTool(
    url,
    daemon,
    "linear_create_sub_issue",
    manager.sessionId,
    {
      parent: manager.issue.identifier,
      title,
      description: "## Acceptance criteria\n- [ ] it works",
    },
  );
  if (made.status !== 200) throw new Error(JSON.stringify(made.body));
  return (made.body.result!.data.issue as { identifier: string }).identifier;
}

/**
 * Every mirror row on an issue, oldest first.
 * @param identifier - The issue's identifier.
 * @returns The rows.
 */
export async function sessionsOnIssue(
  identifier: string,
): Promise<AgentSession[]> {
  return api.db.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.issueIdentifier, identifier))
    .orderBy(asc(agentSessions.id));
}

/**
 * A manager's dispatched children, oldest first.
 * @param managerSessionId - The manager session.
 * @returns The rows.
 */
export async function childrenOf(
  managerSessionId: number,
): Promise<AgentSession[]> {
  return api.db.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.parentAgentSessionId, managerSessionId))
    .orderBy(asc(agentSessions.id));
}

/**
 * A session's review items, oldest first.
 * @param agentSessionId - The manager session.
 * @returns The rows.
 */
export async function reviewsOf(agentSessionId: number) {
  return api.db.db
    .select()
    .from(workItems)
    .where(
      and(
        eq(workItems.agentSessionId, agentSessionId),
        eq(workItems.kind, "review"),
      ),
    )
    .orderBy(asc(workItems.id));
}
