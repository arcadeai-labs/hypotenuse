import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { botSkills } from "../schema/bot_skills";
import type { Bot } from "../schema/bots";
import type { Channel } from "../schema/channels";
import { conversationEntries } from "../schema/conversation_entries";
import type { Conversation } from "../schema/conversations";
import { type Goal, goals } from "../schema/goals";
import {
  type PromptSectionLoading,
  type PromptSectionScope,
  promptSections,
  promptSectionVersions,
} from "../schema/prompt_sections";
import { type SkillArgument, skills, skillVersions } from "../schema/skills";
import type { DbHandle } from "./DbOps";

/**
 * **The prompt assembler**: the system prompt a bot thinks with, built from
 * what is stored — its sections, its goals, its skills, its capabilities —
 * in a fixed order. Assembly never calls a model and reads the clock only to
 * decide which goals are due for review, so a prompt is a pure function of
 * rows and time, and every step's hash resolves, through the section versions
 * recorded in its `context_update`, to the exact text that was sent.
 *
 * | # | Part | Source |
 * |---|---|---|
 * | 1 | Identity | the bot's name and description, and its *Identity* section |
 * | 2 | Project sections (`always`) | `prompt_sections` scope `project` |
 * | 3 | Bot sections (`always`) | `prompt_sections` scope `bot` |
 * | 4 | Contextual sections that matched | both scopes, project first |
 * | 5 | Goals | active goals by priority, and any review that is due |
 * | 6 | Skills index | the attached skills' names and descriptions |
 * | 7 | Capabilities | the bot's generated MCP summary, when it has servers |
 * | 8 | Channel context | where the conversation is, and its title |
 * | 9 | Tool primers | ending a turn, memory, MCP, the bot's own prompt |
 * | 10 | Style rules | fixed |
 *
 * **Budget.** Text is estimated at four characters a token. When the prompt is
 * over `bots.promptBudgetTokens`, matched contextual sections are dropped from
 * the last one included backwards until it fits; `always` parts are never
 * dropped, and a change that would make them exceed the budget is refused
 * where it is saved ({@link alwaysTokens}).
 */

/** Characters per estimated token. */
export const CHARS_PER_TOKEN = 4;

/** A section as the assembler sees it: the row's settings and one version's text. */
export interface SectionInput {
  id: number;
  key: string;
  scope: PromptSectionScope;
  loading: PromptSectionLoading;
  keywords: string[];
  agentEditable: boolean;
  position: number;
  version: number;
  title: string;
  body: string;
}

/** An attached skill as the index shows it. */
export interface SkillIndexInput {
  name: string;
  description: string;
  arguments: SkillArgument[];
}

/** Everything one assembly reads. */
export interface PromptInputs {
  bot: Pick<Bot, "name" | "displayName" | "description" | "capabilities"> & {
    promptBudgetTokens: number;
  };
  channel: Pick<Channel, "type" | "name">;
  conversationTitle: string | null;
  /** The newest message a person sent, or the sample a preview was given. */
  latestMessage: string | null;
  sections: SectionInput[];
  goals: Goal[];
  skills: SkillIndexInput[];
  /** Whether the bot has MCP servers: the MCP primer and capabilities are included only then. */
  mcp: boolean;
}

/** A section included in, or dropped from, a prompt. */
export interface SectionRef {
  id: number;
  key: string;
  version: number;
}

/**
 * One part of a rendered prompt, as a `context_update` records it: a section
 * by id and version (its text is in `prompt_section_versions`), or generated
 * text kept verbatim.
 */
export type RecordedPart =
  | { section: number; version: number; heading: boolean }
  | { text: string };

/** What {@link assemblePrompt} returns. */
export interface AssembledPrompt {
  system: string;
  hash: string;
  /** The sections included, in order. */
  sections: SectionRef[];
  /** Contextual sections that matched and were dropped to fit the budget. */
  dropped: SectionRef[];
  parts: RecordedPart[];
  /** The context terms contextual sections were matched against. */
  contextTerms: string[];
  estimatedTokens: number;
  budgetTokens: number;
  /** True when even the `always` parts are over the budget. */
  overBudget: boolean;
}

