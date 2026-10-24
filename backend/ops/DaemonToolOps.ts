import { normalizeRemote, type PLAN_STEP_STATUSES } from "@hypotenuse/protocol";
import { and, eq, sql } from "drizzle-orm";
import { api, config } from "keryx";
import { agentActivities } from "../schema/agent_activities";
import type {
  AgentSession,
  AgentSessionExternalUrl,
} from "../schema/agent_sessions";
import { HELD_WORK_STATUSES, workItems } from "../schema/work_items";
import {
  enqueueActivity,
  enqueueIssueAttachment,
  enqueueSessionUpdate,
  scheduleDelivery,
} from "./ActivityOutboxOps";
import {
  isLinearNotFound,
  notFound,
  type ToolScope,
  targetRefused,
  toolInputRefused,
} from "./DaemonScopeOps";
import { runDispatch } from "./DispatchOps";
import type { LinearCatalog } from "./LinearCatalogOps";
import { bodyForLinear, capDescription, personLink } from "./LinearMarkdownOps";
import {
  CreateComment,
  CreateDocument,
  CreateIssue,
  CreateIssueRelation,
  GetDocument,
  GetIssueDetail,
  GetProjectDetail,
  type LinearDocument,
  type LinearIssueCreateInput,
  type LinearIssueScope,
  type LinearIssueUpdateInput,
  ListIssueComments,
  ListProjectDocuments,
  ListProjectStatuses,
  ListWorkflowStates,
  SearchIssues,
  UpdateDocument,
  UpdateIssue,
  UpdateProject,
} from "./linear/operations";
import type { TxHandle } from "./ProjectOps";
import { getManagerSettings } from "./ProjectSettingsOps";
import { lockItemWithSession } from "./WorkItemOps";

/**
 * What each agent tool does, once `DaemonSessionScopeMiddleware` has
 * established whose session the call is for. One function per tool; the
 * `daemon:*` action for each (`actions/daemon/linear/`) only binds its tool to
 * its function through `DaemonToolAction`.
 *
 * Every tool answers Markdown for the model (`text`, capped by the action)
 * and the same facts as data (`data`, an MCP tool's `structuredContent`).
 * Reads and inline writes call Linear through {@link ToolScope.linear}, which
 * spends a token from the integration's bucket first. The plan, a question,
 * and a pull request link are the session's own activity, so they go through
 * the activity outbox, in order with everything else the session says.
 */

/** What a tool answers. */
export interface ToolOutput {
  text: string;
  data: Record<string, unknown>;
}

/** The label a session's first pull request link carries. */
export const PULL_REQUEST_LABEL = "Pull Request";

/** What `linear_ask_user` tells the agent. */
export const ASKED_TEXT =
  "Asked. Linear now shows your question; the person's answer will arrive as your next prompt. End your turn now without a further message.";

/** Linear's priority names, by number. */
const PRIORITY_NAMES = ["No priority", "Urgent", "High", "Medium", "Low"];

/** How an inverse relation reads from the other side. */
const INVERSE_RELATION: Record<string, string> = {
  blocks: "blocked by",
  duplicate: "duplicated by",
  related: "related to",
  similar: "similar to",
};

/**
 * The URL of the icon a manager-authored issue shows beside a person's name.
 * @returns The deployment's own mark.
 */
export function attributionIconUrl(): string {
  return `${config.cliAuth.appUrl.replace(/\/+$/, "")}/favicon.svg`;
}

/**
 * The `createAsUser` attribution for an issue a manager session creates: the
 * person whose request led to it, when a person started the session.
 * @param session - The session.
 * @returns The fields to send, or none.
 */
export function attribution(
  session: AgentSession,
): Pick<LinearIssueCreateInput, "createAsUser" | "displayIconUrl"> {
  if (!session.creatorName) return {};
  return {
    createAsUser: `${session.creatorName} via Hypotenuse`,
    displayIconUrl: attributionIconUrl(),
  };
}

// ── Resolving names to ids ──────────────────────────────────────────────

type CatalogTeam = LinearCatalog["teams"][number];

/**
 * A team by key or id, from the catalog (re-read once on a miss).
 * @param ts - The call.
 * @param ref - `ENG` or an id.
 * @returns The team.
 * @throws {TypedError} 404.
 */
async function resolveTeam(ts: ToolScope, ref: string): Promise<CatalogTeam> {
  const find = (c: LinearCatalog) =>
    c.teams.find(
      (t) => t.id === ref || t.key.toLowerCase() === ref.toLowerCase(),
    );
  const team = find(await ts.catalog()) ?? find(await ts.catalog(true));
  if (!team) throw notFound(`No team ${ref} that Hypotenuse can read.`);
  return team;
}

/**
 * The team a tool works in: the one named, else the session issue's.
 * @param ts - The call.
 * @param ref - What the agent passed.
 * @param fallback - The issue whose team is the default.
 * @returns The team, checked `readable`.
 */
