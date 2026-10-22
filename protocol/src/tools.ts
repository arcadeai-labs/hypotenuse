import { z } from "zod";
import type { RunnerRole } from "./capabilities";

/**
 * The Hypotenuse MCP tools: what a coding agent can do in Linear, and nothing
 * else. One table, read by both sides so they cannot drift — the daemon's
 * `hypotenuse mcp` server registers each tool with its schema and
 * description, and each tool's `daemon:*` action on the server validates the
 * same schema (plus `agentSessionId`) before it re-derives, from the session
 * row, what the call may touch.
 *
 * Descriptions are written for the model, not for us.
 */

/** An issue as a person writes it: an identifier like `ENG-123`, or its id. */
const issueRef = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe("An issue identifier like ENG-123, or the issue's id");

/** A team as a person writes it: its key (`ENG`) or its id. */
const teamRef = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe("A team key like ENG, or the team's id");

/** A project, by id or exact name. */
const projectRef = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .describe("A project's id or its exact name");

/** Long Markdown text: a comment, a description, a document. */
const markdown = (what: string) =>
  z
    .string()
    .min(1)
    .describe(
      `${what}, in Markdown. Mention people and issues by their Linear URLs, not @names; put long logs or diffs in a collapsible section (+++ Title … +++)`,
    );

/** Labels, by name or id. */
const labels = z
  .array(z.string().trim().min(1).max(255))
  .max(50)
  .describe(
    "Label names or ids (see linear_list_labels); replaces the issue's labels",
  );

/** Linear's priority scale. */
const priority = z
  .number()
  .int()
  .min(0)
  .max(4)
  .describe("0 none, 1 urgent, 2 high, 3 medium, 4 low");

/** A page size for lists capped at 25. */
const first = z
  .number()
  .int()
  .min(1)
  .max(25)
  .optional()
  .describe("How many to return, at most 25 (default 25)");

/** Linear's workflow state types. */
export const ISSUE_STATE_TYPES = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
] as const;

/** Linear's plan step statuses. */
export const PLAN_STEP_STATUSES = [
  "pending",
  "inProgress",
  "completed",
  "canceled",
] as const;

/** One tool: its schema, who may call it, and the action behind it. */
export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  /** The MCP tool name. */
  name: string;
  /** The `daemon:*` action that does the work. */
  action: string;
  /** Its route under `/api`. */
  route: string;
  /** The roles that get the tool. */
  roles: readonly RunnerRole[];
  /** Reads are cached per turn by the daemon; writes invalidate the cache. */
  kind: "read" | "write";
  /** What the model reads. */
  description: string;
  /** The input, without `agentSessionId`. */
  input: S;
}

/**
 * Declare one tool.
 * @param def - The tool.
 * @returns It, typed.
 */
function tool<S extends z.ZodObject>(
  def: ToolDefinition<S>,
): ToolDefinition<S> {
  return def;
}

const BOTH: readonly RunnerRole[] = ["manager", "worker"];
const MANAGER: readonly RunnerRole[] = ["manager"];