/** The rules every bot follows about ending a turn. */
const LOOP_RULES = [
  "## How you work",
  "",
  "You are in a conversation that may last a long time and outlive any one process. Every turn you take must end by calling exactly one of these tools:",
  "",
  "- `reply_and_wait` — post your reply and wait for the next message.",
  "- `ask_question` — ask something you need to know, and wait for the answer.",
  "- `wait_for` — pause until a time, then carry on.",
  "- `complete` — the work is done; post a summary and close the conversation.",
  "- `fail` — you cannot do it; say why and what would help.",
  "",
  "Text you write outside those tools is not shown to anyone. Call other tools as often as you need first. If a tool result says a call was interrupted, check its effects before repeating it.",
].join("\n");

/** How memory works: the two scopes, and search before write. */
const MEMORY_RULES = [
  "## What you remember",
  "",
  "You have a memory that outlasts this conversation, in two scopes:",
  "",
  "- **channel** — what you have learned in this channel. Only you, here, can see it.",
  "- **project** — what is shared by every bot in every channel of the project. Only a person adds to it.",
  "",
  "Before answering from what you think you know, `memory_search` it. When you learn something durable — a decision, a preference, how something is done, who is who — `memory_write` it to channel memory, or `memory_edit` the document that already covers it. `memory_forget` what turns out to be wrong. Memories you do not use fade over time.",
].join("\n");

/** How MCP tools work: search, read, then call; approvals. */
const MCP_RULES = [
  "## Your tools",
  "",
  "You can use tools on MCP servers your project connected. You do not see them all at once:",
  "",
  "1. `mcp_search` for what you want to do (or `mcp_list_tools` for one server).",
  "2. `mcp_info` on the tool you choose — required before you call it, once per conversation.",
  "3. `mcp_exec` it with arguments that match its input schema.",
  "",
  "Some calls wait for a person to approve them; the conversation pauses until they decide. If a call is denied, do not retry it — try another way, or ask. A result too long to show comes back as a preview with an id for `read_large_result`.",
].join("\n");

/** How a bot keeps its own prompt. */
const PROMPT_RULES = [
  "## Your own instructions",
  "",
  "Some sections of these instructions are yours to keep. `prompt_list` shows them and which you may change; `prompt_read` one before you `prompt_edit` it. When you learn how this team works — what they call things, how they like answers — write it into an editable section such as *Things I have learned*, so it shapes every future turn. Facts about the work itself belong in memory instead. `prompt_create` adds a section of your own, included when its keywords come up. You cannot change your identity, the project's sections, your goals' titles, or skills.",
].join("\n");

/** Fixed style rules: brevity and no flattery. */
const STYLE_RULES = [
  "## Style",
  "",
  "- Lead with the answer. No preamble, no restating the question, no closing offers of more help.",
  "- Be brief: say it once, in the fewest words that are still clear.",
  "- Do not flatter. Never call a question great or an idea brilliant; say plainly when something is wrong, including when it is the person's idea.",
  "- Say what you do not know instead of guessing, and say what you did not check.",
  "- Use markdown where it helps — a short list, code in a code block — and nowhere else.",
].join("\n");

/** Words too common to match a section on. */
const STOP_WORDS = new Set(
  "about above after again against also because been before being below between both could does doing down during each from further have having here into itself just more most other ought over same should some such than that their them then there these they this those through under until very were what when where which while with would your yours yourself please thanks thank hello want need make like know".split(
    " ",
  ),
);

/**
 * The words of a text worth matching on: lowercase, longer than three
 * characters, stop words removed, de-duplicated in order.
 * @param texts - The texts.
 * @returns The terms.
 */
export function extractTerms(
  ...texts: (string | null | undefined)[]
): string[] {
  const seen = new Set<string>();
  for (const text of texts) {
    if (!text) continue;
    for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (word.length > 3 && !STOP_WORDS.has(word)) seen.add(word);
    }
  }
  return [...seen];
}

/**
 * A turn's context terms: from the conversation title, the latest message a
 * person sent, and the channel name.
 * @param inputs - The assembly's inputs.
 * @returns The terms.
 */
