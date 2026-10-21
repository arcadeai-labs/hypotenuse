import { normalizeRemote } from "@hypotenuse/protocol";
import { and, asc, eq, sql } from "drizzle-orm";
import { api, ErrorType, TypedError } from "keryx";
import { z } from "zod";
import type {
  AgentSessionRole,
  IssueSnapshot,
  RepositoryChoiceOption,
} from "../schema/agent_sessions";
import {
  type RoutingMatch,
  type RoutingRule,
  routingRules,
} from "../schema/routing_rules";
import type { TxHandle } from "./ProjectOps";

/**
 * Work routing's decisions, each by the cheapest source that can make it:
 *
 * 1. **Which role** — a project's ordered rules over facts on the issue and
 *    the prompt ({@link selectRole}); the default is worker.
 * 2. **Which repository** — bounded by what eligible runners have checked
 *    out, ranked by Linear, asked of a person only when Linear is unsure
 *    ({@link repositoryOptions}, {@link parseRepositoryAnswer}).
 * 3. **Which runners could** — one SQL query ({@link eligibleRunners}).
 * 4. **Which one** — the session's own, then the issuer's, then the
 *    least-loaded ({@link rankRunners}).
 */

/** Every DB handle routing reads through. */
type Db = TxHandle | typeof api.db.db;

/**
 * A `text[]` of bound parameters (an empty one for no values).
 * @param values - The strings.
 * @returns The SQL fragment.
 */
function textArray(values: string[]) {
  return values.length === 0
    ? sql`ARRAY[]::text[]`
    : sql`ARRAY[${sql.join(
        values.map((v) => sql`${v}`),
        sql`, `,
      )}]::text[]`;
}

/** A role prefix: a slash and a word, the way a person types `/manage`. */
const promptPrefixInput = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^\/[A-Za-z0-9][A-Za-z0-9_-]*$/, "a slash and a word, e.g. /manage");

/** A list of match values. */
const values = z.array(z.string().trim().min(1).max(255)).min(1).max(50);

/**
 * What a routing rule matches, as an admin writes it. Every present field
 * must match; absent fields match anything.
 */
export const RoutingMatchInput = z.strictObject({
  labels: values
    .optional()
    .describe("The issue carries any of these labels (case-insensitive)"),
  teamKeys: values.optional().describe("The issue's team key is one of these"),
  projectIds: values
    .optional()
    .describe("The issue is in one of these Linear projects (ids)"),
  promptPrefix: promptPrefixInput
    .optional()
    .describe("The mention's text starts with this token, e.g. /manage"),
  hasParent: z
    .boolean()
    .optional()
    .describe("The issue is (true) or is not (false) a sub-issue"),
  origin: z
    .enum(["delegation", "mention"])
    .optional()
    .describe("How the session started"),
});

/** A repository a rule may pin, normalized to `hostname/owner/name`. */
export const pinnedRepositoryInput = z
  .string()
  .trim()
  .min(3)
  .max(512)
  .transform((value) => normalizeRemote(value))
  .refine((value) => /^[^/]+\/[^/]+\/[^/]+/.test(value), {
    message: "A repository is hostname/owner/name, or a git remote",
  });

/** The two rules every project starts with when it connects Linear. */
export const SEEDED_RULES: {
  name: string;
  match: RoutingMatch;
  role: AgentSessionRole;
}[] = [
  { name: "/manage", match: { promptPrefix: "/manage" }, role: "manager" },
  { name: "/work", match: { promptPrefix: "/work" }, role: "worker" },
];

/**
 * Insert the seeded rules for a project that has no rules at all. A project
 * whose admin deleted them on purpose and reconnects keeps its list.
 * @param tx - The transaction.
 * @param projectId - The project.
 * @returns The rules inserted (none when the project already had some).
 */
export async function seedRoutingRules(
  tx: TxHandle,
  projectId: number,
): Promise<RoutingRule[]> {
  const [existing] = await tx
    .select({ id: routingRules.id })
    .from(routingRules)
    .where(eq(routingRules.projectId, projectId))
    .limit(1);
  if (existing) return [];
  return tx
    .insert(routingRules)
    .values(
      SEEDED_RULES.map((rule, position) => ({
        projectId,
        position,
        name: rule.name,
        match: rule.match,
        role: rule.role,
      })),
    )
    .returning();
}

