/**
 * Pure helpers for a bot's prompt, its goals, and the project's skills: the
 * order sections are assembled in, how a section's loading reads, what a
 * version's source is called, review intervals, and a skill's arguments.
 * Nothing here decides who may do what — that is the server's, through
 * `can()` and each row's own standing — and nothing here calls the API.
 */

/** The key of the section that says who a bot is. It always loads and its bot never edits it. */
export const IDENTITY_KEY = "identity";

/** What every helper here needs to know about a section. */
export interface SectionShape {
  id: number;
  key: string;
  scope: string;
  loading: string;
  position: number;
  archived?: boolean;
}

/**
 * Sections in the order the prompt assembler puts them: the bot's *Identity*,
 * then the project's `always` sections, the bot's `always` sections, and the
 * contextual ones — project before bot — each group by position. Deleted
 * sections are left out.
 * @param projectSections - The project's sections.
 * @param botSections - The bot's own sections.
 * @returns One list, in assembly order.
 */
export function assemblyOrder<T extends SectionShape>(
  projectSections: readonly T[],
  botSections: readonly T[],
): T[] {
  const live = (list: readonly T[]) => list.filter((s) => !s.archived);
  const byPosition = (a: T, b: T) => a.position - b.position || a.id - b.id;
  const project = live(projectSections).sort(byPosition);
  const bot = live(botSections).sort(byPosition);
  const identity = bot.filter((s) => s.key === IDENTITY_KEY);
  const rest = bot.filter((s) => s.key !== IDENTITY_KEY);
  return [
    ...identity,
    ...project.filter((s) => s.loading === "always"),
    ...rest.filter((s) => s.loading === "always"),
    ...project.filter((s) => s.loading === "contextual"),
    ...rest.filter((s) => s.loading === "contextual"),
  ];
}

/**
 * Whether a section is the bot's *Identity*.
 * @param section - The section.
 * @returns `true` for a bot section keyed `identity`.
 */
export function isIdentity(section: Pick<SectionShape, "key" | "scope">) {
  return section.scope === "bot" && section.key === IDENTITY_KEY;
}

/** Which of a section's settings may change at all, whoever is asking. */
export interface SectionLocks {
  /** It may be made contextual. */
  canBeContextual: boolean;
  /** Its bot may be let edit it. */
  canBeAgentEditable: boolean;
  /** It may be deleted. */
  canDelete: boolean;
}

/**
 * The rules the server holds for every section, so the editor never offers
 * what would be refused: *Identity* always loads, is never its bot's to edit,
 * and is never deleted; a project section is in every bot's prompt, so no bot
 * may edit it.
 * @param section - The section.
 * @returns What may change.
 */
export function sectionLocks(
  section: Pick<SectionShape, "key" | "scope">,
): SectionLocks {
  const identity = isIdentity(section);
  return {
    canBeContextual: !identity,
    canBeAgentEditable: section.scope === "bot" && !identity,
    canDelete: !identity,
  };
}

/**
 * Read a keywords field: words split on commas and whitespace, lowercased,
 * without repeats.
 * @param text - What was typed.
 * @returns The keywords.
 */
export function parseKeywords(text: string): string[] {
  const seen = new Set<string>();
  for (const word of text.toLowerCase().split(/[\s,]+/)) {
    const w = word.trim();
    if (w) seen.add(w);
  }
  return [...seen];
}

/**
 * When a section loads, in words.
 * @param section - Its `loading` and `keywords`.
 * @returns "Always", or what brings it in.
 */
export function loadingSummary(section: {
  loading: string;
  keywords: readonly string[];
}): string {
  if (section.loading === "always") return "Always";
  return section.keywords.length > 0
    ? `When one of these comes up: ${section.keywords.join(", ")}`
    : "When a word of its title comes up";
}

/** What each source of a section version is called. */
export const VERSION_SOURCE_LABELS: Record<string, string> = {
  seed: "Created with the bot",
  person: "Written by a person",
  agent: "Written by the bot",
  revert: "Reverted by a person",
};

/**
 * Who wrote a version, in words.
 * @param source - The version's `source`.
 * @returns The label.
 */
export function versionSourceLabel(source: string): string {
  return VERSION_SOURCE_LABELS[source] ?? source;
}