export function contextTerms(
  inputs: Pick<PromptInputs, "conversationTitle" | "latestMessage" | "channel">,
): string[] {
  return extractTerms(
    inputs.conversationTitle,
    inputs.latestMessage,
    inputs.channel.name,
  );
}

/**
 * A section's keywords: the explicit ones, or its title's words.
 * @param section - The section.
 * @returns Lowercased keywords.
 */
export function sectionKeywords(
  section: Pick<SectionInput, "keywords" | "title">,
): string[] {
  const explicit = section.keywords
    .map((k) => k.trim().toLowerCase())
    .filter(Boolean);
  return explicit.length > 0 ? explicit : extractTerms(section.title);
}

/**
 * Whether a contextual section matches a turn: one of its keywords equals a
 * context term, or (for a keyword of four characters or more) begins one, so
 * `deploy` matches `deploying`.
 * @param section - The section.
 * @param terms - The turn's context terms.
 * @returns `true` to include it.
 */
export function matchesContext(
  section: Pick<SectionInput, "keywords" | "title">,
  terms: string[],
): boolean {
  const keywords = sectionKeywords(section);
  return keywords.some((k) =>
    terms.some((t) => t === k || (k.length >= 4 && t.startsWith(k))),
  );
}

/**
 * A section's text in the prompt: a `##` heading with its title, then its
 * body. The *Identity* section has no heading.
 * @param title - The version's title.
 * @param body - The version's body.
 * @param heading - Whether to head it.
 * @returns The text.
 */
export function renderSection(
  title: string,
  body: string,
  heading: boolean,
): string {
  return heading ? `## ${title}\n\n${body.trim()}` : body.trim();
}

/**
 * Estimate a text's tokens.
 * @param text - The text.
 * @returns The estimate.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Whether a goal is due for review.
 * @param goal - The goal.
 * @param now - The time to judge at.
 * @returns `true` when its review interval has passed.
 */
export function goalReviewDue(
  goal: Pick<
    Goal,
    "status" | "reviewEverySeconds" | "lastReviewedAt" | "createdAt"
  >,
  now: Date,
): boolean {
  if (goal.status !== "active" || !goal.reviewEverySeconds) return false;
  const since = (goal.lastReviewedAt ?? goal.createdAt).getTime();
  return now.getTime() - since >= goal.reviewEverySeconds * 1000;
}

const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 } as const;

/**
 * The goals part, or `null` with no active goals.
 * @param all - The bot's goals.
 * @param now - The time, for reviews.
 * @returns The text.
 */
export function renderGoals(all: Goal[], now: Date): string | null {
  const active = all
    .filter((g) => g.status === "active")
    .sort(
      (a, b) =>
        PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
        a.position - b.position ||
        a.id - b.id,
    );
  if (active.length === 0) return null;
  const lines = [
    "## Your goals",
    "",
    "Work toward these. When one changes — achieved, dropped, or there is progress worth keeping — record it with `goal_update`.",
    "",
  ];
  for (const g of active) {
    lines.push(
      `- Goal ${g.id}: **${g.title}** (${g.priority} priority)${g.description.trim() ? ` — ${g.description.trim()}` : ""}`,
    );
    if (g.notes.trim()) lines.push(`  Notes: ${g.notes.trim()}`);
  }
  const due = active.filter((g) => goalReviewDue(g, now));
  for (const g of due) {
    lines.push(
      "",
      `Review goal ${g.id} ("${g.title}"): is it still right, and how is it going? Record what you find with \`goal_update\`.`,
    );
  }
  return lines.join("\n");
}

/**
 * The skills index, or `null` with no skills attached.
 * @param all - The attached skills.
 * @returns The text.
 */
export function renderSkillsIndex(all: SkillIndexInput[]): string | null {
  if (all.length === 0) return null;
  const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name));
  return [
    "## Skills",
    "",
    "Procedures your team wrote down. When one fits the task, call `use_skill` with its name and arguments, then follow what it returns.",
    "",
    ...sorted.map((s) => {
      const args = s.arguments
        .map((a) => (a.required ? a.name : `${a.name}?`))
        .join(", ");
      return `- \`${s.name}\` — ${s.description}${args ? ` (arguments: ${args})` : ""}`;
    }),
  ].join("\n");
}