/**
 * A project's rules in evaluation order.
 * @param db - Where to read.
 * @param projectId - The project.
 * @returns Every rule, enabled or not, by position.
 */
export async function listRoutingRules(
  db: Db,
  projectId: number,
): Promise<RoutingRule[]> {
  return db
    .select()
    .from(routingRules)
    .where(eq(routingRules.projectId, projectId))
    .orderBy(asc(routingRules.position), asc(routingRules.id));
}

/**
 * Shape a rule for the API.
 * @param rule - The row.
 * @returns The serialized rule, timestamps as epoch ms.
 */
export function serializeRoutingRule(rule: RoutingRule) {
  return {
    id: rule.id,
    projectId: rule.projectId,
    position: rule.position,
    name: rule.name,
    enabled: rule.enabled,
    match: rule.match,
    role: rule.role,
    repository: rule.repository,
    createdAt: rule.createdAt.getTime(),
    updatedAt: rule.updatedAt.getTime(),
  };
}

/** {@link serializeRoutingRule}'s output. */
export type SerializedRoutingRule = ReturnType<typeof serializeRoutingRule>;

/** The facts a rule is matched against. */
export interface RoutingFacts {
  labels: string[];
  teamKey: string | null;
  projectId: string | null;
  hasParent: boolean;
  origin: "delegation" | "mention" | "proactive";
  /** The mention's text; null for a delegation, which has no prompt. */
  text: string | null;
}

/**
 * The facts of an issue snapshot, for {@link selectRole}.
 * @param issue - What routing read about the issue.
 * @param origin - How the session started.
 * @param text - The triggering text, if any.
 * @returns The facts.
 */
export function routingFacts(
  issue: IssueSnapshot,
  origin: RoutingFacts["origin"],
  text: string | null,
): RoutingFacts {
  return {
    labels: issue.labels,
    teamKey: issue.teamKey,
    projectId: issue.project?.id ?? null,
    hasParent: issue.parent !== null,
    origin,
    text,
  };
}

/**
 * Whether a text starts with a prefix as a whole token: `/manage` matches
 * `/manage the rollout` and `/MANAGE`, not `/manager`.
 * @param text - The text.
 * @param prefix - The prefix.
 * @returns True when it does.
 */
export function startsWithPrefix(text: string, prefix: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.length < prefix.length) return false;
  if (trimmed.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()) {
    return false;
  }
  const next = trimmed.charAt(prefix.length);
  return next === "" || /\s/.test(next);
}

/**
 * The text with a matched prefix removed.
 * @param text - The text.
 * @param prefix - The prefix it starts with.
 * @returns What follows it, trimmed.
 */
export function stripPrefix(text: string, prefix: string): string {
  return text.trimStart().slice(prefix.length).trim();
}

/**
 * Whether one rule matches the facts. Every present field must match.
 * @param match - The rule's match.
 * @param facts - The facts.
 * @returns True when it matches.
 */
export function ruleMatches(match: RoutingMatch, facts: RoutingFacts): boolean {
  if (match.labels && match.labels.length > 0) {
    const have = new Set(facts.labels.map((l) => l.toLowerCase()));
    if (!match.labels.some((l) => have.has(l.toLowerCase()))) return false;
  }
  if (match.teamKeys && match.teamKeys.length > 0) {
    const keys = match.teamKeys.map((k) => k.toLowerCase());
    if (!facts.teamKey || !keys.includes(facts.teamKey.toLowerCase())) {
      return false;
    }
  }
  if (match.projectIds && match.projectIds.length > 0) {
    if (!facts.projectId || !match.projectIds.includes(facts.projectId)) {
      return false;
    }
  }
  if (match.promptPrefix !== undefined) {
    if (!facts.text || !startsWithPrefix(facts.text, match.promptPrefix)) {
      return false;
    }
  }
  if (match.hasParent !== undefined && match.hasParent !== facts.hasParent) {
    return false;
  }
  if (match.origin !== undefined && match.origin !== facts.origin) {
    return false;
  }
  return true;
}