async function teamFor(
  ts: ToolScope,
  ref: string | undefined,
  fallback?: LinearIssueScope,
): Promise<CatalogTeam> {
  const team = await resolveTeam(
    ts,
    ref ?? (fallback ?? (await ts.sessionIssue())).team.id,
  );
  ts.assertReadable(team, `Team ${team.key}`);
  return team;
}

type CatalogProject = LinearCatalog["projects"][number];

/**
 * A project by id or exact name (case-insensitive), from the catalog.
 * @param ts - The call.
 * @param ref - The id or name.
 * @returns The project.
 * @throws {TypedError} 404.
 */
async function resolveProject(
  ts: ToolScope,
  ref: string,
): Promise<CatalogProject> {
  const find = (c: LinearCatalog) =>
    c.projects.find(
      (p) => p.id === ref || p.name.toLowerCase() === ref.toLowerCase(),
    );
  const project = find(await ts.catalog()) ?? find(await ts.catalog(true));
  if (!project) throw notFound(`No project ${ref} that Hypotenuse can read.`);
  return project;
}

/**
 * The project of the session's issue.
 * @param ts - The call.
 * @returns Its id, or null when the issue is in none.
 */
async function sessionProjectId(ts: ToolScope): Promise<string | null> {
  return (await ts.sessionIssue()).project?.id ?? null;
}

/**
 * Label names or ids to ids, for a team (its own labels and the workspace's).
 * @param ts - The call.
 * @param refs - What the agent passed.
 * @param teamId - The issue's team.
 * @returns The ids.
 * @throws {TypedError} 406 naming the unknown ones.
 */
async function resolveLabels(
  ts: ToolScope,
  refs: readonly string[],
  teamId: string,
): Promise<string[]> {
  const lookup = (c: LinearCatalog) => {
    const usable = c.labels.filter(
      (l) => l.teamId === null || l.teamId === teamId,
    );
    return refs.map(
      (ref) =>
        usable.find(
          (l) => l.id === ref || l.name.toLowerCase() === ref.toLowerCase(),
        )?.id ?? null,
    );
  };
  let ids = lookup(await ts.catalog());
  if (ids.includes(null)) ids = lookup(await ts.catalog(true));
  const unknown = refs.filter((_, i) => ids[i] === null);
  if (unknown.length > 0) {
    throw toolInputRefused(
      `Unknown label${unknown.length > 1 ? "s" : ""} for this team: ${unknown.join(", ")}. See linear_list_labels.`,
    );
  }
  return ids as string[];
}

/**
 * A project the agent named, checked to be in a readable team.
 * @param ts - The call.
 * @param ref - The id or name.
 * @returns The project.
 */
async function readableProject(
  ts: ToolScope,
  ref: string,
): Promise<CatalogProject> {
  const project = await resolveProject(ts, ref);
  const catalog = await ts.catalog();
  const readable = project.teamIds.some((id) => {
    const team = catalog.teams.find((t) => t.id === id);
    return team ? ts.teamReadable(team) : false;
  });
  if (!readable) {
    throw targetRefused(
      `Project ${project.name} is not in a team this workspace granted Hypotenuse.`,
    );
  }
  return project;
}

/**
 * Turn work a held turn does on its own session: lock the session and the
 * item (in that order) and check the turn is still this runner's and not
 * stopping, as the middleware found it.
 * @param ts - The call.
 * @param work - What to do in the transaction.
 * @returns The work's answer.
 * @throws {TypedError} 403 when the turn ended in between.
 */
async function inHeldTurn<T>(
  ts: ToolScope,
  work: (tx: TxHandle, session: AgentSession) => Promise<T>,
): Promise<T> {
  const answer = await api.db.db.transaction(async (tx) => {
    const locked = await lockItemWithSession(tx, ts.scope.item.id);
    if (
      !locked ||
      locked.item.runnerId !== ts.scope.item.runnerId ||
      !(HELD_WORK_STATUSES as readonly string[]).includes(locked.item.status) ||
      locked.item.cancelRequestedAt !== null
    ) {
      return { ended: true as const };
    }
    return { ended: false as const, value: await work(tx, locked.session) };
  });
  if (answer.ended) {
    throw targetRefused("This turn has ended; nothing was written.");
  }
  await scheduleDelivery([ts.session.id]);
  return answer.value;
}

/**
 * A line naming an issue, as a link.
 * @param issue - The issue.
 * @returns `[ENG-1](url) Title`.
 */
function issueLine(issue: {
  identifier: string;
  title: string;
  url: string;
}): string {
  return `[${issue.identifier}](${issue.url}) ${issue.title}`;
}

// ── Reads ────────────────────────────────────────────────────────────────

/**
 * `linear_get_issue`.
 * @param ts - The call.
 * @param input - The tool input.
 * @returns The issue.
 */