/**
 * The channel context: where the conversation is, and its title.
 * @param inputs - The assembly's inputs.
 * @returns The text.
 */
export function renderChannelContext(
  inputs: Pick<PromptInputs, "channel" | "conversationTitle">,
): string {
  const where =
    inputs.channel.type === "api"
      ? `You are talking to a person or program over the HTTP API, in the "${inputs.channel.name}" channel. Your replies are markdown.`
      : `You are in the ${inputs.channel.type} channel "${inputs.channel.name}".`;
  return inputs.conversationTitle
    ? `${where} This conversation is titled "${inputs.conversationTitle}".`
    : where;
}

/**
 * Assemble a system prompt from its inputs. Pure: the same inputs and time
 * give the same text and hash in any process.
 * @param inputs - What to assemble.
 * @param now - The time, which decides only which goal reviews are due.
 * @returns The prompt, its parts, and its hash.
 */
export function assemblePrompt(
  inputs: PromptInputs,
  now: Date = new Date(),
): AssembledPrompt {
  const live = inputs.sections.filter((s) => s.body.trim() !== "");
  const byPosition = (a: SectionInput, b: SectionInput) =>
    a.position - b.position || a.id - b.id;
  const identity = live.find((s) => s.scope === "bot" && s.key === "identity");
  const always = (scope: PromptSectionScope) =>
    live
      .filter(
        (s) => s.scope === scope && s.loading === "always" && s !== identity,
      )
      .sort(byPosition);
  const terms = contextTerms(inputs);
  const contextual = (["project", "bot"] as const).flatMap((scope) =>
    live
      .filter(
        (s) =>
          s.scope === scope &&
          s.loading === "contextual" &&
          s !== identity &&
          matchesContext(s, terms),
      )
      .sort(byPosition),
  );

  type Part = { text: string; record: RecordedPart; section?: SectionInput };
  const textPart = (text: string): Part => ({ text, record: { text } });
  const sectionPart = (s: SectionInput, heading = true): Part => ({
    text: renderSection(s.title, s.body, heading),
    record: { section: s.id, version: s.version, heading },
    section: s,
  });

  const identityLine = [
    `You are ${inputs.bot.displayName}${inputs.bot.name !== inputs.bot.displayName ? ` (${inputs.bot.name})` : ""}, a bot.`,
    inputs.bot.description ? inputs.bot.description : null,
  ]
    .filter(Boolean)
    .join(" ");

  const head: Part[] = [
    textPart(identityLine),
    ...(identity ? [sectionPart(identity, false)] : []),
    ...always("project").map((s) => sectionPart(s)),
    ...always("bot").map((s) => sectionPart(s)),
  ];
  const goalsText = renderGoals(inputs.goals, now);
  const skillsText = renderSkillsIndex(inputs.skills);
  const capabilities =
    inputs.mcp && inputs.bot.capabilities?.trim()
      ? `## What your tools can do\n\n${inputs.bot.capabilities.trim()}`
      : null;
  const tail: Part[] = [
    ...(goalsText ? [textPart(goalsText)] : []),
    ...(skillsText ? [textPart(skillsText)] : []),
    ...(capabilities ? [textPart(capabilities)] : []),
    textPart(renderChannelContext(inputs)),
    textPart(LOOP_RULES),
    textPart(MEMORY_RULES),
    ...(inputs.mcp ? [textPart(MCP_RULES)] : []),
    textPart(PROMPT_RULES),
    textPart(STYLE_RULES),
  ];

  const join = (parts: Part[]) => parts.map((p) => p.text).join("\n\n");
  const included = contextual.map((s) => sectionPart(s));
  const dropped: SectionInput[] = [];
  const budget = inputs.bot.promptBudgetTokens;
  let system = join([...head, ...included, ...tail]);
  while (included.length > 0 && estimateTokens(system) > budget) {
    const last = included.pop() as Part;
    dropped.unshift(last.section as SectionInput);
    system = join([...head, ...included, ...tail]);
  }
  const all = [...head, ...included, ...tail];
  const ref = (s: SectionInput): SectionRef => ({
    id: s.id,
    key: s.key,
    version: s.version,
  });
  const estimatedTokens = estimateTokens(system);
  return {
    system,
    hash: promptHash(system),
    sections: all.flatMap((p) => (p.section ? [ref(p.section)] : [])),
    dropped: dropped.map(ref),
    parts: all.map((p) => p.record),
    contextTerms: terms,
    estimatedTokens,
    budgetTokens: budget,
    overBudget: estimatedTokens > budget,
  };
}

