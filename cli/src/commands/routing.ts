/**
 * `hypotenuse routing` — the selected project's routing rules
 * (`routing-rule:*`) and routing settings (`project:settings-view` /
 * `project:settings-edit`): which role answers a new session, how long
 * work waits for a runner, and what a manager session may do.
 *
 * Rules are evaluated in order; the first enabled rule whose match holds
 * decides the role (and may pin a repository). With no match the role is
 * worker.
 */
import type { Command } from "commander";
import type { ApiClient } from "../api/client";
import {
  ApiError,
  emit,
  pageFooter,
  pageQuery,
  runCommand,
  withPaging,
} from "../context";
import { table } from "../output/theme";

/** What a rule matches; every present field must hold. */
export interface RoutingMatch {
  labels?: string[];
  teamKeys?: string[];
  projectIds?: string[];
  promptPrefix?: string;
  hasParent?: boolean;
  projectHasContent?: boolean;
  origin?: "delegation" | "mention";
}

/** A rule as `routing-rule:*` serializes it. */
export interface RoutingRule {
  id: number;
  projectId: number;
  position: number;
  name: string;
  enabled: boolean;
  match: RoutingMatch;
  role: "manager" | "worker";
  repository: string | null;
  createdAt: number;
  updatedAt: number;
}

/** The routing section of a project's settings, resolved. */
export interface RoutingSettings {
  queueTimeoutMs: number;
  stickyTimeoutMs: number;
  offerTtlMs: number;
  repositoryConfidence: number;
  stopGraceMs: number;
  maxReviewRounds: number;
}

/** The manager section of a project's settings, resolved. */
export interface ManagerSettings {
  canCompleteIssues: boolean;
  maxParallelDispatch: number;
}

/** The page envelope every list answers with. */
interface Pagination {
  page: number;
  limit: number;
  pages: number;
  total: number;
}

/** The routing settings keys `--reset` accepts. */
export const ROUTING_SETTING_KEYS = [
  "queueTimeoutMs",
  "stickyTimeoutMs",
  "offerTtlMs",
  "repositoryConfidence",
  "stopGraceMs",
  "maxReviewRounds",
] as const;

/** The manager settings keys `--reset` accepts. */
export const MANAGER_SETTING_KEYS = [
  "canCompleteIssues",
  "maxParallelDispatch",
] as const;

/**
 * Parse a duration: `30m`, `10s`, `1h`, `600000ms`, or a bare number of ms.
 * @param text - What the person typed.
 * @returns Milliseconds.
 * @throws {Error} When it is not a duration.
 */
export function parseDuration(text: string): number {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h)?\s*$/i.exec(text);
  if (!match) {
    throw new Error(
      `"${text}" is not a duration. Use e.g. 30m, 10s, 1h, or 600000ms.`,
    );
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  const factor =
    unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return Math.round(value * factor);
}

/**
 * Format milliseconds as the shortest whole unit: `30m`, `10s`, `1500ms`.
 * @param ms - Milliseconds.
 * @returns The duration.
 */
export function formatDuration(ms: number): string {
  if (ms !== 0 && ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms !== 0 && ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms !== 0 && ms % 1_000 === 0) return `${ms / 1_000}s`;
  return `${ms}ms`;
}

/**
 * Split repeatable, comma-separated values into one list.
 * @param values - Each occurrence of the flag.
 * @returns The trimmed, non-empty values, or undefined when none were given.
 */