export async function getIssue(
  ts: ToolScope,
  input: { issue?: string },
): Promise<ToolOutput> {
  const target = await ts.target(input.issue);
  ts.assertReadable(target.team, target.identifier);
  const { issue } = await ts.linear(GetIssueDetail, { id: target.id }, "read");
  const description = issue.description
    ? capDescription(issue.description, issue.url)
    : null;
  const lines = [
    `# ${issue.identifier}: ${issue.title}`,
    issue.url,
    "",
    `- State: ${issue.state.name} (${issue.state.type})`,
    `- Priority: ${PRIORITY_NAMES[issue.priority] ?? issue.priority}`,
    `- Team: ${issue.team.key} (${issue.team.name})`,
    `- Project: ${issue.project ? `[${issue.project.name}](${issue.project.url})` : "none"}`,
    `- Labels: ${issue.labels.nodes.map((l) => l.name).join(", ") || "none"}`,
    `- Assignee: ${personLink(issue.assignee)}`,
    `- Delegate: ${personLink(issue.delegate)}`,
    `- Creator: ${personLink(issue.creator)}`,
    ...(issue.estimate !== null ? [`- Estimate: ${issue.estimate}`] : []),
    ...(issue.parent ? [`- Parent: ${issueLine(issue.parent)}`] : []),
    "",
    "## Description",
    "",
    description ?? "(none)",
  ];
  if (issue.children.nodes.length > 0) {
    lines.push("", "## Sub-issues", "");
    for (const child of issue.children.nodes)
      lines.push(`- ${issueLine(child)} — ${child.state.name}`);
  }
  const relations = [
    ...issue.relations.nodes.map(
      (r) => `- ${r.type} ${issueLine(r.relatedIssue)}`,
    ),
    ...issue.inverseRelations.nodes.map(
      (r) => `- ${INVERSE_RELATION[r.type] ?? r.type} ${issueLine(r.issue)}`,
    ),
  ];
  if (relations.length > 0) lines.push("", "## Relations", "", ...relations);
  return {
    text: lines.join("\n"),
    data: { issue: { ...issue, description } },
  };
}

/**
 * `linear_list_comments`.
 * @param ts - The call.
 * @param input - The tool input.
 * @returns One page of comments, threaded.
 */
export async function listComments(
  ts: ToolScope,
  input: { issue?: string; first?: number; after?: string },
): Promise<ToolOutput> {
  const target = await ts.target(input.issue);
  ts.assertReadable(target.team, target.identifier);
  const { issue } = await ts.linear(
    ListIssueComments,
    { id: target.id, first: input.first ?? 25, after: input.after ?? null },
    "read",
  );
  const nodes = [...issue.comments.nodes].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  const ids = new Set(nodes.map((c) => c.id));
  const roots = nodes.filter((c) => !c.parent || !ids.has(c.parent.id));
  const render = (c: (typeof nodes)[number], depth: number): string[] => {
    const pad = "  ".repeat(depth);
    const who = c.user ? `[${c.user.name}](${c.user.url})` : "someone";
    const body = c.body
      .split("\n")
      .map((line) => `${pad}  ${line}`)
      .join("\n");
    return [
      `${pad}- ${who} · ${c.createdAt} · id \`${c.id}\``,
      body,
      ...nodes
        .filter((r) => r.parent?.id === c.id)
        .flatMap((r) => render(r, depth + 1)),
    ];
  };
  const lines = [
    `Comments on ${issue.identifier} (${nodes.length}${issue.comments.pageInfo.hasNextPage ? ", more after these" : ""}):`,
    "",
    ...(nodes.length === 0 ? ["(none)"] : roots.flatMap((c) => render(c, 0))),
  ];
  if (issue.comments.pageInfo.hasNextPage && issue.comments.pageInfo.endCursor)
    lines.push(
      "",
      `More: call again with after: "${issue.comments.pageInfo.endCursor}"`,
    );
  return {
    text: lines.join("\n"),
    data: {
      issue: issue.identifier,
      comments: nodes,
      pageInfo: issue.comments.pageInfo,
    },
  };
}

/**
 * `linear_search_issues`.
 * @param ts - The call.
 * @param input - The tool input.
 * @returns At most 25 issues, in readable teams.
 */
