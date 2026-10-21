/**
 * The only implementation of a Hypotenuse prompt. `buildPrompt` turns a
 * `WorkAssignment` and the role's config into the content blocks of
 * `session/prompt`: one `text` block in sections, plus a `resource_link` to
 * the issue.
 *
 * ```
 * <hypotenuse>           who the agent is working for, and that it is an AI
 * <role-instructions>    the role's template, rendered
 * <linear-context>       Linear's promptContext, verbatim
 * <guidance>             nearest team first, workspace last
 * <conversation>         prompts, responses, elicitations, errors so far
 * <request>              this turn
 * <environment>          where it is working
 * ```
 *
 * A turn that resumes the agent's own session gets only a one-line
 * `<hypotenuse>` reminder and the `<request>`: the agent already holds the
 * rest, and re-sending it every turn reads as new instructions.
 *
 * Templates are Markdown with `{{dotted.variable}}` and no logic. An unknown
 * variable is an error at `config validate` and renders empty here.
 */
import type { WorkAssignment } from "../../../protocol/src/index";
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
      ((assignment as { dispatch?: { parentIdentifier?: string } }).dispatch
        ?.parentIdentifier as string | undefined) ?? "",
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
 * What this turn asks for.
 * @param assignment - The turn.
 * @returns The request text.
 */
export function requestText(assignment: WorkAssignment): string {
  const prompts = (assignment.prompt ?? [])
    .map((p) => p.body.trim())
    .filter(Boolean);
  if (prompts.length) return prompts.join("\n\n");
  const instruction = assignment.instruction?.trim();
  return instruction || "Begin.";
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
    assignment.repository
      ? `Repository: ${assignment.repository.remote}`
      : null,
    `Runner: ${ctx.runnerName}`,
  ]
    .filter(Boolean)
    .join("\n");

  const text = [
    section(
      "hypotenuse",
      `You are working as the ${assignment.role} agent for ${who}${creator ? ` on behalf of ${creator}` : ""}, in a Linear agent session. You are an AI agent; never claim to be a person. What you say at the end of your turn is posted to the session as your response.`,
    ),
    section("role-instructions", renderTemplate(template, values, onUnknown)),
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