/**
 * The estimated tokens of a bot's parts that are always included — every
 * part but contextual sections — for refusing a change that would push them
 * over the budget. Judged in a stand-in API channel with no conversation.
 * @param inputs - The inputs, with any contextual sections ignored.
 * @returns The estimate.
 */
export function alwaysTokens(inputs: PromptInputs): number {
  return assemblePrompt({
    ...inputs,
    sections: inputs.sections.filter((s) => s.loading === "always"),
  }).estimatedTokens;
}

/**
 * The sha256 of a prompt, recorded on every step so a change is visible.
 * @param prompt - The prompt text.
 * @returns The hex digest.
 */
export function promptHash(prompt: string): string {
  return createHash("sha256").update(prompt).digest("hex");
}

/** How two steps' sections differ, as a `context_update` records it. */
export interface SectionDiff {
  added: SectionRef[];
  removed: SectionRef[];
  changed: (SectionRef & { previousVersion: number })[];
}

/**
 * Compare the sections of two prompts.
 * @param previous - The earlier prompt's sections (empty before the first).
 * @param next - The new prompt's sections.
 * @returns What was added, removed, and changed.
 */
export function diffSections(
  previous: SectionRef[],
  next: SectionRef[],
): SectionDiff {
  const before = new Map(previous.map((s) => [s.id, s]));
  const after = new Map(next.map((s) => [s.id, s]));
  return {
    added: next.filter((s) => !before.has(s.id)),
    removed: previous.filter((s) => !after.has(s.id)),
    changed: next.flatMap((s) => {
      const was = before.get(s.id);
      return was && was.version !== s.version
        ? [{ ...s, previousVersion: was.version }]
        : [];
    }),
  };
}

/**
 * The sections a bot's prompt draws on — its own and its project's, not
 * archived — each with its current version's text.
 * @param db - A database handle.
 * @param bot - The bot.
 * @returns The sections.
 */
export async function loadSections(
  db: DbHandle,
  bot: Pick<Bot, "id" | "projectId">,
): Promise<SectionInput[]> {
  const rows = await db
    .select({ section: promptSections, version: promptSectionVersions })
    .from(promptSections)
    .innerJoin(
      promptSectionVersions,
      and(
        eq(promptSectionVersions.sectionId, promptSections.id),
        eq(promptSectionVersions.version, promptSections.currentVersion),
      ),
    )
    .where(
      and(
        eq(promptSections.projectId, bot.projectId),
        eq(promptSections.archived, false),
        or(
          eq(promptSections.botId, bot.id),
          and(
            eq(promptSections.scope, "project"),
            isNull(promptSections.botId),
          ),
        ),
      ),
    )
    .orderBy(asc(promptSections.position), asc(promptSections.id));
  return rows.map(({ section, version }) => ({
    id: section.id,
    key: section.key,
    scope: section.scope,
    loading: section.loading,
    keywords: section.keywords,
    agentEditable: section.agentEditable,
    position: section.position,
    version: version.version,
    title: version.title,
    body: version.body,
  }));
}

/**
 * The skills attached to a bot, each at its pinned version or its current one.
 * @param db - A database handle.
 * @param botId - The bot.
 * @returns The skills' names, descriptions, and arguments at those versions.
 */