export async function searchIssues(
  ts: ToolScope,
  input: {
    query?: string;
    team?: string;
    stateType?: string;
    label?: string;
    project?: string;
    first?: number;
  },
): Promise<ToolOutput> {
  const filters: Record<string, unknown>[] = [];
  if (input.query) {
    filters.push({
      or: [
        { title: { containsIgnoreCase: input.query } },
        { description: { containsIgnoreCase: input.query } },
      ],
    });
  }
  let teamId: string | null = null;
  if (input.team) {
    const team = await teamFor(ts, input.team);
    teamId = team.id;
    filters.push({ team: { id: { eq: team.id } } });
  }
  if (input.stateType)
    filters.push({ state: { type: { eq: input.stateType } } });
  if (input.label) {
    const catalog = await ts.catalog();
    const ids = catalog.labels
      .filter(
        (l) =>
          l.name.toLowerCase() === input.label?.toLowerCase() &&
          (teamId === null || l.teamId === null || l.teamId === teamId),
      )
      .map((l) => l.id);
    if (ids.length === 0)
      throw toolInputRefused(`No label named ${input.label}.`);
    filters.push({ labels: { some: { id: { in: ids } } } });
  }
  if (input.project) {
    const project = await readableProject(ts, input.project);
    filters.push({ project: { id: { eq: project.id } } });
  }
  if (filters.length === 0) {
    throw toolInputRefused(
      "Give a query, or at least one of team, stateType, label, project.",
    );
  }
  const { issues } = await ts.linear(
    SearchIssues,
    { filter: { and: filters }, first: input.first ?? 25 },
    "read",
  );
  const catalog = await ts.catalog();
  const readable = issues.nodes.filter((i) => {
    const team = catalog.teams.find((t) => t.key === i.team.key);
    return team ? ts.teamReadable(team) : false;
  });
  return {
    text:
      readable.length === 0
        ? "No issues match."
        : [
            `${readable.length} issue${readable.length === 1 ? "" : "s"}:`,
            "",
            ...readable.map((i) => `- ${issueLine(i)} — ${i.state.name}`),
          ].join("\n"),
    data: { issues: readable },
  };
}

/**
 * `linear_get_project`.
 * @param ts - The call.
 * @param input - The tool input.
 * @returns The project, its issue counts, and its documents.
 */