/** What {@link selectRole} decided. */
export interface RoleDecision {
  role: AgentSessionRole;
  /** The rule that decided, or null for the fallthrough. */
  rule: RoutingRule | null;
  /** The triggering text with a matched prefix stripped. */
  text: string | null;
}

/**
 * Choose the role for a new session: the first enabled rule, in position
 * order, whose match holds; otherwise `worker`. A matched prefix is stripped
 * from the text before it reaches the agent.
 * @param rules - The project's rules, in order.
 * @param facts - The facts.
 * @returns The decision.
 */
export function selectRole(
  rules: RoutingRule[],
  facts: RoutingFacts,
): RoleDecision {
  for (const rule of rules) {
    if (!rule.enabled || !ruleMatches(rule.match, facts)) continue;
    const text =
      rule.match.promptPrefix && facts.text
        ? stripPrefix(facts.text, rule.match.promptPrefix)
        : facts.text;
    return { role: rule.role, rule, text };
  }
  return { role: "worker", rule: null, text: facts.text };
}

/**
 * The thought that names the decision, so a person who wanted the other role
 * can see why without opening Hypotenuse.
 * @param decision - What {@link selectRole} decided.
 * @returns The thought's body.
 */
export function roleThought(decision: RoleDecision): string {
  return decision.rule
    ? `Routing as **${decision.role}** (rule: ${decision.rule.name}).`
    : `Routing as **${decision.role}** (no rule matched; worker is the default).`;
}

/**
 * The enabled rule whose prefix a follow-up starts with, when it names a role
 * other than the session's — a person trying to switch roles mid-session.
 * @param rules - The project's rules.
 * @param text - The follow-up.
 * @param role - The session's role.
 * @returns The rule, or null.
 */
export function roleSwitchAttempt(
  rules: RoutingRule[],
  text: string,
  role: AgentSessionRole,
): RoutingRule | null {
  return (
    rules.find(
      (rule) =>
        rule.enabled &&
        rule.role !== role &&
        rule.match.promptPrefix !== undefined &&
        startsWithPrefix(text, rule.match.promptPrefix),
    ) ?? null
  );
}

/**
 * Split a normalized remote into Linear's candidate shape.
 * @param remote - `hostname/owner/name`.
 * @returns `{ hostname, repositoryFullName }`.
 */
export function candidateRepository(remote: string): {
  hostname: string;
  repositoryFullName: string;
} {
  const slash = remote.indexOf("/");
  return {
    hostname: remote.slice(0, slash),
    repositoryFullName: remote.slice(slash + 1),
  };
}

/**
 * The option a `select` offers for a repository: `owner/name` as its label,
 * an HTTPS URL as its value (Linear renders a GitHub repository URL with
 * extra detail).
 * @param remote - `hostname/owner/name`.
 * @returns The option.
 */
export function repositoryOption(remote: string): RepositoryChoiceOption {
  const { repositoryFullName } = candidateRepository(remote);
  return {
    label: repositoryFullName,
    value: `https://${remote}`,
    remote,
  };
}

/**
 * Normalize an answer or an option for comparison: no scheme, no `.git`, no
 * slashes at either end, lowercase.
 * @param text - The text.
 * @returns The comparable form.
 */
function comparable(text: string): string {
  return text
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+/, "")
    .toLowerCase();
}

/**
 * Escape a string for a regular expression.
 * @param text - The text.
 * @returns The escaped text.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Which repository a person meant, from the prompt that answered a `select`.
 * Accepts, in order: an exact match on an option's value, label, remote, or
 * `owner/name` (case-insensitive; a scheme, a trailing `.git`, and slashes are
 * ignored); then exactly one option whose `owner/name` or `name` appears as a
 * word in the text. Anything else is no match — a wrong guess costs a whole
 * turn in the wrong codebase, so there is no fuzzier fallback.
 * @param body - The person's answer.
 * @param options - What the `select` offered.
 * @returns The chosen option, or null.
 */
