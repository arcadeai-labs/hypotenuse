/**
 * The only implementation of a Hypotenuse prompt. `buildPrompt` turns a
 * `WorkAssignment` and the role's config into the content blocks of
 * `session/prompt`: one `text` block in sections, plus a `resource_link` to
 * the issue.
 *
 * ```
 * <hypotenuse>           who the agent is working for, and that it is an AI
 * <role-instructions>    the role's template, rendered
 * <role-docs>            the role's `docs`: files inlined, URLs linked
 * <linear-context>       Linear's promptContext, verbatim
 * <guidance>             nearest team first, workspace last
 * <conversation>         prompts, responses, elicitations, errors so far
 * <request>              this turn
 * <environment>          where it is working
 * ```
 *
 * A turn a manager session handed over carries its own request, in headed
 * sections of `<request>`: a dispatch's `## Instructions from the planning
 * agent`, a change request's `## Changes requested by the planning agent`,
 * and a manager's review turn's `## Worker result for ENG-123 (round N)` —
 * the worker's outcome, pull requests, plan, and final response in a fenced
 * block. Linear lets no agent write a prompt, so these exist only here.
 *
 * A turn that resumes the agent's own session gets only a one-line
 * `<hypotenuse>` reminder and the `<request>`: the agent already holds the
 * rest, and re-sending it every turn reads as new instructions.
 *
 * Templates are Markdown with `{{dotted.variable}}` and no logic. An unknown
 * variable is an error at `config validate` and renders empty here.
 *
 * The daemon never fetches a URL for a prompt. A `prompt_file` URL becomes an
 * instruction to read and follow that document, and a `docs` URL a link to
 * read first: the agent reaches them with its own tools (an MCP server for a
 * private wiki), which hold credentials the daemon has no business holding.
 * A doc's text is included verbatim, never rendered as a template.
 */
import type {
  AssignmentReview,
  WorkAssignment,
} from "../../../protocol/src/index";
import type { RoleConfig } from "../config/schema";
import { PROMPT_VARIABLES, templateVariables } from "../config/validate";
import type { ContentBlock } from "./connection";
import managerTemplate from "./templates/manager.md" with { type: "text" };
import workerTemplate from "./templates/worker.md" with { type: "text" };

/** The built-in template for each role. */
export const DEFAULT_TEMPLATES = {
  worker: workerTemplate,
  manager: managerTemplate,
} as const;

/** Where the turn runs, as the prompt describes it. */
export interface PromptContext {
  /** The worktree (or directory) the agent works in. */
  cwd: string;
  /** The branch, if the directory is a git checkout on one. */
  branch: string | null;
  /** The repository's name in the config, if any. */
  repositoryName: string | null;
  /** This runner. */
  runnerName: string;
  /** Whether the agent resumed its own session (so holds the history). */
  resumed: boolean;
  /** A role's `prompt_file`, already read; overrides `prompt`. */
  templateText?: string | null;
  /** A role's `prompt_file` URL, for the agent to read; overrides `prompt`. */
  templateUrl?: string | null;
  /** A role's `docs`, in order. */
  docs?: readonly RoleDoc[];
  /** Whether the directory is a read-only checkout (a manager's). */
  readOnly?: boolean;
}

/** One entry of a role's `docs`, as the prompt includes it. */
export interface RoleDoc {
  /** A URL, or the file's path as shown to people. */
  source: string;
  /** The file's text; null for a URL, which the agent reads itself. */
  text: string | null;
}

/**
 * Every variable a template may use, for `config validate` and docs.
 * @returns The variable names.
 */
export function listTemplateVariables(): readonly string[] {
  return PROMPT_VARIABLES;
}

/**
 * The value of every template variable for a turn.
 * @param assignment - The turn.
 * @param ctx - Where it runs.
 * @returns Variable → value; unavailable ones are empty.
 */
export function templateValues(
  assignment: WorkAssignment,
  ctx: PromptContext,
): Record<string, string> {
  const creator = (
    assignment as {
      creator?: { name?: string | null; email?: string | null } | null;
    }
  ).creator;
  const issue = assignment.issue as WorkAssignment["issue"] & {
    teamName?: string | null;
  };
  return {
    "issue.identifier": issue.identifier ?? "",
    "issue.title": issue.title ?? "",
    "issue.url": issue.url ?? "",
    "issue.description": issue.description ?? "",
    "issue.team.key": issue.teamKey ?? "",
    "issue.team.name": issue.teamName ?? "",
    "session.url": assignment.externalSessionUrl ?? "",
    "session.id": String(assignment.agentSessionId),
    role: assignment.role,
    "creator.name": creator?.name ?? "",
    "creator.email": creator?.email ?? "",
    "repository.name": ctx.repositoryName ?? "",
    "repository.remote": assignment.repository?.remote ?? "",
    "repository.base_branch": assignment.repository?.baseBranch ?? "",
    "worktree.path": ctx.cwd,
    "worktree.branch": ctx.branch ?? "",
    "runner.name": ctx.runnerName,
    "dispatch.parent_identifier":
      assignment.dispatch?.parent.issueIdentifier ?? "",
  };
}

