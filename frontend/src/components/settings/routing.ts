/**
 * The routing section's pure half: turning a rule's match into words, a
 * form's fields into a match, and a move into a new order. No JSX, so it is
 * asserted without a render harness.
 */

/** What a rule matches, as `routing-rule:*` serializes it. */
export interface RoutingMatch {
  labels?: string[];
  teamKeys?: string[];
  projectIds?: string[];
  promptPrefix?: string;
  hasParent?: boolean;
  origin?: "delegation" | "mention";
}

/** The rule form's fields, all strings so inputs bind to them directly. */
export interface RuleDraft {
  name: string;
  role: "manager" | "worker";
  labels: string;
  teamKeys: string;
  projectIds: string;
  promptPrefix: string;
  /** `""` (any), `"true"`, or `"false"`. */
  hasParent: string;
  /** `""` (any), `"delegation"`, or `"mention"`. */
  origin: string;
  repository: string;
  enabled: boolean;
}

/** An empty form. */
export const EMPTY_RULE_DRAFT: RuleDraft = {
  name: "",
  role: "worker",
  labels: "",
  teamKeys: "",
  projectIds: "",
  promptPrefix: "",
  hasParent: "",
  origin: "",
  repository: "",
  enabled: true,
};

/**
 * Split a comma-separated field into its trimmed, non-empty values.
 * @param value - What was typed.
 * @returns The values.
 */
export function splitList(value: string): string[] {
  return value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/**
 * The match a form describes: only the fields that were filled in, since an
 * absent field matches anything.
 * @param draft - The form.
 * @returns The match to send.
 */
export function matchFromDraft(draft: RuleDraft): RoutingMatch {
  const match: RoutingMatch = {};
  const labels = splitList(draft.labels);
  const teamKeys = splitList(draft.teamKeys);
  const projectIds = splitList(draft.projectIds);
  if (labels.length > 0) match.labels = labels;
  if (teamKeys.length > 0) match.teamKeys = teamKeys;
  if (projectIds.length > 0) match.projectIds = projectIds;
  if (draft.promptPrefix.trim()) match.promptPrefix = draft.promptPrefix.trim();
  if (draft.hasParent === "true") match.hasParent = true;
  if (draft.hasParent === "false") match.hasParent = false;
  if (draft.origin === "delegation" || draft.origin === "mention") {
    match.origin = draft.origin;
  }
  return match;
}

/**
 * The form for an existing rule.
 * @param rule - The rule as listed.
 * @returns Its draft.
 */
export function draftFromRule(rule: {
  name: string;
  role: "manager" | "worker";
  match: RoutingMatch;
  repository: string | null;
  enabled: boolean;
}): RuleDraft {
  const m = rule.match;
  return {
    name: rule.name,
    role: rule.role,
    labels: (m.labels ?? []).join(", "),
    teamKeys: (m.teamKeys ?? []).join(", "),
    projectIds: (m.projectIds ?? []).join(", "),
    promptPrefix: m.promptPrefix ?? "",
    hasParent: m.hasParent === undefined ? "" : String(m.hasParent),
    origin: m.origin ?? "",
    repository: rule.repository ?? "",
    enabled: rule.enabled,
  };
}

/**
 * One line saying what a rule matches.
 * @param match - The match.
 * @returns E.g. `starts with /manage · label PRD or spec`, or `every session`.
 */
export function describeMatch(match: RoutingMatch): string {
  const parts: string[] = [];
  if (match.promptPrefix) parts.push(`starts with ${match.promptPrefix}`);
  if (match.labels?.length) {
    parts.push(
      `${match.labels.length === 1 ? "label" : "labels"} ${match.labels.join(" or ")}`,
    );
  }
  if (match.teamKeys?.length) {
    parts.push(`team ${match.teamKeys.join(" or ")}`);
  }
  if (match.projectIds?.length) {
    parts.push(
      `${match.projectIds.length === 1 ? "project" : "projects"} ${match.projectIds.join(" or ")}`,
    );
  }
  if (match.hasParent === true) parts.push("sub-issues");
  if (match.hasParent === false) parts.push("top-level issues");
  if (match.origin) parts.push(`by ${match.origin}`);
  return parts.length > 0 ? parts.join(" · ") : "every session";
}

/**
 * The order after moving one rule up or down a place.
 * @param ids - The rule ids in their current order.
 * @param id - The rule to move.
 * @param direction - `-1` for up, `1` for down.
 * @returns The new order, or the same one when the move would leave the list.
 */
export function moveRule(
  ids: readonly number[],
  id: number,
  direction: -1 | 1,
): number[] {
  const order = [...ids];
  const from = order.indexOf(id);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= order.length) return order;
  [order[from], order[to]] = [order[to], order[from]];
  return order;
}

/** The routing timers as the form edits them: minutes, seconds, a fraction. */
export interface TimerDraft {
  queueTimeoutMinutes: string;
  stickyTimeoutMinutes: string;
  offerTtlSeconds: string;
  stopGraceSeconds: string;
  repositoryConfidence: string;
}

/** The routing settings `project:settings-view` answers, resolved. */
export interface RoutingSettings {
  queueTimeoutMs: number;
  stickyTimeoutMs: number;
  offerTtlMs: number;
  repositoryConfidence: number;
  stopGraceMs: number;
}

/**
 * The timer form for a project's settings.
 * @param routing - The resolved settings.
 * @returns The draft.
 */
export function timersFromSettings(routing: RoutingSettings): TimerDraft {
  return {
    queueTimeoutMinutes: String(routing.queueTimeoutMs / 60_000),
    stickyTimeoutMinutes: String(routing.stickyTimeoutMs / 60_000),
    offerTtlSeconds: String(routing.offerTtlMs / 1000),
    stopGraceSeconds: String(routing.stopGraceMs / 1000),
    repositoryConfidence: String(routing.repositoryConfidence),
  };
}

/**
 * The `routing` body a timer form sends, or a message saying what is wrong
 * with it. The server re-checks every bound.
 * @param draft - The form.
 * @returns The settings in ms, or an error.
 */
export function settingsFromTimers(
  draft: TimerDraft,
): { routing: RoutingSettings } | { error: string } {
  const num = (v: string) => (v.trim() === "" ? Number.NaN : Number(v));
  const routing: RoutingSettings = {
    queueTimeoutMs: Math.round(num(draft.queueTimeoutMinutes) * 60_000),
    stickyTimeoutMs: Math.round(num(draft.stickyTimeoutMinutes) * 60_000),
    offerTtlMs: Math.round(num(draft.offerTtlSeconds) * 1000),
    stopGraceMs: Math.round(num(draft.stopGraceSeconds) * 1000),
    repositoryConfidence: num(draft.repositoryConfidence),
  };
  for (const [key, value] of Object.entries(routing)) {
    if (!Number.isFinite(value) || value < 0) {
      return { error: `${key} must be a non-negative number.` };
    }
  }
  if (routing.repositoryConfidence > 1) {
    return { error: "Repository confidence is between 0 and 1." };
  }
  return { routing };
}