export function listOption(values: string[] | undefined): string[] | undefined {
  if (!values || values.length === 0) return undefined;
  const out = values
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

/**
 * Commander's collector for a repeatable option.
 * @param value - This occurrence.
 * @param previous - Earlier occurrences.
 * @returns All of them.
 */
function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/** The rule flags `add` and `edit` share, as commander parses them. */
export interface RuleFlags {
  name?: string;
  role?: string;
  label?: string[];
  team?: string[];
  project?: string[];
  prefix?: string;
  hasParent?: boolean;
  projectHasContent?: boolean;
  origin?: string;
  repository?: string;
}

/**
 * The match a rule's flags describe. `--has-parent` and `--no-parent` set
 * `hasParent` true and false, `--project-has-content` and
 * `--project-empty` `projectHasContent`; absent fields are left out.
 * @param flags - The parsed flags.
 * @returns The match.
 * @throws {Error} For an unknown origin.
 */
export function matchFromFlags(flags: RuleFlags): RoutingMatch {
  const match: RoutingMatch = {};
  const labels = listOption(flags.label);
  const teamKeys = listOption(flags.team);
  const projectIds = listOption(flags.project);
  if (labels) match.labels = labels;
  if (teamKeys) match.teamKeys = teamKeys;
  if (projectIds) match.projectIds = projectIds;
  if (flags.prefix !== undefined) match.promptPrefix = flags.prefix;
  if (flags.hasParent !== undefined) match.hasParent = flags.hasParent;
  if (flags.projectHasContent !== undefined) {
    match.projectHasContent = flags.projectHasContent;
  }
  if (flags.origin !== undefined) {
    if (flags.origin !== "delegation" && flags.origin !== "mention") {
      throw new Error("--origin is delegation or mention.");
    }
    match.origin = flags.origin;
  }
  return match;
}

/**
 * Whether a set of flags names any match field.
 * @param flags - The parsed flags.
 * @returns True when `--label`, `--team`, `--project`, `--prefix`,
 *   `--has-parent`/`--no-parent`, `--project-has-content`/`--project-empty`,
 *   or `--origin` was given.
 */
export function hasMatchFlags(flags: RuleFlags): boolean {
  return Object.keys(matchFromFlags(flags)).length > 0;
}

/**
 * A rule's match as one short line: `labels=PRD,docs team=ENG prefix=/manage`.
 * @param match - The match.
 * @returns The line, or `anything` for an empty match.
 */
export function describeMatch(match: RoutingMatch): string {
  const parts: string[] = [];
  if (match.labels?.length) parts.push(`labels=${match.labels.join(",")}`);
  if (match.teamKeys?.length) parts.push(`team=${match.teamKeys.join(",")}`);
  if (match.projectIds?.length) {
    parts.push(`project=${match.projectIds.join(",")}`);
  }
  if (match.promptPrefix) parts.push(`prefix=${match.promptPrefix}`);
  if (match.hasParent !== undefined) {
    parts.push(match.hasParent ? "sub-issue" : "not sub-issue");
  }
  if (match.projectHasContent !== undefined) {
    parts.push(
      match.projectHasContent ? "project has content" : "project empty",
    );
  }
  if (match.origin) parts.push(`origin=${match.origin}`);
  return parts.length > 0 ? parts.join(" ") : "anything";
}

/**
 * The human rendering of a project's rules, in evaluation order.
 * @param rules - The rules.
 * @returns The table, with the fallthrough said under it.
 */
export function describeRules(rules: RoutingRule[]): string {
  const rows = table(
    rules.map((r) => ({
      position: r.position + 1,
      id: r.id,
      name: r.name,
      role: r.role,
      match: describeMatch(r.match),
      repository: r.repository ?? "-",
      enabled: r.enabled ? "yes" : "no",
    })),
    [
      { key: "position", header: "#", align: "right" },
      { key: "id" },
      { key: "name", maxWidth: 30 },
      { key: "role" },
      { key: "match", maxWidth: 50 },
      { key: "repository", maxWidth: 40 },
      { key: "enabled" },
    ],
  );
  return `${rows}\nNo match: worker.`;
}

/**
 * The human rendering of the routing settings.
 * @param settings - The resolved settings.
 * @returns Lines for stdout.
 */
export function describeRoutingSettings(
  settings: RoutingSettings,
  manager?: ManagerSettings,
): string {
  return [
    `queue timeout          ${formatDuration(settings.queueTimeoutMs)}`,
    `sticky timeout         ${settings.stickyTimeoutMs === 0 ? "off" : formatDuration(settings.stickyTimeoutMs)}`,
    `offer ttl              ${formatDuration(settings.offerTtlMs)}`,
    `stop grace             ${formatDuration(settings.stopGraceMs)}`,
    `repository confidence  ${settings.repositoryConfidence}`,
    `max review rounds      ${settings.maxReviewRounds}`,
    ...(manager
      ? [
          `max parallel dispatch  ${manager.maxParallelDispatch}`,
          `manager completes      ${manager.canCompleteIssues ? "yes" : "no"}`,
        ]
      : []),
  ].join("\n");
}

/** The settings flags, as commander parses them. */
export interface SettingsFlags {
  queueTimeout?: string;
  stickyTimeout?: string;
  offerTtl?: string;
  stopGrace?: string;
  repositoryConfidence?: string;
  maxReviewRounds?: string;
  maxParallelDispatch?: string;
  managerCanComplete?: string;
  reset?: string[];
}

/**
 * The `routing` body a settings edit sends: durations parsed, `--reset`
 * keys sent as `null` (back to the default).
 * @param flags - The parsed flags.
 * @returns The body, or null when nothing was asked to change.
 * @throws {Error} For a bad duration, number, or key.
 */
export function settingsBody(
  flags: SettingsFlags,
): Record<string, number | null> | null {
  const body: Record<string, number | null> = {};
  if (flags.queueTimeout !== undefined) {
    body.queueTimeoutMs = parseDuration(flags.queueTimeout);
  }
  if (flags.stickyTimeout !== undefined) {
    body.stickyTimeoutMs = parseDuration(flags.stickyTimeout);
  }
  if (flags.offerTtl !== undefined) {
    body.offerTtlMs = parseDuration(flags.offerTtl);
  }
  if (flags.stopGrace !== undefined) {
    body.stopGraceMs = parseDuration(flags.stopGrace);
  }
  if (flags.repositoryConfidence !== undefined) {
    const n = Number(flags.repositoryConfidence);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      throw new Error("--repository-confidence is a number from 0 to 1.");
    }
    body.repositoryConfidence = n;
  }
  if (flags.maxReviewRounds !== undefined) {
    const n = Number(flags.maxReviewRounds);
    if (!Number.isInteger(n) || n < 0) {
      throw new Error("--max-review-rounds is a whole number.");
    }
    body.maxReviewRounds = n;
  }
  for (const key of listOption(flags.reset) ?? []) {
    if ((MANAGER_SETTING_KEYS as readonly string[]).includes(key)) continue;
    if (!(ROUTING_SETTING_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `Unknown setting "${key}". One of: ${[...ROUTING_SETTING_KEYS, ...MANAGER_SETTING_KEYS].join(", ")}.`,
      );
    }
    body[key] = null;
  }
  return Object.keys(body).length > 0 ? body : null;
}