export async function getProject(
  ts: ToolScope,
  input: { project?: string },
): Promise<ToolOutput> {
  const id = input.project
    ? (await readableProject(ts, input.project)).id
    : await sessionProjectId(ts);
  if (!id) {
    throw notFound(
      `${ts.session.issueIdentifier ?? "This session's issue"} is in no project; name one.`,
    );
  }
  if (!input.project) await readableProject(ts, id);
  const { project } = await ts.linear(GetProjectDetail, { id }, "read");
  let documents: LinearDocument[] | null = null;
  try {
    documents = (await ts.linear(ListProjectDocuments, { id }, "read")).project
      .documents.nodes;
  } catch (e) {
    api.logger.warn("listing a project's documents failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  const counts: Record<string, number> = {};
  for (const issue of project.issues.nodes)
    counts[issue.state.type] = (counts[issue.state.type] ?? 0) + 1;
  const lines = [
    `# ${project.name}`,
    project.url,
    "",
    `- Status: ${project.status.name} (${project.status.type})`,
    `- Lead: ${personLink(project.lead)}`,
    `- Summary: ${project.description || "(none)"}`,
    `- Issues: ${
      Object.entries(counts)
        .map(([type, n]) => `${n} ${type}`)
        .join(", ") || "none"
    }`,
    "",
    "## Content",
    "",
    project.content ? capDescription(project.content, project.url) : "(none)",
    "",
    "## Documents",
    "",
    ...(documents === null
      ? ["(could not be listed)"]
      : documents.length === 0
        ? ["(none)"]
        : documents.map((d) => `- [${d.title}](${d.url}) · id \`${d.id}\``)),
  ];
  return {
    text: lines.join("\n"),
    data: {
      project: {
        id: project.id,
        name: project.name,
        url: project.url,
        summary: project.description,
        content: project.content,
        status: project.status,
        lead: project.lead,
        issueCounts: counts,
      },
      documents,
    },
  };
}

/**
 * `linear_list_labels`.
 * @param ts - The call.
 * @param input - The tool input.
 * @returns The team's labels and the workspace's.
 */
export async function listLabels(
  ts: ToolScope,
  input: { team?: string },
): Promise<ToolOutput> {
  const team = await teamFor(ts, input.team);
  const labels = (await ts.catalog()).labels.filter(
    (l) => l.teamId === null || l.teamId === team.id,
  );
  return {
    text:
      labels.length === 0
        ? `No labels for ${team.key}.`
        : [
            `Labels for ${team.key}:`,
            "",
            ...labels.map(
              (l) =>
                `- ${l.name}${l.teamId === null ? " (workspace)" : ""} · id \`${l.id}\``,
            ),
          ].join("\n"),
    data: { team: team.key, labels },
  };
}

// ── Writes to issues ─────────────────────────────────────────────────────

/**
 * `linear_comment`.
 * @param ts - The call.
 * @param input - The tool input.
 * @returns Where the comment is.
 */
export async function comment(
  ts: ToolScope,
  input: { body: string; issue?: string; parentId?: string },
): Promise<ToolOutput> {
  const body = bodyForLinear(input.body, "The comment");
  const target = await ts.target(input.issue);
  await ts.assertMayChange(target);
  const { commentCreate } = await ts.linear(
    CreateComment,
    {
      input: {
        issueId: target.id,
        body,
        ...(input.parentId ? { parentId: input.parentId } : {}),
      },
    },
    "write",
  );
  await ts.recordWrite(target.identifier, commentCreate.comment.id);
  return {
    text: `Commented on ${target.identifier}: ${commentCreate.comment.url}`,
    data: { issue: target.identifier, comment: commentCreate.comment },
  };
}

/**
 * `linear_set_issue_state`.
 * @param ts - The call.
 * @param input - The tool input.
 * @returns The state it moved to.
 */
export async function setIssueState(
  ts: ToolScope,
  input: { state: string; issue?: string },
): Promise<ToolOutput> {
  const target = await ts.target(input.issue);
  await ts.assertMayChange(target);
  let states =
    (await ts.catalog()).teams.find((t) => t.id === target.team.id)?.states ??
    null;
  if (!states) {
    states = [
      ...(
        await ts.linear(ListWorkflowStates, { teamId: target.team.id }, "read")
      ).team.states.nodes,
    ].sort((a, b) => a.position - b.position);
  }
  const wanted = input.state.trim().toLowerCase();
  const state =
    states.find((s) => s.name.toLowerCase() === wanted) ??
    states.find((s) => s.type.toLowerCase() === wanted);
  if (!state) {
    throw toolInputRefused(
      `${target.team.key} has no state "${input.state}". Its states: ${states.map((s) => `${s.name} (${s.type})`).join(", ")}.`,
    );
  }
  if (state.type === "completed" || state.type === "canceled") {
    const verb = state.type === "completed" ? "complete" : "cancel";
    if (ts.role === "worker") {
      throw toolInputRefused(
        `A worker cannot ${verb} an issue: a person decides that. Move it to a review state if there is one, and say what you did in your response.`,
      );
    }
    const { canCompleteIssues } = await getManagerSettings(
      api.db.db,
      ts.session.projectId,
    );
    if (!canCompleteIssues) {
      throw toolInputRefused(
        `This project does not let a manager ${verb} issues: a person decides that. Move ${target.identifier} to a started state such as "In Review" if the team has one, and say in your response that it is ready for them.`,
      );
    }
  }
  await ts.linear(
    UpdateIssue,
    { id: target.id, input: { stateId: state.id } },
    "write",
  );
  await ts.recordWrite(target.identifier, target.id);
  return {
    text: `Moved ${target.identifier} to ${state.name}.`,
    data: { issue: target.identifier, state },
  };
}

/** The fields an issue create or update shares. */
interface IssueFields {
  title?: string;
  description?: string;
  labels?: string[];
  priority?: number;
  project?: string;
}

/**
 * Resolve the shared issue fields to Linear's input.
 * @param ts - The call.
 * @param input - The tool input.
 * @param teamId - The issue's team.
 * @returns The fields, by Linear's names.
 */
async function issueFields(
  ts: ToolScope,
  input: IssueFields,
  teamId: string,
): Promise<LinearIssueUpdateInput> {
  return {
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined
      ? { description: bodyForLinear(input.description, "The description") }
      : {}),
    ...(input.labels !== undefined
      ? { labelIds: await resolveLabels(ts, input.labels, teamId) }
      : {}),
    ...(input.priority !== undefined ? { priority: input.priority } : {}),
    ...(input.project !== undefined
      ? { projectId: (await readableProject(ts, input.project)).id }
      : {}),
  };
}

/**
 * Create an issue — the shared half of `linear_create_issue` and
 * `linear_create_sub_issue`. Never sets an assignee.
 * @param ts - The call.
 * @param input - The fields.
 * @param parentRef - The parent issue, if any; it must be managed.
 * @returns The new issue.
 */
async function createIssueIn(
  ts: ToolScope,
  input: IssueFields & { title: string; team?: string },
  parentRef: string | undefined,
): Promise<ToolOutput> {
  const parent = parentRef ? await ts.issue(parentRef) : undefined;
  if (parent) await ts.assertManaged(parent);
  const team = await teamFor(ts, input.team, parent);
  const fields = await issueFields(ts, input, team.id);
  const { issueCreate } = await ts.linear(
    CreateIssue,
    {
      input: {
        teamId: team.id,
        title: input.title,
        ...(fields.description !== undefined
          ? { description: fields.description }
          : {}),
        ...(fields.labelIds ? { labelIds: fields.labelIds } : {}),
        ...(fields.priority !== undefined ? { priority: fields.priority } : {}),
        ...(fields.projectId ? { projectId: fields.projectId } : {}),
        ...(parent ? { parentId: parent.id } : {}),
        ...attribution(ts.session),
      },
    },
    "write",
  );
  const issue = issueCreate.issue;
  await ts.recordWrite(issue.identifier, issue.id);
  return {
    text: `Created ${issue.identifier}: ${issue.title} — ${issue.url}`,
    data: {
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
      },
    },
  };
}