/** Every tool, in the order an agent lists them. */
export const HYPOTENUSE_TOOLS = [
  tool({
    name: "linear_get_issue",
    action: "daemon:linear-get-issue",
    route: "/daemon/linear/get-issue",
    roles: BOTH,
    kind: "read",
    description:
      "Read a Linear issue: title, description, state, priority, labels, assignee, delegate, parent, sub-issues, relations, project, team, and URL. Defaults to the issue you are working on. People are listed with their profile URLs; use those URLs to mention someone.",
    input: z.strictObject({ issue: issueRef.optional() }),
  }),
  tool({
    name: "linear_list_comments",
    action: "daemon:linear-list-comments",
    route: "/daemon/linear/list-comments",
    roles: BOTH,
    kind: "read",
    description:
      "Read the comments on a Linear issue, oldest first, replies under the comment they answer. Defaults to the issue you are working on. Pass `after` (from the last page) to read further.",
    input: z.strictObject({
      issue: issueRef.optional(),
      first,
      after: z
        .string()
        .trim()
        .min(1)
        .max(512)
        .optional()
        .describe("The cursor the previous page returned"),
    }),
  }),
  tool({
    name: "linear_comment",
    action: "daemon:linear-comment",
    route: "/daemon/linear/comment",
    roles: BOTH,
    kind: "write",
    description:
      "Post a comment on a Linear issue, as Hypotenuse. Your final answer already appears in Linear as a comment in this session's thread, so never use this to repeat it: use it to answer a question someone left elsewhere on the issue, or to note a blocker for someone who is not following this session. Pass `parentId` to reply in an existing thread.",
    input: z.strictObject({
      body: markdown("The comment"),
      issue: issueRef
        .optional()
        .describe(
          "The issue to comment on; defaults to the issue you are working on",
        ),
      parentId: z
        .string()
        .trim()
        .min(1)
        .max(100)
        .optional()
        .describe("The id of the comment to reply to"),
    }),
  }),
  tool({
    name: "linear_set_issue_state",
    action: "daemon:linear-set-issue-state",
    route: "/daemon/linear/set-issue-state",
    roles: BOTH,
    kind: "write",
    description:
      'Move a Linear issue to a workflow state, by the state\'s name ("In Review") or its type (triage, backlog, unstarted, started, completed, canceled). Defaults to the issue you are working on. A worker cannot cancel an issue.',
    input: z.strictObject({
      state: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .describe("A state name, or a state type"),
      issue: issueRef.optional(),
    }),
  }),
  tool({
    name: "linear_set_plan",
    action: "daemon:linear-set-plan",
    route: "/daemon/linear/set-plan",
    roles: BOTH,
    kind: "write",
    description:
      "Replace this session's plan in Linear with the whole list of steps. Only needed if your own plan updates do not already appear there.",
    input: z.strictObject({
      steps: z
        .array(
          z.strictObject({
            content: z.string().trim().min(1).max(1024).describe("The step"),
            status: z
              .enum(PLAN_STEP_STATUSES)
              .describe("pending, inProgress, completed, or canceled"),
          }),
        )
        .min(1)
        .max(100)
        .describe("Every step, in order"),
    }),
  }),
  tool({
    name: "linear_ask_user",
    action: "daemon:linear-ask-user",
    route: "/daemon/linear/ask-user",
    roles: BOTH,
    kind: "write",
    description:
      "Ask the person a question in Linear when you need their decision to go on. With `options`, Linear shows them as choices (a GitHub repository URL as a value renders as that repository). Their answer arrives as your next prompt: after calling this, end your turn at once without a further message.",
    input: z.strictObject({
      question: z.string().trim().min(1).max(10_000).describe("The question"),
      options: z
        .array(
          z.strictObject({
            label: z
              .string()
              .trim()
              .min(1)
              .max(255)
              .describe("What the person sees"),
            value: z
              .string()
              .trim()
              .min(1)
              .max(2048)
              .optional()
              .describe("What you get back; defaults to the label"),
          }),
        )
        .min(2)
        .max(10)
        .optional()
        .describe("2 to 10 choices; omit for a free-text answer"),
    }),
  }),
  tool({
    name: "linear_report_pr",
    action: "daemon:linear-report-pr",
    route: "/daemon/linear/report-pr",
    roles: BOTH,
    kind: "write",
    description:
      "Link the pull request you opened to this session in Linear. Call it as soon as the pull request exists. It must be a pull request on this session's repository.",
    input: z.strictObject({
      url: z.url().max(2048).describe("The pull request's URL"),
    }),
  }),
  tool({
    name: "linear_search_issues",
    action: "daemon:linear-search-issues",
    route: "/daemon/linear/search-issues",
    roles: BOTH,
    kind: "read",
    description:
      "Search Linear issues by text in their title or description, narrowed by team, state type, label, or project. At most 25 results.",
    input: z.strictObject({
      query: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .optional()
        .describe("Text to find in titles and descriptions"),
      team: teamRef.optional(),
      stateType: z
        .enum(ISSUE_STATE_TYPES)
        .optional()
        .describe("Only issues in states of this type"),
      label: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .optional()
        .describe("Only issues with this label name"),
      project: projectRef.optional(),
      first,
    }),
  }),
  tool({
    name: "linear_create_issue",
    action: "daemon:linear-create-issue",
    route: "/daemon/linear/create-issue",
    roles: MANAGER,
    kind: "write",
    description:
      "Create a Linear issue. Defaults to the team of the issue you are working on. Never assigns anyone: hand work to a worker with hypotenuse_dispatch.",
    input: z.strictObject({
      title: z.string().trim().min(1).max(255).describe("The title"),
      description: markdown("The description").optional(),
      team: teamRef.optional(),
      labels: labels.optional(),
      priority: priority.optional(),
      project: projectRef.optional(),
      parent: issueRef.optional().describe("Make it a sub-issue of this issue"),
    }),
  }),
  tool({
    name: "linear_update_issue",
    action: "daemon:linear-update-issue",
    route: "/daemon/linear/update-issue",
    roles: MANAGER,
    kind: "write",
    description:
      "Edit a Linear issue you manage: its title, description, labels, priority, project, or estimate. It cannot change the assignee.",
    input: z.strictObject({
      issue: issueRef,
      title: z.string().trim().min(1).max(255).optional().describe("The title"),
      description: markdown("The description").optional(),
      labels: labels.optional(),
      priority: priority.optional(),
      project: projectRef.optional(),
      estimate: z
        .number()
        .int()
        .min(0)
        .max(100)
        .optional()
        .describe("The estimate, in the team's points"),
    }),
  }),
  tool({
    name: "linear_create_sub_issue",
    action: "daemon:linear-create-sub-issue",
    route: "/daemon/linear/create-sub-issue",
    roles: MANAGER,
    kind: "write",
    description:
      "Create a sub-issue under an issue you manage — how a plan is broken into tickets. It goes in the parent's team unless you name another.",
    input: z.strictObject({
      parent: issueRef.describe("The parent issue"),
      title: z.string().trim().min(1).max(255).describe("The title"),
      description: markdown("The description").optional(),
      team: teamRef.optional(),
      labels: labels.optional(),
      priority: priority.optional(),
      project: projectRef.optional(),
    }),
  }),
  tool({
    name: "linear_create_relation",
    action: "daemon:linear-create-relation",
    route: "/daemon/linear/create-relation",
    roles: MANAGER,
    kind: "write",
    description:
      "Relate two Linear issues: `blocks` (issue blocks relatedIssue), `related`, or `duplicate` (issue duplicates relatedIssue). At least one of them must be an issue you manage.",
    input: z.strictObject({
      issue: issueRef,
      relatedIssue: issueRef.describe("The other issue"),
      type: z
        .enum(["blocks", "related", "duplicate"])
        .describe("blocks, related, or duplicate"),
    }),
  }),
  tool({
    name: "linear_get_project",
    action: "daemon:linear-get-project",
    route: "/daemon/linear/get-project",
    roles: MANAGER,
    kind: "read",
    description:
      "Read a Linear project: its name, summary, content (the PRD), status, lead, how many issues are in each state, and its documents. Defaults to the project of the issue you are working on.",
    input: z.strictObject({ project: projectRef.optional() }),
  }),
  tool({
    name: "linear_update_project",
    action: "daemon:linear-update-project",
    route: "/daemon/linear/update-project",
    roles: MANAGER,
    kind: "write",
    description:
      "Write a Linear project's content (the PRD, in Markdown), its one-line summary, or its status. Only the project of the issue you are working on. It never changes the lead or the members.",
    input: z.strictObject({
      project: projectRef.optional(),
      content: markdown("The project's content (the PRD)").optional(),
      summary: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .optional()
        .describe("The one-line summary shown under the project's name"),
      status: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .optional()
        .describe(
          "A project status name, or its type (backlog, planned, started, paused, completed, canceled)",
        ),
    }),
  }),
  tool({
    name: "linear_create_document",
    action: "daemon:linear-create-document",
    route: "/daemon/linear/create-document",
    roles: MANAGER,
    kind: "write",
    description:
      "Create a Linear document attached to a project or an issue you manage. Defaults to the project of the issue you are working on.",
    input: z.strictObject({
      title: z.string().trim().min(1).max(255).describe("The title"),
      content: markdown("The document"),
      project: projectRef.optional(),
      issue: issueRef
        .optional()
        .describe("Attach it to this issue instead of a project"),
    }),
  }),
  tool({
    name: "linear_update_document",
    action: "daemon:linear-update-document",
    route: "/daemon/linear/update-document",
    roles: MANAGER,
    kind: "write",
    description:
      "Replace a Linear document's content (and optionally its title): one this session created, or one attached to the project of the issue you are working on.",
    input: z.strictObject({
      document: z.string().trim().min(1).max(100).describe("The document's id"),
      content: markdown("The document's new content"),
      title: z
        .string()
        .trim()
        .min(1)
        .max(255)
        .optional()
        .describe("A new title"),
    }),
  }),
  tool({
    name: "linear_list_labels",
    action: "daemon:linear-list-labels",
    route: "/daemon/linear/list-labels",
    roles: MANAGER,
    kind: "read",
    description:
      "List the labels you can put on a team's issues (the team's own and the workspace's). Defaults to the team of the issue you are working on.",
    input: z.strictObject({ team: teamRef.optional() }),
  }),
  tool({
    name: "hypotenuse_dispatch",
    action: "daemon:dispatch",
    route: "/daemon/dispatch",
    roles: MANAGER,
    kind: "write",
    description:
      "Hand an issue you manage to a Hypotenuse worker to implement, with an optional instruction for it.",
    input: z.strictObject({
      issue: issueRef,
      instruction: z
        .string()
        .trim()
        .min(1)
        .max(10_000)
        .optional()
        .describe("What the worker should do, beyond the issue itself"),
    }),
  }),
] as const;