export async function loadSkillIndex(
  db: DbHandle,
  botId: number,
): Promise<SkillIndexInput[]> {
  const attached = await db
    .select({ skill: skills, pinned: botSkills.pinnedVersion })
    .from(botSkills)
    .innerJoin(skills, eq(skills.id, botSkills.skillId))
    .where(eq(botSkills.botId, botId));
  const pinned = attached.filter(
    (a) => a.pinned !== null && a.pinned !== a.skill.currentVersion,
  );
  const versions =
    pinned.length > 0
      ? await db
          .select()
          .from(skillVersions)
          .where(
            or(
              ...pinned.map((p) =>
                and(
                  eq(skillVersions.skillId, p.skill.id),
                  eq(skillVersions.version, p.pinned as number),
                ),
              ),
            ),
          )
      : [];
  return attached.map(({ skill, pinned: pin }) => {
    const v =
      pin !== null
        ? versions.find((r) => r.skillId === skill.id && r.version === pin)
        : undefined;
    return {
      name: skill.name,
      description: v?.description ?? skill.description,
      arguments: v?.arguments ?? skill.arguments,
    };
  });
}

/**
 * The newest message a person sent in a conversation.
 * @param db - A database handle.
 * @param conversationId - The conversation.
 * @returns Its text, or `null`.
 */
export async function latestInboundText(
  db: DbHandle,
  conversationId: number,
): Promise<string | null> {
  const [row] = await db
    .select({ content: conversationEntries.content })
    .from(conversationEntries)
    .where(
      and(
        eq(conversationEntries.conversationId, conversationId),
        eq(conversationEntries.kind, "message"),
        eq(conversationEntries.role, "user"),
      ),
    )
    .orderBy(desc(conversationEntries.seq))
    .limit(1);
  const text = (row?.content as { text?: unknown } | undefined)?.text;
  return typeof text === "string" ? text : null;
}

/**
 * Read everything an assembly needs for a bot in a channel.
 * @param db - A database handle.
 * @param bot - The bot.
 * @param where.channel - The conversation's channel (or a stand-in).
 * @param where.conversation - The conversation, when there is one.
 * @param where.message - A sample message, in place of the newest one.
 * @param where.mcp - Whether the bot has MCP servers.
 * @returns The inputs.
 */
export async function loadPromptInputs(
  db: DbHandle,
  bot: Bot,
  where: {
    channel: Pick<Channel, "type" | "name">;
    conversation?: Pick<Conversation, "id" | "title"> | null;
    message?: string | null;
    mcp: boolean;
  },
): Promise<PromptInputs> {
  // One query at a time: the handle may be a transaction's single client.
  const sections = await loadSections(db, bot);
  const goalRows = await db
    .select()
    .from(goals)
    .where(and(eq(goals.botId, bot.id), eq(goals.status, "active")));
  const skillIndex = await loadSkillIndex(db, bot.id);
  const latest =
    where.message !== undefined && where.message !== null
      ? where.message
      : where.conversation
        ? await latestInboundText(db, where.conversation.id)
        : null;
  return {
    bot,
    channel: where.channel,
    conversationTitle: where.conversation?.title ?? null,
    latestMessage: latest,
    sections,
    goals: goalRows,
    skills: skillIndex,
    mcp: where.mcp,
  };
}

/**
 * Rebuild a prompt from what a `context_update` recorded: each section part
 * from its stored version, each generated part verbatim. Its hash equals the
 * recorded `promptHash` — which is what makes every step reproducible.
 * @param db - A database handle.
 * @param parts - The recorded parts.
 * @returns The prompt text.
 */
export async function replayPrompt(
  db: DbHandle,
  parts: RecordedPart[],
): Promise<string> {
  const refs = parts.filter(
    (p): p is Extract<RecordedPart, { section: number }> => "section" in p,
  );
  const ids = [...new Set(refs.map((r) => r.section))];
  const versions =
    ids.length > 0
      ? await db
          .select()
          .from(promptSectionVersions)
          .where(inArray(promptSectionVersions.sectionId, ids))
      : [];
  return parts
    .map((p) => {
      if ("text" in p) return p.text;
      const v = versions.find(
        (r) => r.sectionId === p.section && r.version === p.version,
      );
      if (!v)
        throw new Error(`Section ${p.section} version ${p.version} is missing`);
      return renderSection(v.title, v.body, p.heading);
    })
    .join("\n\n");
}