/**
 * The `manager` body a settings edit sends, the same way as
 * {@link settingsBody}.
 * @param flags - The parsed flags.
 * @returns The body, or null when nothing was asked to change.
 * @throws {Error} For a bad number or yes/no.
 */
export function managerSettingsBody(
  flags: SettingsFlags,
): Record<string, number | boolean | null> | null {
  const body: Record<string, number | boolean | null> = {};
  if (flags.maxParallelDispatch !== undefined) {
    const n = Number(flags.maxParallelDispatch);
    if (!Number.isInteger(n) || n < 1) {
      throw new Error("--max-parallel-dispatch is a whole number, at least 1.");
    }
    body.maxParallelDispatch = n;
  }
  if (flags.managerCanComplete !== undefined) {
    const v = flags.managerCanComplete.trim().toLowerCase();
    if (!["yes", "no", "true", "false"].includes(v)) {
      throw new Error("--manager-can-complete is yes or no.");
    }
    body.canCompleteIssues = v === "yes" || v === "true";
  }
  for (const key of listOption(flags.reset) ?? []) {
    if ((MANAGER_SETTING_KEYS as readonly string[]).includes(key)) {
      body[key] = null;
    }
  }
  return Object.keys(body).length > 0 ? body : null;
}

/**
 * Which labels and team keys a rule names that the workspace does not have.
 * Labels compare case-insensitively (as routing matches them); team keys
 * exactly, case-insensitively too.
 * @param match - The rule's match.
 * @param catalog - The workspace's teams and labels.
 * @returns A sentence per unknown kind; empty when all are known.
 */