/** One tool's name. */
export type HypotenuseToolName = (typeof HYPOTENUSE_TOOLS)[number]["name"];

/**
 * The tools a role gets.
 * @param role - The session's role.
 * @returns The tools, in order.
 */
export function toolsForRole(role: RunnerRole): ToolDefinition[] {
  return HYPOTENUSE_TOOLS.filter((t) =>
    (t.roles as readonly RunnerRole[]).includes(role),
  ) as unknown as ToolDefinition[];
}

/**
 * A tool by name.
 * @param name - The MCP tool name.
 * @returns The tool, or undefined.
 */
export function toolByName(name: string): ToolDefinition | undefined {
  return HYPOTENUSE_TOOLS.find((t) => t.name === name) as
    | ToolDefinition
    | undefined;
}

/** What every tool action answers: Markdown for the model, and the data. */
export const ToolResult = z.looseObject({
  result: z.looseObject({
    text: z.string(),
    data: z.record(z.string(), z.unknown()),
  }),
});
export type ToolResult = z.infer<typeof ToolResult>;

/** The largest tool result, in bytes, before it is cut. */
export const TOOL_RESULT_MAX_BYTES = 16 * 1024;

/** The largest comment or document body a tool writes, in bytes. */
export const TOOL_BODY_MAX_BYTES = 64 * 1024;