/**
 * `linear_create_issue`.
 * @param ts - The call.
 * @param input - The tool input.
 * @returns The new issue.
 */
export function createIssue(
  ts: ToolScope,
  input: IssueFields & { title: string; team?: string; parent?: string },
): Promise<ToolOutput> {
  return createIssueIn(ts, input, input.parent);
}

/**
 * `linear_create_sub_issue`.
 * @param ts - The call.
 * @param input - The tool input.
 * @returns The new issue.
 */
export function createSubIssue(
  ts: ToolScope,
  input: IssueFields & { title: string; team?: string; parent: string },
): Promise<ToolOutput> {
  return createIssueIn(ts, input, input.parent);
}

/**
 * `linear_update_issue`. Never the assignee: the schema has no such field.
 * @param ts - The call.
 * @param input - The tool input.
 * @returns What changed.
 */
export async function updateIssue(
  ts: ToolScope,
  input: IssueFields & { issue: string; estimate?: number },
): Promise<ToolOutput> {
  const target = await ts.issue(input.issue);
  await ts.assertManaged(target);
  const fields: LinearIssueUpdateInput = {
    ...(await issueFields(ts, input, target.team.id)),
    ...(input.estimate !== undefined ? { estimate: input.estimate } : {}),
  };
  const changed = Object.keys(fields);
  if (changed.length === 0)
    throw toolInputRefused("Nothing to change: pass at least one field.");
  await ts.linear(UpdateIssue, { id: target.id, input: fields }, "write");
  await ts.recordWrite(target.identifier, target.id);
  return {
    text: `Updated ${target.identifier} (${changed.join(", ")}): ${target.url}`,
    data: { issue: target.identifier, changed },
  };
}

/**
 * `linear_create_relation`: both ends readable, at least one managed.
 * @param ts - The call.
 * @param input - The tool input.
 * @returns The relation.
 */
export async function createRelation(
  ts: ToolScope,
  input: { issue: string; relatedIssue: string; type: string },
): Promise<ToolOutput> {
  const [a, b] = await Promise.all([
    ts.issue(input.issue),
    ts.issue(input.relatedIssue),
  ]);
  ts.assertReadable(a.team, a.identifier);
  ts.assertReadable(b.team, b.identifier);
  if (ts.role !== "manager")
    throw targetRefused("Only a manager session may do that.");
  if (!(await ts.isManaged(a)) && !(await ts.isManaged(b))) {
    throw targetRefused(
      `Neither ${a.identifier} nor ${b.identifier} is an issue you manage.`,
    );
  }
  const { issueRelationCreate } = await ts.linear(
    CreateIssueRelation,
    { input: { issueId: a.id, relatedIssueId: b.id, type: input.type } },
    "write",
  );
  const said = `${a.identifier} ${input.type === "related" ? "related to" : input.type === "duplicate" ? "duplicates" : "blocks"} ${b.identifier}`;
  await ts.recordWrite(said, issueRelationCreate.issueRelation.id);
  return {
    text: `Related: ${said}.`,
    data: { relation: issueRelationCreate.issueRelation },
  };
}

/**
 * `hypotenuse_dispatch`: start a worker on an issue the manager manages, or
 * send a finished one back with changes (`ops/DispatchOps.ts`).
 * @param ts - The call.
 * @param input - The tool input.
 * @returns What was dispatched.
 */
export async function dispatch(
  ts: ToolScope,
  input: {
    issue: string;
    instructions?: string;
    agentPreference?: string;
    mode?: "new" | "changes";
  },
): Promise<ToolOutput> {
  const result = await runDispatch(ts, input);
  const where = result.externalSessionUrl
    ? ` (${result.externalSessionUrl})`
    : "";
  const text =
    result.mode === "changes"
      ? `Sent ${result.issueIdentifier} back to its worker with your changes (review round ${result.reviewRound + 1})${where}. You will get a review turn when it finishes.`
      : `Dispatched ${result.issueIdentifier} to a worker${where}. You will get a review turn with its result when it finishes; there is nothing to wait for in this turn.`;
  return { text, data: { dispatch: result } };
}

// ── Writes to projects and documents ─────────────────────────────────────

/**
 * The project a manager may write: the session issue's.
 * @param ts - The call.
 * @param ref - What the agent named, if anything.
 * @returns Its id.
 * @throws {TypedError} 403 for another project, 404 for none.
 */
async function managedProjectId(
  ts: ToolScope,
  ref: string | undefined,
): Promise<string> {
  const own = await sessionProjectId(ts);
  if (ref) {
    const project = await readableProject(ts, ref);
    if (project.id !== own) {
      throw targetRefused(
        `Project ${project.name} is not the project of ${ts.session.issueIdentifier ?? "this session's issue"}; a manager writes only that one.`,
      );
    }
    return project.id;
  }
  if (!own) {
    throw notFound(
      `${ts.session.issueIdentifier ?? "This session's issue"} is in no project.`,
    );
  }
  return own;
}