export function unknownCatalogNames(
  match: RoutingMatch,
  catalog: { teams: { key: string }[]; labels: { name: string }[] },
): string[] {
  const problems: string[] = [];
  const labels = new Set(catalog.labels.map((l) => l.name.toLowerCase()));
  const teams = new Set(catalog.teams.map((t) => t.key.toLowerCase()));
  const badLabels = (match.labels ?? []).filter(
    (l) => !labels.has(l.toLowerCase()),
  );
  const badTeams = (match.teamKeys ?? []).filter(
    (t) => !teams.has(t.toLowerCase()),
  );
  if (badLabels.length > 0) {
    problems.push(`No label named ${badLabels.join(", ")} in the workspace.`);
  }
  if (badTeams.length > 0) {
    problems.push(`No team with key ${badTeams.join(", ")} in the workspace.`);
  }
  return problems;
}

/**
 * Check a rule's labels and team keys against the connected workspace. A
 * project with no working Linear connection cannot be checked; that is said
 * on stderr and the rule is sent as written.
 * @param client - A signed-in client.
 * @param projectId - The project.
 * @param match - The rule's match.
 * @throws {Error} When a label or team key is not in the workspace.
 */
async function checkAgainstCatalog(
  client: ApiClient,
  projectId: number,
  match: RoutingMatch,
): Promise<void> {
  if (!match.labels?.length && !match.teamKeys?.length) return;
  let catalog: { teams: { key: string }[]; labels: { name: string }[] };
  try {
    catalog = await client.request("GET", "/integration/catalog", {
      query: { projectId, type: "linear" },
    });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      process.stderr.write(
        "Note: this project has no working Linear connection, so labels and team keys were not checked.\n",
      );
      return;
    }
    throw error;
  }
  const problems = unknownCatalogNames(match, catalog);
  if (problems.length > 0) throw new Error(problems.join(" "));
}

/**
 * Add the rule flags `add` and `edit` share.
 * @param command - The command.
 * @returns The same command.
 */
function withRuleFlags(command: Command): Command {
  return command
    .option("--name <name>", "the rule's name, shown when it decides")
    .option("--role <role>", "manager or worker")
    .option(
      "--label <labels>",
      "match issues with any of these labels (repeatable, comma-separated)",
      collect,
    )
    .option(
      "--team <keys>",
      "match issues in these teams, by key (repeatable, comma-separated)",
      collect,
    )
    .option(
      "--linear-project <ids>",
      "match issues in these Linear projects, by id (repeatable, comma-separated)",
      collect,
    )
    .option(
      "--prefix <token>",
      "match a mention starting with this, e.g. /manage",
    )
    .option("--has-parent", "match only sub-issues")
    .option("--no-parent", "match only issues that are not sub-issues")
    .option(
      "--project-has-content",
      "match only issues in a project whose content (PRD) is written",
    )
    .option(
      "--project-empty",
      "match only issues in a project with no content yet",
    )
    .option("--origin <origin>", "match delegation or mention")
    .option(
      "--repository <repo>",
      "pin the repository (hostname/owner/name or a git remote)",
    );
}

/**
 * The parsed rule flags, with `--has-parent` / `--no-parent` folded into one.
 * @param command - The command.
 * @returns The flags.
 */