export function parseRepositoryAnswer(
  body: string,
  options: RepositoryChoiceOption[],
): RepositoryChoiceOption | null {
  const answer = comparable(body);
  if (!answer) return null;
  const exact = options.find((option) =>
    [option.value, option.label, option.remote].some(
      (candidate) => comparable(candidate) === answer,
    ),
  );
  if (exact) return exact;

  const text = body.toLowerCase();
  const word = (needle: string) =>
    new RegExp(
      `(^|[^a-z0-9_.-])${escapeRegExp(needle.toLowerCase())}($|[^a-z0-9_-])`,
    ).test(text);
  const mentioned = options.filter((option) => {
    const name = option.label.split("/").pop() ?? option.label;
    return word(option.label) || word(name);
  });
  return mentioned.length === 1 ? mentioned[0] : null;
}

/** What eligibility is asked about. */
export interface EligibilityQuery {
  projectId: number;
  role: AgentSessionRole;
  /**
   * `hostname/owner/name` the runner must have; `null` for none needed;
   * `undefined` to ignore repositories (when choosing one).
   */
  repository: string | null | undefined;
  issue: Pick<IssueSnapshot, "teamKey" | "labels" | "project">;
}

/** A runner that could take a work item now. */
export interface EligibleRunner {
  id: number;
  userId: number;
  name: string;
  /** The runner's agent for the role. */
  agentId: string;
  /** Live items it holds or has been offered. */
  used: number;
  maxParallelJobs: number;
  /** When it last claimed anything, epoch ms, or null. */
  lastClaimedAt: number | null;
  /** Its repositories' remotes. */
  remotes: string[];
}

/**
 * The SQL fragment that counts a runner's live work items, optionally
 * narrowed (to a role or an agent). An offered item counts against the runner
 * it is offered to; a claimed or running one against the runner holding it.
 * @param narrow - An extra condition on `w`.
 * @returns The scalar subquery.
 */
function liveCount(narrow = sql`TRUE`) {
  return sql`(SELECT count(*)::int FROM work_items w WHERE ${narrow} AND (
      (w.status = 'offered' AND w.offered_to_runner_id = r.id)
      OR (w.status IN ('claimed', 'running') AND w.runner_id = r.id)))`;
}

/**
 * Every runner that could take a work item now — **one query**, not a loop:
 *
 * - in the project, `online`, enabled;
 * - plays the role, and has an available agent that plays it;
 * - has the repository (unless none is needed, or it is being chosen);
 * - for each subscription kind (team, project, label), has no rows of that
 *   kind or one that matches;
 * - has room at all three levels — the machine, the role, and the agent —
 *   counted here over live work items, never from the heartbeat's
 *   `activeCount`, which lags by up to a beat.
 * @param db - Where to read (a transaction, to see its own writes).
 * @param query - What is being placed.
 * @returns The eligible runners, unordered.
 */