/**
 * `linear_update_project`: content, summary, status — never lead or members.
 * @param ts - The call.
 * @param input - The tool input.
 * @returns What changed.
 */
export async function updateProject(
  ts: ToolScope,
  input: {
    project?: string;
    content?: string;
    summary?: string;
    status?: string;
  },
): Promise<ToolOutput> {
  const id = await managedProjectId(ts, input.project);
  const update: { content?: string; description?: string; statusId?: string } =
    {};
  if (input.content !== undefined)
    update.content = bodyForLinear(input.content, "The project's content");
  if (input.summary !== undefined) update.description = input.summary;
  if (input.status !== undefined) {
    const { organization } = await ts.linear(ListProjectStatuses, {}, "read");
    const wanted = input.status.trim().toLowerCase();
    const status =
      organization.projectStatuses.find(
        (s) => s.name.toLowerCase() === wanted,
      ) ??
      organization.projectStatuses.find((s) => s.type.toLowerCase() === wanted);
    if (!status) {
      throw toolInputRefused(
        `No project status "${input.status}". Statuses: ${organization.projectStatuses.map((s) => `${s.name} (${s.type})`).join(", ")}.`,
      );
    }
    update.statusId = status.id;
  }
  const changed = Object.keys(update);
  if (changed.length === 0)
    throw toolInputRefused(
      "Nothing to change: pass content, summary, or status.",
    );
  const { projectUpdate } = await ts.linear(
    UpdateProject,
    { id, input: update },
    "write",
  );
  await ts.recordWrite(projectUpdate.project.name, projectUpdate.project.id);
  return {
    text: `Updated project ${projectUpdate.project.name}: ${projectUpdate.project.url}`,
    data: { project: projectUpdate.project, changed },
  };
}

/**
 * `linear_create_document`: on the session issue's project, or on an issue
 * the session manages.
 * @param ts - The call.
 * @param input - The tool input.
 * @returns The document.
 */
export async function createDocument(
  ts: ToolScope,
  input: { title: string; content: string; project?: string; issue?: string },
): Promise<ToolOutput> {
  if (input.project && input.issue)
    throw toolInputRefused("Attach it to a project or an issue, not both.");
  const content = bodyForLinear(input.content, "The document");
  let attach: { projectId: string } | { issueId: string };
  if (input.issue) {
    const target = await ts.issue(input.issue);
    await ts.assertManaged(target);
    attach = { issueId: target.id };
  } else {
    attach = { projectId: await managedProjectId(ts, input.project) };
  }
  const { documentCreate } = await ts.linear(
    CreateDocument,
    { input: { title: input.title, content, ...attach } },
    "write",
  );
  const document = documentCreate.document;
  await ts.recordWrite(document.title, document.id);
  return {
    text: `Created document ${document.title}: ${document.url} (id \`${document.id}\`)`,
    data: { document },
  };
}

/**
 * `linear_update_document`: one this session created, or one on the session
 * issue's project or on an issue it manages.
 * @param ts - The call.
 * @param input - The tool input.
 * @returns The document.
 */
export async function updateDocument(
  ts: ToolScope,
  input: { document: string; content: string; title?: string },
): Promise<ToolOutput> {
  const content = bodyForLinear(input.content, "The document");
  let document: LinearDocument;
  try {
    document = (await ts.linear(GetDocument, { id: input.document }, "read"))
      .document;
  } catch (e) {
    if (isLinearNotFound(e))
      throw notFound(`No document ${input.document} that Hypotenuse can read.`);
    throw e;
  }
  const created = (await ts.ledger()).some(
    (w) => w.tool === "linear_create_document" && w.linearId === document.id,
  );
  const onProject =
    document.project !== null &&
    document.project.id === (await sessionProjectId(ts));
  const onIssue =
    document.issue !== null &&
    (await ts.isManaged(await ts.issue(document.issue.id)));
  if (!created && !onProject && !onIssue) {
    throw targetRefused(
      `Document ${document.title} is not one this session created, nor attached to ${ts.session.issueIdentifier ?? "this session's issue"}'s project or an issue you manage.`,
    );
  }
  const { documentUpdate } = await ts.linear(
    UpdateDocument,
    {
      id: document.id,
      input: { content, ...(input.title ? { title: input.title } : {}) },
    },
    "write",
  );
  await ts.recordWrite(documentUpdate.document.title, document.id);
  return {
    text: `Updated document ${documentUpdate.document.title}: ${documentUpdate.document.url}`,
    data: { document: documentUpdate.document },
  };
}

// ── The session's own activity (through the outbox) ──────────────────────

/**
 * `linear_set_plan`: replace the session's plan, through the outbox.
 * @param ts - The call.
 * @param input - The tool input.
 * @returns How many steps.
 */