/**
 * Render a template.
 * @param template - The text.
 * @param values - Variable → value.
 * @param onUnknown - Called once per unknown variable.
 * @returns The rendered text.
 */
export function renderTemplate(
  template: string,
  values: Record<string, string>,
  onUnknown?: (name: string) => void,
): string {
  const reported = new Set<string>();
  return template.replace(/\{\{\s*([^}\s]+)\s*\}\}/g, (_, name: string) => {
    if (Object.hasOwn(values, name)) return values[name] as string;
    if (!reported.has(name)) {
      reported.add(name);
      onUnknown?.(name);
    }
    return "";
  });
}

/**
 * The unknown variables in a template.
 * @param template - The text.
 * @returns Names that are not template variables.
 */
export function unknownVariables(template: string): string[] {
  const known = new Set<string>(PROMPT_VARIABLES);
  return [...new Set(templateVariables(template))].filter((n) => !known.has(n));
}

/**
 * Wrap a section in its tag, or nothing when it is empty.
 * @param tag - The tag.
 * @param body - The content.
 * @param attributes - The open tag's attributes.
 * @returns The section.
 */
function section(
  tag: string,
  body: string | null | undefined,
  attributes = "",
): string | null {
  const text = (body ?? "").trim();
  if (!text) return null;
  return `<${tag}${attributes}>\n${text}\n</${tag}>`;
}

/**
 * An attribute value, quoted.
 * @param value - The value.
 * @returns `"value"` with quotes escaped.
 */
function attr(value: string): string {
  return `"${value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
}

/**
 * A fence longer than any run of backticks in the text, so the text cannot
 * close it.
 * @param text - What goes inside.
 * @returns The fence.
 */
function fenceFor(text: string): string {
  const longest = Math.max(
    0,
    ...[...text.matchAll(/`+/g)].map((m) => m[0].length),
  );
  return "`".repeat(Math.max(3, longest + 1));
}

/**
 * The role's instructions when its `prompt_file` is a URL.
 * @param url - The URL.
 * @returns The text of `<role-instructions>`.
 */
export function remoteInstructions(url: string): string {
  return `Your instructions for this role are the document at ${url}. Read it with your tools before doing anything else, and follow it. If you cannot read it, say so in your response and stop.`;
}

/**
 * The `<role-docs>` section's body: the URLs to read first, then each file.
 * @param docs - The role's docs, in order.
 * @returns The body, or empty when there are none.
 */