/**
 * About how many tokens a text costs, as the server estimates it: four
 * characters each, rounded up.
 * @param text - The text.
 * @returns The estimate.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * How full a prompt is.
 * @param estimated - Its estimated tokens.
 * @param budget - The bot's budget.
 * @returns The percent used, capped at 100 for drawing, and whether it is over.
 */
export function budgetUsage(
  estimated: number,
  budget: number,
): { percent: number; over: boolean } {
  if (budget <= 0) return { percent: 100, over: estimated > 0 };
  return {
    percent: Math.min(100, Math.round((estimated / budget) * 100)),
    over: estimated > budget,
  };
}

/** The smallest and largest prompt budget `bot:edit` takes, in tokens. */
export const PROMPT_BUDGET_RANGE = { min: 1_000, max: 200_000 } as const;

/** The most sections a bot may be let create itself. */
export const MAX_AGENT_SECTIONS_LIMIT = 50;

/**
 * Read a whole-number field within a range.
 * @param text - What was typed.
 * @param min - The least it may be.
 * @param max - The most it may be.
 * @returns The number, or `null` when it is not a whole number in range.
 */
export function parseWhole(
  text: string,
  min: number,
  max: number,
): number | null {
  const t = text.trim().replace(/[,_\s]/g, "");
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

/** A goal's statuses, in the order the editor offers them. */
export const GOAL_STATUSES = ["active", "achieved", "dropped"] as const;

/** A goal's priorities, highest first. */
export const GOAL_PRIORITIES = ["high", "medium", "low"] as const;

/** How each goal status reads. */
export const GOAL_STATUS_LABELS: Record<string, string> = {
  active: "Active",
  achieved: "Achieved",
  dropped: "Dropped",
};

/** How each priority reads. */
export const GOAL_PRIORITY_LABELS: Record<string, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

const HOUR = 3_600;
const DAY = 86_400;

/** The review intervals the goal editor offers, in seconds; `null` is never. */
export const REVIEW_INTERVALS: readonly (number | null)[] = [
  null,
  DAY,
  7 * DAY,
  14 * DAY,
  30 * DAY,
  90 * DAY,
];

/**
 * A review interval in words.
 * @param seconds - The interval, or `null` for none.
 * @returns "Never", "Every day", "Every 7 days", "Every 3 hours", ….
 */
export function reviewIntervalLabel(seconds: number | null): string {
  if (seconds === null) return "Never";
  if (seconds % DAY === 0) {
    const days = seconds / DAY;
    return days === 1 ? "Every day" : `Every ${days} days`;
  }
  if (seconds % HOUR === 0) {
    const hours = seconds / HOUR;
    return hours === 1 ? "Every hour" : `Every ${hours} hours`;
  }
  return `Every ${Math.round(seconds / 60)} minutes`;
}

/**
 * The intervals to offer for a goal: the presets, plus its own when it was
 * set to something else (by the CLI or the API), so a save never changes it
 * by accident.
 * @param current - The goal's interval.
 * @returns The options, in order.
 */
export function reviewIntervalOptions(
  current: number | null,
): (number | null)[] {
  const options = [...REVIEW_INTERVALS];
  if (!options.includes(current)) {
    options.push(current);
    options.sort((a, b) => (a ?? 0) - (b ?? 0));
  }
  return options;
}

/**
 * A goal's last review in words.
 * @param goal - Its `lastReviewedAt` and `reviewEverySeconds`.
 * @returns A sentence fragment.
 */
export function lastReviewedLabel(goal: {
  lastReviewedAt: number | null;
  reviewEverySeconds: number | null;
}): string {
  if (goal.lastReviewedAt === null) {
    return goal.reviewEverySeconds === null
      ? "Not reviewed on a schedule"
      : "Not reviewed yet";
  }
  return `Last reviewed ${new Date(goal.lastReviewedAt).toLocaleString()}`;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

/** One argument as the skill editor holds it, every field a string or a switch. */
export interface ArgumentDraft {
  name: string;
  description: string;
  required: boolean;
  default: string;
}

/** A skill argument as `skill:create` and `skill:edit` take it. */
export interface ArgumentInput {
  name: string;
  description?: string;
  required: boolean;
  default?: string;
}

/**
 * An argument as the editor holds it.
 * @param arg - The argument as stored.
 * @returns The draft.
 */
export function argumentDraft(arg: {
  name: string;
  description?: string;
  required?: boolean;
  default?: string;
}): ArgumentDraft {
  return {
    name: arg.name,
    description: arg.description ?? "",
    required: arg.required ?? false,
    default: arg.default ?? "",
  };
}

/**
 * The editor's arguments as the API takes them: names trimmed, blank
 * descriptions and defaults left out.
 * @param drafts - The editor's rows.
 * @returns The inputs.
 */
export function argumentInputs(
  drafts: readonly ArgumentDraft[],
): ArgumentInput[] {
  return drafts.map((d) => {
    const input: ArgumentInput = { name: d.name.trim(), required: d.required };
    if (d.description.trim()) input.description = d.description.trim();
    if (d.default !== "") input.default = d.default;
    return input;
  });
}

/**
 * What is wrong with a skill's arguments, before the server is asked: a
 * name that is not letters, digits, and underscores, the reserved
 * `ARGUMENTS`, or a name used twice.
 * @param drafts - The editor's rows.
 * @returns A sentence, or `null` when they are fine.
 */
export function argumentsProblem(
  drafts: readonly ArgumentDraft[],
): string | null {
  const seen = new Set<string>();
  for (const d of drafts) {
    const name = d.name.trim();
    if (name === "") return "Every argument needs a name.";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
      return `"${name}" is not a name: use letters, digits, and underscores, not starting with a digit.`;
    if (name === "ARGUMENTS")
      return "ARGUMENTS is reserved: $ARGUMENTS is every argument at once.";
    if (seen.has(name)) return `Two arguments are called "${name}".`;
    seen.add(name);
  }
  return null;
}

/**
 * Whether a skill name is one `skill:create` takes: lowercase letters,
 * digits, and hyphens.
 * @param name - What was typed.
 * @returns A sentence, or `null` when it is fine.
 */
export function skillNameProblem(name: string): string | null {
  const n = name.trim().toLowerCase();
  if (n === "") return "A skill needs a name.";
  if (n.length > 64) return "A skill name is at most 64 characters.";
  if (!/^[a-z0-9][a-z0-9-]*$/.test(n))
    return "A skill name is lowercase letters, digits, and hyphens, such as release-notes.";
  return null;
}

/**
 * How a person calls a skill: its name, then each argument — required ones
 * in angle brackets, optional ones in square brackets.
 * @param skill - Its name and arguments.
 * @returns e.g. `/release-notes <version> [audience]`.
 */
export function skillUsage(skill: {
  name: string;
  arguments: readonly { name: string; required?: boolean }[];
}): string {
  const args = skill.arguments.map((a) =>
    a.required ? `<${a.name}>` : `[${a.name}]`,
  );
  return [`/${skill.name}`, ...args].join(" ");
}

/**
 * Which version of a skill a bot uses, in words.
 * @param binding - Its pin and the skill's current version.
 * @returns "Latest (v3)" or "Pinned to v2 of 3".
 */
export function pinLabel(binding: {
  pinnedVersion: number | null;
  currentVersion: number;
}): string {
  return binding.pinnedVersion === null
    ? `Latest (v${binding.currentVersion})`
    : `Pinned to v${binding.pinnedVersion} of ${binding.currentVersion}`;
}

/** Why a member who is not an admin may not change a section every bot includes. */
export const PROJECT_SECTION_DENIED =
  "Only a project admin may change a section every bot in the project includes.";

/**
 * Why a person may not change the project's sections, or `undefined` when
 * they may: the action's own requirement first, then admin standing, which
 * the server checks for project sections inside the action. Unknown standing
 * is not a refusal.
 * @param actionReason - `reason(action)` for the action.
 * @param standing - The project standing, or `null` while unknown.
 * @returns The sentence a disabled control carries, or `undefined`.
 */
export function projectSectionDenied(
  actionReason: string | undefined,
  standing: { isAdmin: boolean } | null,
): string | undefined {
  if (actionReason) return actionReason;
  if (standing && !standing.isAdmin) return PROJECT_SECTION_DENIED;
  return undefined;
}