function ruleFlags(command: Command): RuleFlags & {
  disabled?: boolean;
  enable?: boolean;
  disable?: boolean;
  clearRepository?: boolean;
} {
  const raw = command.opts() as Record<string, unknown>;
  const source = (key: string) => command.getOptionValueSource(key);
  let hasParent: boolean | undefined;
  if (raw.hasParent === true) hasParent = true;
  // commander's `--no-parent` sets `parent` false (and defaults it to true).
  if (source("parent") === "cli" && raw.parent === false) {
    if (hasParent)
      throw new Error("Pass --has-parent or --no-parent, not both.");
    hasParent = false;
  }
  if (raw.projectHasContent && raw.projectEmpty) {
    throw new Error("Pass --project-has-content or --project-empty, not both.");
  }
  const projectHasContent = raw.projectHasContent
    ? true
    : raw.projectEmpty
      ? false
      : undefined;
  return {
    name: raw.name as string | undefined,
    role: raw.role as string | undefined,
    label: raw.label as string[] | undefined,
    team: raw.team as string[] | undefined,
    project: raw.linearProject as string[] | undefined,
    prefix: raw.prefix as string | undefined,
    hasParent,
    projectHasContent,
    origin: raw.origin as string | undefined,
    repository: raw.repository as string | undefined,
    disabled: raw.disabled as boolean | undefined,
    enable: raw.enable as boolean | undefined,
    disable: raw.disable as boolean | undefined,
    clearRepository: raw.clearRepository as boolean | undefined,
  };
}

/**
 * Check a `--role` value.
 * @param role - What was given.
 * @returns The role.
 * @throws {Error} For anything but manager or worker.
 */
function checkRole(role: string): "manager" | "worker" {
  if (role !== "manager" && role !== "worker") {
    throw new Error("--role is manager or worker.");
  }
  return role;
}

/** One runner in a routing preview, as `routing-rule:preview` judges it. */
export interface PreviewCandidate {
  runnerId: number;
  name: string;
  owner: { id: number; name: string } | null;
  eligible: boolean;
  reasons: { code: string; message: string }[];
}

/** `routing-rule:preview`'s answer. */
export interface RoutingPreview {
  issue: {
    id: string;
    identifier: string | null;
    title: string | null;
    url: string | null;
    teamKey: string | null;
    labels: string[];
    project: { id: string; name: string } | null;
  };
  origin: "delegation" | "mention";
  matchedRuleId: number | null;
  matchedRuleName: string | null;
  role: "manager" | "worker";
  candidates: PreviewCandidate[];
  /** Why nothing could take it now, or null when a runner could. */
  waitingCode: string | null;
  repository: {
    candidates: string[];
    repository: string | null;
    pinnedByRule: boolean;
    suggestion: { repository: string; confidence: number } | null;
    wouldElicit: boolean | null;
    waitsForRepository: boolean;
    askedLinear: boolean;
  };
}

/**
 * The repository line of a preview, in words.
 * @param r - The preview's repository block.
 * @returns One sentence.
 */
export function previewRepositoryLine(r: RoutingPreview["repository"]): string {
  if (r.repository) {
    const why = r.pinnedByRule
      ? "pinned by the rule"
      : r.suggestion?.repository === r.repository
        ? `Linear's suggestion, ${Math.round(r.suggestion.confidence * 100)}% confident`
        : "the only candidate";
    return `${r.repository} (${why})`;
  }
  if (r.waitsForRepository) {
    return "none yet: no eligible runner has a repository checked out, so the work would wait";
  }
  if (r.wouldElicit === true) {
    return `Linear is unsure; the person would be asked to pick: ${r.candidates.join(", ")}`;
  }
  if (r.wouldElicit === null) {
    return `one of ${r.candidates.join(", ")} (pass --with-repository to ask Linear which)`;
  }
  return "none needed";
}

/**
 * The human rendering of a routing preview.
 * @param p - The preview.
 * @returns Lines for stdout.
 */