export function roleDocsSection(docs: readonly RoleDoc[]): string {
  if (docs.length === 0) return "";
  const links = docs.filter((d) => d.text === null).map((d) => d.source);
  const files = docs.filter((d) => d.text !== null);
  return [
    "These documents are part of your instructions: they say how this team works. Where one disagrees with the instructions above about your tools or what you never do, the instructions above win.",
    links.length
      ? `Read each of these with your tools before you begin. If one cannot be read, say so in your response.\n${links.map((l) => `- ${l}`).join("\n")}`
      : null,
    ...files.map(
      (d) => `<doc source=${attr(d.source)}>\n${(d.text ?? "").trim()}\n</doc>`,
    ),
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * A manager's review turn: one dispatched worker's result.
 * @param review - The result.
 * @returns The headed section.
 */
export function reviewSection(review: AssignmentReview): string {
  const issue = review.childIssueIdentifier ?? "the dispatched issue";
  const body = [
    `outcome: ${review.outcome}`,
    `pull requests: ${review.pullRequests.length ? "" : "none"}`,
    ...review.pullRequests.map((p) => `- ${p.label}: ${p.url}`),
    `plan: ${review.plan?.length ? "" : "none"}`,
    ...(review.plan ?? []).map((s) => `- [${s.status}] ${s.content}`),
    "final response:",
    review.finalResponse?.trim() || "(none)",
  ]
    .map((line) => line.trimEnd())
    .join("\n");
  const fence = fenceFor(body);
  return [
    `## Worker result for ${issue} (round ${review.reviewRound + 1})`,
    review.childIssueUrl ? `Issue: ${review.childIssueUrl}` : null,
    `${fence}\n${body}\n${fence}`,
    "Review it against the issue's acceptance criteria, then accept it, request changes, or file follow-ups — and end with a response that says which, and why.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * What this turn asks for: a review, a change request, or the person's
 * prompts (else the mention's text), with a dispatch's instructions after.
 * @param assignment - The turn.
 * @returns The request text.
 */
export function requestText(assignment: WorkAssignment): string {
  const parts: string[] = [];
  const prompts = (assignment.prompt ?? [])
    .map((p) => p.body.trim())
    .filter(Boolean);
  const dispatch = assignment.dispatch;
  const instructions = dispatch?.instructions?.trim();
  if (assignment.review) parts.push(reviewSection(assignment.review));
  if (dispatch?.mode === "changes") {
    parts.push(
      `## Changes requested by the planning agent\n\n${instructions || "Review the issue's acceptance criteria again; the planning agent found the work incomplete."}`,
    );
  }
  if (prompts.length) parts.push(prompts.join("\n\n"));
  if (parts.length === 0)
    parts.push(assignment.instruction?.trim() || "Begin.");
  if (dispatch?.mode === "new" && instructions) {
    parts.push(`## Instructions from the planning agent\n\n${instructions}`);
  }
  return parts.join("\n\n");
}

/**
 * Where a dispatched worker's work came from, for its first turn.
 * @param assignment - The turn.
 * @returns The sentence, or empty.
 */
function dispatchedBy(assignment: WorkAssignment): string {
  const parent = assignment.dispatch?.parent;
  if (!parent) return "";
  const where = parent.issueUrl ?? parent.issueIdentifier;
  return where
    ? ` This issue was dispatched to you by the planning agent's session on ${where}.`
    : " This issue was dispatched to you by the planning agent.";
}

/**
 * The conversation so far, without this turn's own prompts.
 * @param assignment - The turn.
 * @returns The `<turn>` lines.
 */
function conversation(assignment: WorkAssignment): string {
  const own = new Set((assignment.prompt ?? []).map((p) => p.activityId));
  const kept = new Set(["prompt", "response", "elicitation", "error"]);
  return assignment.history
    .filter((h) => kept.has(h.type) && h.body?.trim() && !own.has(h.activityId))
    .map((h) => {
      const role = h.direction === "inbound" ? "user" : "agent";
      const kind =
        h.type === "prompt" || h.type === "response"
          ? ""
          : ` kind=${attr(h.type)}`;
      return `<turn role="${role}"${kind}>\n${(h.body ?? "").trim()}\n</turn>`;
    })
    .join("\n");
}

/**
 * Build the prompt for a turn.
 * @param assignment - What the server assigned.
 * @param role - The role's config (its template), if the runner has one.
 * @param ctx - Where it runs.
 * @param onUnknown - Called once per unknown template variable.
 * @returns The content blocks.
 */
export function buildPrompt(
  assignment: WorkAssignment,
  role: Pick<RoleConfig, "prompt"> | null | undefined,
  ctx: PromptContext,
  onUnknown?: (name: string) => void,
): ContentBlock[] {
  const issue = assignment.issue;
  const who = issue.identifier
    ? `Linear issue ${issue.identifier}`
    : "a Linear issue";
  const values = templateValues(assignment, ctx);
  const creator = values["creator.name"];
  const blocks: ContentBlock[] = [];

  if (ctx.resumed) {
    const text = [
      section(
        "hypotenuse",
        `This is a follow-up in the same Linear agent session for ${who}. You are an AI agent; never claim to be a person.`,
      ),
      section("request", requestText(assignment)),
    ]
      .filter(Boolean)
      .join("\n\n");
    blocks.push({ type: "text", text });
    return blocks;
  }

  const template =
    ctx.templateText ?? role?.prompt ?? DEFAULT_TEMPLATES[assignment.role];
  const guidance = assignment.guidance
    .map((g) =>
      g.origin === "team"
        ? `<rule origin="team"${g.teamKey ? ` team=${attr(g.teamKey)}` : ""}>\n${g.body.trim()}\n</rule>`
        : `<rule origin="workspace">\n${g.body.trim()}\n</rule>`,
    )
    .join("\n");
  const where = [
    `Working directory: ${ctx.cwd}`,
    ctx.branch
      ? ` (branch ${ctx.branch}${assignment.repository?.baseBranch ? `, from ${assignment.repository.baseBranch}` : ""})`
      : "",
  ].join("");
  const environment = [
    where,
    ctx.readOnly
      ? `This is a read-only checkout of ${assignment.repository?.baseBranch ?? "the base branch"} (detached, no branch): read the code, do not change it.`
      : null,
    assignment.repository
      ? `Repository: ${assignment.repository.remote}`
      : "No repository applies to this session: the working directory is a scratch directory, not a checkout.",
    `Runner: ${ctx.runnerName}`,
  ]
    .filter(Boolean)
    .join("\n");

  const text = [
    section(
      "hypotenuse",
      `You are working as the ${assignment.role} agent for ${who}${creator ? ` on behalf of ${creator}` : ""}, in a Linear agent session. You are an AI agent; never claim to be a person. What you say at the end of your turn is posted to the session as your response.${dispatchedBy(assignment)}`,
    ),
    section(
      "role-instructions",
      ctx.templateUrl
        ? remoteInstructions(ctx.templateUrl)
        : renderTemplate(template, values, onUnknown),
    ),
    section("role-docs", roleDocsSection(ctx.docs ?? [])),
    section("linear-context", assignment.promptContext),
    section("guidance", guidance),
    section("conversation", conversation(assignment)),
    section("request", requestText(assignment)),
    section("environment", environment),
  ]
    .filter(Boolean)
    .join("\n\n");
  blocks.push({ type: "text", text });
  if (issue.url) {
    blocks.push({
      type: "resource_link",
      uri: issue.url,
      name: issue.identifier ?? "issue",
      ...(issue.title ? { title: issue.title } : {}),
    });
  }
  return blocks;
}