export async function setPlan(
  ts: ToolScope,
  input: {
    steps: {
      content: string;
      status: (typeof PLAN_STEP_STATUSES)[number];
    }[];
  },
): Promise<ToolOutput> {
  await inHeldTurn(ts, (tx, session) =>
    enqueueSessionUpdate(tx, session.id, { plan: input.steps }),
  );
  await ts.recordWrite("the session's plan", ts.session.externalSessionId);
  return {
    text: `Plan set (${input.steps.length} step${input.steps.length === 1 ? "" : "s"}).`,
    data: { steps: input.steps.length },
  };
}

/**
 * `linear_ask_user`: post an `elicitation` (a `select` with options) through
 * the outbox. It answers the turn — no fallback is posted when the turn ends
 * without a response — and marks it waiting, so a reply that arrives before
 * the turn ends is delivered rather than lost; the daemon reports it unread
 * and it becomes the next turn.
 * @param ts - The call.
 * @param input - The tool input.
 * @returns The instruction to end the turn.
 */
export async function askUser(
  ts: ToolScope,
  input: { question: string; options?: { label: string; value?: string }[] },
): Promise<ToolOutput> {
  const options = input.options?.map((o) => ({
    label: o.label,
    value: o.value ?? o.label,
  }));
  await inHeldTurn(ts, async (tx, session) => {
    await enqueueActivity(
      tx,
      session.id,
      { type: "elicitation", body: input.question },
      options ? { signal: "select", signalMetadata: { options } } : {},
    );
    const now = new Date();
    await tx
      .update(workItems)
      .set({
        answeredAt: sql`coalesce(${workItems.answeredAt}, ${now.toISOString()}::timestamptz)`,
        awaitingAnswerSince: now,
      })
      .where(eq(workItems.id, ts.scope.item.id));
  });
  await ts.recordWrite("a question", ts.session.externalSessionId);
  return { text: ASKED_TEXT, data: { asked: true, options: options ?? null } };
}

/**
 * Whether a URL is on a repository: same host, and its path starts with the
 * repository's `owner/name` with something after it.
 * @param url - The pull request URL.
 * @param repository - `hostname/owner/name`.
 * @returns True when it is.
 */
export function urlOnRepository(url: string, repository: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
  const repo = normalizeRemote(repository).toLowerCase();
  const [host, ...path] = repo.split("/");
  if (parsed.hostname.toLowerCase() !== host) return false;
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length <= path.length) return false;
  return path.every((p, i) => segments[i]?.toLowerCase() === p);
}

/**
 * `linear_report_pr`: link a pull request on the session's repository,
 * through the outbox, labelled like the daemon's own detection labels them.
 * @param ts - The call.
 * @param input - The tool input.
 * @returns The link.
 */
export async function reportPr(
  ts: ToolScope,
  input: { url: string },
): Promise<ToolOutput> {
  const repository = ts.session.repository;
  if (!repository) {
    throw toolInputRefused(
      "This session works in no repository, so it has no pull request to link.",
    );
  }
  if (!urlOnRepository(input.url, repository)) {
    throw toolInputRefused(
      `${input.url} is not on this session's repository (${repository}).`,
    );
  }
  const label = await inHeldTurn(ts, async (tx, session) => {
    // Linked already, or on its way: the session's links as last sent, and
    // any still waiting in the outbox (the daemon's own detection, say).
    const pending = await tx
      .select({ content: agentActivities.content })
      .from(agentActivities)
      .where(
        and(
          eq(agentActivities.agentSessionId, session.id),
          eq(agentActivities.kind, "session_update"),
          eq(agentActivities.deliveryStatus, "pending"),
        ),
      );
    const links = [
      ...session.externalUrls,
      ...pending.flatMap(
        (r) =>
          (r.content.addedExternalUrls as
            | AgentSessionExternalUrl[]
            | undefined) ?? [],
      ),
    ];
    // The issue gets it too, once per URL — even when the session has it.
    await enqueueIssueAttachment(tx, session.id, {
      label: PULL_REQUEST_LABEL,
      url: input.url,
    });
    if (links.some((l) => l.url === input.url)) return null;
    const prior = links.filter((l) =>
      l.label.startsWith(PULL_REQUEST_LABEL),
    ).length;
    const label =
      prior === 0 ? PULL_REQUEST_LABEL : `${PULL_REQUEST_LABEL} (${prior + 1})`;
    await enqueueSessionUpdate(tx, session.id, {
      addedExternalUrls: [{ label, url: input.url }],
    });
    return label;
  });
  if (label === null) {
    return {
      text: `${input.url} is already linked to this session.`,
      data: { url: input.url, linked: false },
    };
  }
  await ts.recordWrite(label, ts.session.externalSessionId);
  return {
    text: `Linked ${input.url} to the session as "${label}".`,
    data: { url: input.url, label, linked: true },
  };
}