export function describePreview(p: RoutingPreview): string {
  const rule = p.matchedRuleId
    ? `rule #${p.matchedRuleId} ${p.matchedRuleName ?? ""}`.trim()
    : "no rule matched (the default)";
  const lines = [
    `${p.issue.identifier ?? p.issue.id}  ${p.issue.title ?? ""}`.trim(),
    `as         ${p.origin}`,
    `matched    ${rule}`,
    `role       ${p.role}`,
    `repository ${previewRepositoryLine(p.repository)}`,
  ];
  if (p.waitingCode) lines.push(`would wait ${p.waitingCode}`);
  lines.push("");
  lines.push(
    p.candidates.length === 0
      ? "No runners in this project."
      : table(
          p.candidates.map((c) => ({
            id: c.runnerId,
            runner: c.name,
            owner: c.owner?.name ?? "-",
            eligible: c.eligible ? "yes" : "no",
            reasons: c.reasons.map((r) => r.code).join(", ") || "-",
          })),
          [
            { key: "id" },
            { key: "runner" },
            { key: "owner" },
            { key: "eligible" },
            { key: "reasons", maxWidth: 70 },
          ],
        ),
  );
  return lines.join("\n");
}

/**
 * Register `routing list|add|edit|remove|reorder|preview|settings`.
 * @param program - The root program.
 */