export async function eligibleRunners(
  db: Db,
  query: EligibilityQuery,
): Promise<EligibleRunner[]> {
  const labels = query.issue.labels.map((l) => l.toLowerCase());
  const repositoryCondition =
    query.repository === undefined || query.repository === null
      ? sql`TRUE`
      : sql`r.repositories @> ${JSON.stringify([{ remote: query.repository }])}::jsonb`;
  const subscription = (kind: string, matches: ReturnType<typeof sql>) => sql`(
      NOT EXISTS (SELECT 1 FROM runner_subscriptions s WHERE s.runner_id = r.id AND s.kind = ${kind})
      OR EXISTS (SELECT 1 FROM runner_subscriptions s WHERE s.runner_id = r.id AND s.kind = ${kind} AND ${matches}))`;
  const teamKey = query.issue.teamKey ?? "";
  const projectId = query.issue.project?.id ?? "";

  const result = await db.execute<{
    id: number;
    user_id: number;
    name: string;
    agent_id: string;
    used: number;
    max_parallel: number;
    last_claimed_at: Date | string | null;
    remotes: string[] | null;
  }>(sql`
    SELECT * FROM (
      SELECT r.id, r.user_id, r.name, r.limits, agent.id AS agent_id,
        (r.limits->>'maxParallelJobs')::int AS max_parallel,
        ${liveCount()} AS used,
        ${liveCount(sql`w.role = ${query.role}`)} AS used_role,
        ${liveCount(sql`w.agent_id = agent.id`)} AS used_agent,
        (SELECT max(w.claimed_at) FROM work_items w WHERE w.runner_id = r.id) AS last_claimed_at,
        (SELECT coalesce(jsonb_agg(repo->>'remote'), '[]'::jsonb) FROM jsonb_array_elements(r.repositories) repo) AS remotes
      FROM runners r
      CROSS JOIN LATERAL (
        SELECT a.value->>'id' AS id
        FROM jsonb_array_elements(r.agents) WITH ORDINALITY AS a(value, ord)
        WHERE (a.value->>'available')::boolean
          AND (a.value->'roles' IS NULL OR a.value->'roles' ? ${query.role})
        ORDER BY a.ord
        LIMIT 1
      ) agent
      WHERE r.project_id = ${query.projectId}
        AND r.status = 'online'
        AND r.enabled
        AND r.limits IS NOT NULL
        AND r.roles ? ${query.role}
        AND ${repositoryCondition}
        AND ${subscription("team", sql`s.value = ${teamKey}`)}
        AND ${subscription("project", sql`s.value = ${projectId}`)}
        AND ${subscription("label", sql`s.value = ANY(${textArray(labels)})`)}
    ) c
    WHERE c.used < c.max_parallel
      AND (c.limits->'roles'->>${query.role} IS NULL OR c.used_role < (c.limits->'roles'->>${query.role})::int)
      AND (c.limits->'agents'->>c.agent_id IS NULL OR c.used_agent < (c.limits->'agents'->>c.agent_id)::int)
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    userId: Number(row.user_id),
    name: row.name,
    agentId: row.agent_id,
    used: Number(row.used),
    maxParallelJobs: Number(row.max_parallel),
    lastClaimedAt: row.last_claimed_at
      ? new Date(row.last_claimed_at).getTime()
      : null,
    remotes: row.remotes ?? [],
  }));
}

/** What ranking prefers. */
export interface RankingPreference {
  /** The runner holding the session's worktree. */
  stickyRunnerId: number | null;
  /** The issuer's Hypotenuse user. */
  preferredUserId: number | null;
}

/**
 * Order the eligible runners: the sticky runner first, always; then the
 * issuer's runners, least-loaded first; then everyone else, least-loaded
 * (lowest used / maxParallelJobs) first, ties broken by longest idle.
 * @param eligible - The eligible set.
 * @param preference - Sticky and issuer.
 * @returns A new array, best first.
 */
export function rankRunners(
  eligible: EligibleRunner[],
  preference: RankingPreference,
): EligibleRunner[] {
  const tier = (r: EligibleRunner) =>
    r.id === preference.stickyRunnerId
      ? 0
      : preference.preferredUserId !== null &&
          r.userId === preference.preferredUserId
        ? 1
        : 2;
  const load = (r: EligibleRunner) => r.used / r.maxParallelJobs;
  return [...eligible].sort(
    (a, b) =>
      tier(a) - tier(b) ||
      load(a) - load(b) ||
      (a.lastClaimedAt ?? 0) - (b.lastClaimedAt ?? 0) ||
      a.id - b.id,
  );
}

/**
 * Plural helper.
 * @param n - The count.
 * @param one - The singular noun phrase.
 * @param many - The plural noun phrase.
 * @returns `"1 runner"` or `"2 runners"`.
 */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Why nothing can take a work item, in the words the data supports: none
 * subscribed, none online, none with the repository, all full. Used in the
 * waiting thought and the queue-timeout error.
 * @param db - Where to read.
 * @param query - What could not be placed.
 * @returns One sentence.
 */
export async function explainUnplaceable(
  db: Db,
  query: EligibilityQuery,
): Promise<string> {
  const scope = query.issue.teamKey ? ` to ${query.issue.teamKey}` : "";
  const labels = query.issue.labels.map((l) => l.toLowerCase());
  const result = await db.execute<{
    subscribed: number;
    online: number;
    enabled: number;
    with_agent: number;
    with_repository: number;
  }>(sql`
    SELECT
      count(*)::int AS subscribed,
      count(*) FILTER (WHERE r.status = 'online')::int AS online,
      count(*) FILTER (WHERE r.status = 'online' AND r.enabled)::int AS enabled,
      count(*) FILTER (WHERE r.status = 'online' AND r.enabled AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(r.agents) a
        WHERE (a->>'available')::boolean AND (a->'roles' IS NULL OR a->'roles' ? ${query.role})
      ))::int AS with_agent,
      count(*) FILTER (WHERE r.status = 'online' AND r.enabled AND ${
        query.repository
          ? sql`r.repositories @> ${JSON.stringify([{ remote: query.repository }])}::jsonb`
          : query.repository === undefined
            ? sql`jsonb_array_length(r.repositories) > 0`
            : sql`TRUE`
      })::int AS with_repository
    FROM runners r
    WHERE r.project_id = ${query.projectId}
      AND r.status <> 'revoked'
      AND r.roles ? ${query.role}
      AND (NOT EXISTS (SELECT 1 FROM runner_subscriptions s WHERE s.runner_id = r.id AND s.kind = 'team')
        OR EXISTS (SELECT 1 FROM runner_subscriptions s WHERE s.runner_id = r.id AND s.kind = 'team' AND s.value = ${query.issue.teamKey ?? ""}))
      AND (NOT EXISTS (SELECT 1 FROM runner_subscriptions s WHERE s.runner_id = r.id AND s.kind = 'project')
        OR EXISTS (SELECT 1 FROM runner_subscriptions s WHERE s.runner_id = r.id AND s.kind = 'project' AND s.value = ${query.issue.project?.id ?? ""}))
      AND (NOT EXISTS (SELECT 1 FROM runner_subscriptions s WHERE s.runner_id = r.id AND s.kind = 'label')
        OR EXISTS (SELECT 1 FROM runner_subscriptions s WHERE s.runner_id = r.id AND s.kind = 'label' AND s.value = ANY(${textArray(labels)})))
  `);
  const row = result.rows[0] ?? {
    subscribed: 0,
    online: 0,
    enabled: 0,
    with_agent: 0,
    with_repository: 0,
  };
  const subscribed = Number(row.subscribed);
  const online = Number(row.online);
  const enabled = Number(row.enabled);
  const withAgent = Number(row.with_agent);
  const withRepository = Number(row.with_repository);
  const role = query.role;
  if (subscribed === 0) {
    return `No runner in this project takes ${role} work${scope}.`;
  }
  const these = `${count(subscribed, "runner takes", "runners take")} ${role} work${scope}`;
  if (online === 0) {
    return `${these}; ${subscribed === 1 ? "it is" : "all are"} offline.`;
  }
  if (enabled === 0) {
    return `${these}; ${online === 1 ? "the online one is" : "every online one is"} paused.`;
  }
  if (withAgent === 0) {
    return `${these}; none online has an available agent for the ${role} role.`;
  }
  if (withRepository === 0) {
    return query.repository
      ? `${these}; none online has ${query.repository} checked out.`
      : `${these}; none online has a repository checked out.`;
  }
  return `${these}; ${withRepository === 1 ? "the one that could is" : "all that could are"} busy.`;
}

/**
 * Normalize the repositories reported for the candidates of a choice.
 * @param eligible - Runners eligible ignoring the repository.
 * @returns The distinct remotes, sorted.
 */
export function repositoryCandidates(eligible: EligibleRunner[]): string[] {
  return [...new Set(eligible.flatMap((r) => r.remotes))].sort();
}

/** A rule's name, as an admin types it. */
export const routingRuleNameInput = z
  .string()
  .trim()
  .min(1, "A rule needs a name")
  .max(64, "A rule name is at most 64 characters");

/** A role a rule chooses. */
export const routingRoleInput = z.enum(["manager", "worker"]);

/** A boolean as JSON or a query string sends it. */
export const booleanInput = z
  .union([z.boolean(), z.enum(["true", "false"])])
  .transform((v) => v === true || v === "true");

/**
 * One rule of a project, locked, or a not-found refusal — the same refusal
 * for a rule in another project as for none.
 * @param tx - The transaction.
 * @param projectId - The project.
 * @param id - The rule.
 * @returns The rule.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function ruleInProject(
  tx: TxHandle,
  projectId: number,
  id: number,
): Promise<RoutingRule> {
  const [rule] = await tx
    .select()
    .from(routingRules)
    .where(and(eq(routingRules.id, id), eq(routingRules.projectId, projectId)))
    .for("update");
  if (!rule) {
    throw new TypedError({
      message: "Routing rule not found",
      type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
    });
  }
  return rule;
}