export function registerRoutingCommands(program: Command): void {
  const routing = program
    .command("routing")
    .description(
      "The selected project's routing rules (which role answers a session) and routing settings",
    );

  withPaging(
    routing
      .command("list")
      .description("List routing rules in the order they are evaluated"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const projectId = await ctx.projectId();
      const result = await ctx.signedInClient().request<{
        routingRules: RoutingRule[];
        pagination: Pagination;
      }>("GET", "/routing-rules", {
        query: { projectId, ...pageQuery(this) },
      });
      emit(
        ctx,
        result,
        () =>
          describeRules(result.routingRules) + pageFooter(result.pagination),
      );
    });
  });

  withRuleFlags(
    routing
      .command("add")
      .description("Add a rule at the end of the list (admin)")
      .option("--disabled", "add it disabled"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const flags = ruleFlags(this);
      if (!flags.name) throw new Error("--name is required.");
      if (!flags.role) throw new Error("--role is required.");
      const role = checkRole(flags.role);
      const match = matchFromFlags(flags);
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      await checkAgainstCatalog(client, projectId, match);
      const result = await client.request<{ routingRule: RoutingRule }>(
        "PUT",
        "/routing-rule",
        {
          body: {
            projectId,
            name: flags.name,
            role,
            match,
            repository: flags.repository,
            enabled: flags.disabled ? false : undefined,
          },
        },
      );
      emit(
        ctx,
        result,
        () =>
          `Added rule "${result.routingRule.name}" (#${result.routingRule.id}) at position ${result.routingRule.position + 1}: ${describeMatch(result.routingRule.match)} → ${result.routingRule.role}.`,
      );
    });
  });

  withRuleFlags(
    routing
      .command("edit <id>")
      .description(
        "Change a rule; any match flag replaces the whole match (admin)",
      )
      .option("--enable", "evaluate the rule")
      .option("--disable", "skip the rule")
      .option("--clear-repository", "remove the pinned repository"),
  ).action(async function (this: Command, id: string) {
    await runCommand(this, async (ctx) => {
      const flags = ruleFlags(this);
      if (flags.enable && flags.disable) {
        throw new Error("Pass --enable or --disable, not both.");
      }
      if (flags.clearRepository && flags.repository) {
        throw new Error("Pass --repository or --clear-repository, not both.");
      }
      const match = hasMatchFlags(flags) ? matchFromFlags(flags) : undefined;
      const body = {
        name: flags.name,
        role: flags.role ? checkRole(flags.role) : undefined,
        match,
        repository: flags.clearRepository ? null : flags.repository,
        enabled: flags.enable ? true : flags.disable ? false : undefined,
      };
      if (Object.values(body).every((v) => v === undefined)) {
        throw new Error("Nothing to change.");
      }
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      if (match) await checkAgainstCatalog(client, projectId, match);
      const result = await client.request<{ routingRule: RoutingRule }>(
        "POST",
        `/routing-rule/${encodeURIComponent(id)}`,
        { body: { projectId, ...body } },
      );
      const r = result.routingRule;
      emit(
        ctx,
        result,
        () =>
          `Rule "${r.name}" (#${r.id}): ${describeMatch(r.match)} → ${r.role}${r.enabled ? "" : " (disabled)"}.`,
      );
    });
  });

  routing
    .command("remove <id>")
    .description("Delete a rule; the rules after it move up (admin)")
    .action(async function (this: Command, id: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<{ success: boolean }>(
            "DELETE",
            `/routing-rule/${encodeURIComponent(id)}`,
            { body: { projectId } },
          );
        emit(ctx, result, () => `Removed rule #${id}.`);
      });
    });

  routing
    .command("reorder <ids...>")
    .description(
      "Set the evaluation order: every rule id, first evaluated first (admin)",
    )
    .action(async function (this: Command, ids: string[]) {
      await runCommand(this, async (ctx) => {
        const order = ids.flatMap((v) => v.split(",")).filter(Boolean);
        if (order.some((v) => !/^\d+$/.test(v))) {
          throw new Error("Rule ids are numbers.");
        }
        const projectId = await ctx.projectId();
        const result = await ctx.signedInClient().request<{
          routingRules: RoutingRule[];
        }>("POST", "/routing-rules/order", {
          body: { projectId, ids: order.map(Number) },
        });
        emit(ctx, result, () => describeRules(result.routingRules));
      });
    });

  routing
    .command("preview <issue>")
    .description(
      "Show how an issue would be routed if it were delegated now: the rule, the role, and why each runner could or could not take it",
    )
    .option(
      "--prompt <text>",
      'route as a mention with this text, e.g. "/manage plan the launch"',
    )
    .option(
      "--with-repository",
      "also ask Linear to rank the candidate repositories (spends Linear API budget)",
    )
    .action(async function (this: Command, issue: string) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as {
          prompt?: string;
          withRepository?: boolean;
        };
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<{ preview: RoutingPreview }>(
            "GET",
            "/routing-rule/preview",
            {
              query: {
                projectId,
                issue,
                prompt: opts.prompt,
                withRepository: opts.withRepository ? "true" : undefined,
              },
            },
          );
        emit(ctx, result, () => describePreview(result.preview));
      });
    });

  routing
    .command("settings")
    .description(
      "Show the routing timers and thresholds and the manager settings, or change them (admin)",
    )
    .option(
      "--queue-timeout <duration>",
      "expire work no runner takes (e.g. 30m)",
    )
    .option(
      "--sticky-timeout <duration>",
      "how long a follow-up waits for its session's runner (0 never waits)",
    )
    .option("--offer-ttl <duration>", "how long an offer stands (e.g. 10s)")
    .option(
      "--stop-grace <duration>",
      "how long a stopped runner has to confirm (e.g. 30s)",
    )
    .option(
      "--repository-confidence <n>",
      "Linear's confidence needed to pick a repository without asking (0-1)",
    )
    .option(
      "--max-review-rounds <n>",
      "how many review rounds a manager runs on one dispatch",
    )
    .option(
      "--max-parallel-dispatch <n>",
      "how many dispatched workers one manager session may have under way",
    )
    .option(
      "--manager-can-complete <yes|no>",
      "whether a manager may move an issue to a completed or canceled state",
    )
    .option(
      "--reset <key>",
      `return a setting to its default (repeatable): ${[...ROUTING_SETTING_KEYS, ...MANAGER_SETTING_KEYS].join(", ")}`,
      collect,
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const flags = this.opts() as SettingsFlags;
        const routingBody = settingsBody(flags);
        const managerBody = managerSettingsBody(flags);
        const projectId = await ctx.projectId();
        const client = ctx.signedInClient();
        type Settings = {
          settings: { routing: RoutingSettings; manager: ManagerSettings };
        };
        const result =
          routingBody || managerBody
            ? await client.request<Settings>("POST", "/project/settings", {
                body: {
                  projectId,
                  ...(routingBody ? { routing: routingBody } : {}),
                  ...(managerBody ? { manager: managerBody } : {}),
                },
              })
            : await client.request<Settings>("GET", "/project/settings", {
                query: { projectId },
              });
        const { routing: r, manager } = result.settings;
        emit(ctx, { routing: r, manager }, () =>
          describeRoutingSettings(r, manager),
        );
      });
    });
}
