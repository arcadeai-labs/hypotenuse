import { and, count, eq, inArray, isNull, or } from "drizzle-orm";
import { ErrorType, TypedError } from "keryx";
import { z } from "zod";
import { type Bot, bots } from "../schema/bots";
import {
  PROMPT_SECTION_LOADINGS,
  type PromptSection,
  type PromptSectionVersion,
  type PromptVersionSource,
  promptSections,
  promptSectionVersions,
} from "../schema/prompt_sections";
import type { Tag } from "../schema/tags";
import { assertCanWriteBot, loadReadableBot } from "./BotOps";
import type { DbHandle, TxHandle } from "./DbOps";
import { botHasServers } from "./McpCatalogOps";
import { isAdmin } from "./MembershipOps";
import {
  alwaysTokens,
  loadPromptInputs,
  type PromptInputs,
  type SectionInput,
} from "./PromptOps";

/**
 * Prompt sections: the seeds every bot starts with, versions, who may change
 * what, and the budget guard. A section's text is only ever changed by
 * writing a new version through {@link writeSectionVersion}.
 *
 * | Section | Person who may write the bot | Project admin | The bot (`prompt_edit`) |
 * |---|---|---|---|
 * | bot section, `agentEditable` | yes | yes | yes |
 * | bot section, not `agentEditable` | yes | yes | no |
 * | *Identity* | yes (never made bot-editable, never deleted) | yes | no |
 * | project section | no | yes | no |
 */

/** The key of the section that says who a bot is. */
export const IDENTITY_KEY = "identity";

/** The sections every new bot gets, in order. */
export const SEED_SECTIONS = [
  { key: IDENTITY_KEY, title: "Identity", agentEditable: false },
  { key: "how-i-work", title: "How I work", agentEditable: true },
  {
    key: "things-i-have-learned",
    title: "Things I have learned",
    agentEditable: true,
  },
] as const;

/** The longest body a section may have, in characters. */
export const SECTION_BODY_MAX = 20_000;

/** The Zod input for a section key. */
export const sectionKeyInput = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "A key is lowercase letters, digits, and hyphens",
  )
  .describe("A short unique key, e.g. release-process");

/** The Zod input for a section title. */
export const sectionTitleInput = z
  .string()
  .trim()
  .min(1, "A section needs a title")
  .max(120)
  .describe("The section's heading");

/** The Zod input for a section body. */
export const sectionBodyInput = z
  .string()
  .max(SECTION_BODY_MAX, "A section is at most 20,000 characters")
  .describe("The section's text, markdown");

/** The Zod input for when a section loads. */
export const sectionLoadingInput = z
  .enum(PROMPT_SECTION_LOADINGS)
  .describe(
    "always: in every step; contextual: only when one of its keywords comes up in the conversation's title, the latest message, or the channel name",
  );

/** The Zod input for a section's keywords. */
export const sectionKeywordsInput = z
  .array(z.string().trim().toLowerCase().min(1).max(40))
  .max(30)
  .describe(
    "Words that bring a contextual section in; empty means its title's words",
  );

/** The Zod input for a change note. */
export const changeNoteInput = z
  .string()
  .trim()
  .max(500)
  .describe("Why it changed, in a sentence");

/**
 * Make a key from a title: lowercase words joined by hyphens.
 * @param title - The title.
 * @returns The key (`section` when nothing is left).
 */
export function keyFromTitle(title: string): string {
  const key = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return key || "section";
}

/**
 * Seed a new bot's three sections; *Identity* takes its persona.
 * @param tx - The bot's creating transaction.
 * @param bot - The bot.
 * @param persona - Who it is.
 * @param userId - Who created it.
 * @returns The sections.
 */
export async function seedBotSections(
  tx: TxHandle,
  bot: Bot,
  persona: string,
  userId: number | null,
): Promise<PromptSection[]> {
  const created: PromptSection[] = [];
  for (const [position, seed] of SEED_SECTIONS.entries()) {
    const [section] = await tx
      .insert(promptSections)
      .values({
        projectId: bot.projectId,
        scope: "bot",
        botId: bot.id,
        key: seed.key,
        title: seed.title,
        loading: "always",
        agentEditable: seed.agentEditable,
        position,
        origin: "seed",
        currentVersion: 1,
      })
      .returning();
    await tx.insert(promptSectionVersions).values({
      sectionId: section.id,
      version: 1,
      title: seed.title,
      body: seed.key === IDENTITY_KEY ? persona : "",
      source: "seed",
      userId,
    });
    created.push(section);
  }
  return created;
}

/** What a new version says. */
export interface VersionDraft {
  title?: string;
  body: string;
  source: PromptVersionSource;
  userId?: number | null;
  conversationId?: number | null;
  entryId?: number | null;
  changeNote?: string | null;
}

/**
 * Write a section's next version and make it current. The caller holds the
 * section's row lock.
 * @param tx - The transaction.
 * @param section - The section, locked.
 * @param draft - The version.
 * @returns The section and the new version.
 */
export async function writeSectionVersion(
  tx: TxHandle,
  section: PromptSection,
  draft: VersionDraft,
): Promise<{ section: PromptSection; version: PromptSectionVersion }> {
  const next = section.currentVersion + 1;
  const title = draft.title ?? section.title;
  const [version] = await tx
    .insert(promptSectionVersions)
    .values({
      sectionId: section.id,
      version: next,
      title,
      body: draft.body,
      source: draft.source,
      userId: draft.userId ?? null,
      conversationId: draft.conversationId ?? null,
      entryId: draft.entryId ?? null,
      changeNote: draft.changeNote ?? null,
    })
    .returning();
  const [updated] = await tx
    .update(promptSections)
    .set({ currentVersion: next, title })
    .where(eq(promptSections.id, section.id))
    .returning();
  return { section: updated, version };
}

/**
 * One version of a section.
 * @param db - A database handle.
 * @param sectionId - The section.
 * @param version - The version number.
 * @returns The row, or `undefined`.
 */
export async function sectionVersion(
  db: DbHandle,
  sectionId: number,
  version: number,
): Promise<PromptSectionVersion | undefined> {
  const [row] = await db
    .select()
    .from(promptSectionVersions)
    .where(
      and(
        eq(promptSectionVersions.sectionId, sectionId),
        eq(promptSectionVersions.version, version),
      ),
    );
  return row;
}

/**
 * The text of a bot's *Identity* section — what the API still calls its persona.
 * @param db - A database handle.
 * @param botId - The bot.
 * @returns The current body, or `""`.
 */
export async function botPersona(db: DbHandle, botId: number): Promise<string> {
  const [row] = await db
    .select({ body: promptSectionVersions.body })
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
        eq(promptSections.botId, botId),
        eq(promptSections.key, IDENTITY_KEY),
      ),
    );
  return row?.body ?? "";
}

/**
 * The *Identity* text of several bots at once, for a list.
 * @param db - A database handle.
 * @param botIds - The bots.
 * @returns Each bot's text, by id.
 */
export async function botPersonas(
  db: DbHandle,
  botIds: number[],
): Promise<Map<number, string>> {
  if (botIds.length === 0) return new Map();
  const rows = await db
    .select({ botId: promptSections.botId, body: promptSectionVersions.body })
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
        inArray(promptSections.botId, botIds),
        eq(promptSections.key, IDENTITY_KEY),
      ),
    );
  return new Map(rows.map((r) => [r.botId as number, r.body]));
}

/**
 * A bot's *Identity* section, locked.
 * @param tx - The transaction.
 * @param botId - The bot.
 * @returns The row.
 */
export async function lockIdentitySection(
  tx: TxHandle,
  botId: number,
): Promise<PromptSection | undefined> {
  const [row] = await tx
    .select()
    .from(promptSections)
    .where(
      and(
        eq(promptSections.botId, botId),
        eq(promptSections.key, IDENTITY_KEY),
      ),
    )
    .for("update");
  return row;
}

/**
 * Load a section of a project, optionally locked. Archived sections load too:
 * their versions stay readable.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param sectionId - The section.
 * @param options.lock - Take its row lock.
 * @returns The section.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function loadSection(
  db: DbHandle,
  projectId: number,
  sectionId: number,
  options: { lock?: boolean } = {},
): Promise<PromptSection> {
  const query = db
    .select()
    .from(promptSections)
    .where(
      and(
        eq(promptSections.id, sectionId),
        eq(promptSections.projectId, projectId),
      ),
    );
  const [row] = options.lock ? await query.for("update") : await query;
  if (!row) throw sectionNotFound();
  return row;
}

/**
 * The 404 for a section that is missing or belongs to a bot the caller cannot read.
 * @returns The error.
 */
export function sectionNotFound(): TypedError {
  return new TypedError({
    message: "Prompt section not found in this project",
    type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
  });
}

/**
 * Shape a section for any answer, with its current version's text when given.
 * @param section - The row.
 * @param current - Its current version.
 * @returns The serialized section.
 */
export function serializePromptSection(
  section: PromptSection,
  current?: PromptSectionVersion,
) {
  return {
    id: section.id,
    projectId: section.projectId,
    scope: section.scope,
    botId: section.botId,
    key: section.key,
    title: section.title,
    loading: section.loading,
    keywords: section.keywords,
    agentEditable: section.agentEditable,
    position: section.position,
    origin: section.origin,
    currentVersion: section.currentVersion,
    archived: section.archived,
    ...(current
      ? {
          body: current.body,
          versionSource: current.source,
          versionCreatedAt: current.createdAt.getTime(),
        }
      : {}),
    createdAt: section.createdAt.getTime(),
    updatedAt: section.updatedAt.getTime(),
  };
}

/**
 * Shape a section version for any answer.
 * @param v - The row.
 * @returns The serialized version.
 */
export function serializePromptSectionVersion(v: PromptSectionVersion) {
  return {
    id: v.id,
    sectionId: v.sectionId,
    version: v.version,
    title: v.title,
    body: v.body,
    source: v.source,
    userId: v.userId,
    conversationId: v.conversationId,
    entryId: v.entryId,
    changeNote: v.changeNote,
    createdAt: v.createdAt.getTime(),
  };
}

/**
 * A bot's prompt inputs in a stand-in API channel, with a section replaced or
 * added as it would be after a change — for judging the change before it is
 * saved.
 * @param db - A database handle.
 * @param bot - The bot.
 * @param change - The section as it would be, if any.
 * @returns The inputs.
 */
async function inputsWith(
  db: DbHandle,
  bot: Bot,
  change?: SectionInput | { removeId: number },
): Promise<PromptInputs> {
  const inputs = await loadPromptInputs(db, bot, {
    channel: { type: "api", name: "default" },
    mcp: await botHasServers(db, bot.id),
  });
  if (!change) return inputs;
  const rest = inputs.sections.filter((s) =>
    "removeId" in change ? s.id !== change.removeId : s.id !== change.id,
  );
  return {
    ...inputs,
    sections: "removeId" in change ? rest : [...rest, change],
  };
}

/**
 * The always-included tokens of a bot's prompt after a change, and its budget.
 * @param db - A database handle.
 * @param bot - The bot (its budget is read from it).
 * @param change - The section as it would be, if any.
 * @returns The estimate and the budget.
 */
export async function alwaysTokensAfter(
  db: DbHandle,
  bot: Bot,
  change?: SectionInput,
): Promise<{ tokens: number; budget: number }> {
  return {
    tokens: alwaysTokens(await inputsWith(db, bot, change)),
    budget: bot.promptBudgetTokens,
  };
}

/**
 * The sentence a refusal for an over-budget prompt says.
 * @param botName - The bot.
 * @param tokens - The estimate.
 * @param budget - The budget.
 * @returns The message.
 */
export function overBudgetMessage(
  botName: string,
  tokens: number,
  budget: number,
): string {
  return `The parts of ${botName}'s prompt that are always included would be about ${tokens} tokens, over its budget of ${budget}. Make a section contextual, shorten one, or raise the bot's prompt budget.`;
}

/**
 * Refuse a change that would push the always-included parts of a bot's
 * prompt — or, for a project section, of any bot in the project — over budget.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param botId - The bot, or `null` for a project section (every bot is checked).
 * @param change - The section as it would be.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION`.
 */
export async function assertPromptFits(
  db: DbHandle,
  projectId: number,
  botId: number | null,
  change?: SectionInput,
): Promise<void> {
  const targets = await db
    .select()
    .from(bots)
    .where(
      botId === null
        ? eq(bots.projectId, projectId)
        : and(eq(bots.projectId, projectId), eq(bots.id, botId)),
    );
  for (const bot of targets) {
    const { tokens, budget } = await alwaysTokensAfter(db, bot, change);
    if (tokens > budget) {
      throw new TypedError({
        message: overBudgetMessage(bot.name, tokens, budget),
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      });
    }
  }
}

/**
 * A section as the assembler would see it after a change.
 * @param section - The row, with any changed settings applied.
 * @param title - The new title.
 * @param body - The new body.
 * @returns The input.
 */
export function asSectionInput(
  section: Pick<
    PromptSection,
    | "id"
    | "key"
    | "scope"
    | "loading"
    | "keywords"
    | "agentEditable"
    | "position"
    | "currentVersion"
  >,
  title: string,
  body: string,
): SectionInput {
  return {
    id: section.id,
    key: section.key,
    scope: section.scope,
    loading: section.loading,
    keywords: section.keywords,
    agentEditable: section.agentEditable,
    position: section.position,
    version: section.currentVersion + 1,
    title,
    body,
  };
}

/**
 * How many live sections a bot created itself.
 * @param db - A database handle.
 * @param botId - The bot.
 * @returns The count.
 */
export async function agentSectionCount(
  db: DbHandle,
  botId: number,
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(promptSections)
    .where(
      and(
        eq(promptSections.botId, botId),
        eq(promptSections.origin, "agent"),
        eq(promptSections.archived, false),
      ),
    );
  return row?.n ?? 0;
}

/**
 * The next position after a bot's (or the project's) sections.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param botId - The bot, or `null` for project sections.
 * @returns The position.
 */
export async function nextPosition(
  db: DbHandle,
  projectId: number,
  botId: number | null,
): Promise<number> {
  const rows = await db
    .select({ position: promptSections.position })
    .from(promptSections)
    .where(
      and(
        eq(promptSections.projectId, projectId),
        botId === null
          ? isNull(promptSections.botId)
          : eq(promptSections.botId, botId),
      ),
    );
  return rows.reduce((max, r) => Math.max(max, r.position + 1), 0);
}

/**
 * Pick a key not yet used by a bot's (or the project's) sections, from a base.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param botId - The bot, or `null`.
 * @param base - The wanted key.
 * @returns `base`, or `base-2`, `base-3`, ….
 */
export async function freeKey(
  db: DbHandle,
  projectId: number,
  botId: number | null,
  base: string,
): Promise<string> {
  const rows = await db
    .select({ key: promptSections.key })
    .from(promptSections)
    .where(
      and(
        eq(promptSections.projectId, projectId),
        botId === null
          ? isNull(promptSections.botId)
          : eq(promptSections.botId, botId),
      ),
    );
  const taken = new Set(rows.map((r) => r.key));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base.slice(0, 60)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Check a caller's access to a section: a bot section follows its bot's
 * access lists (an unreadable bot's section is not found); a project section
 * is readable by every member and writable only by an admin.
 * @param db - A database handle.
 * @param section - The section.
 * @param callerTags - The caller's tags.
 * @param mode - `read` or `write`.
 * @returns The section's bot, or `null` for a project section.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` or `CONNECTION_CHANNEL_AUTHORIZATION`.
 */
export async function assertSectionAccess(
  db: DbHandle,
  section: PromptSection,
  callerTags: Tag[],
  mode: "read" | "write",
): Promise<Bot | null> {
  if (section.scope === "project") {
    if (mode === "write") assertProjectSectionAdmin(callerTags);
    return null;
  }
  let bot: Bot;
  try {
    bot = await loadReadableBot(
      db,
      section.projectId,
      section.botId as number,
      callerTags,
    );
  } catch {
    throw sectionNotFound();
  }
  if (mode === "write") assertCanWriteBot(bot, callerTags);
  return bot;
}

/**
 * Refuse a caller who is not a project admin a change to a project section.
 * @param callerTags - The caller's tags.
 * @throws {TypedError} `CONNECTION_CHANNEL_AUTHORIZATION`.
 */
export function assertProjectSectionAdmin(callerTags: Tag[]): void {
  if (!isAdmin(callerTags)) {
    throw new TypedError({
      message:
        "Project sections are in every bot's prompt; only a project admin may change them",
      type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
    });
  }
}

/**
 * Sections with their current versions' text.
 * @param db - A database handle.
 * @param sections - The rows.
 * @returns Each row's current version, by section id.
 */
export async function currentVersions(
  db: DbHandle,
  sections: PromptSection[],
): Promise<Map<number, PromptSectionVersion>> {
  if (sections.length === 0) return new Map();
  const rows = await db
    .select()
    .from(promptSectionVersions)
    .where(
      or(
        ...sections.map((s) =>
          and(
            eq(promptSectionVersions.sectionId, s.id),
            eq(promptSectionVersions.version, s.currentVersion),
          ),
        ),
      ),
    );
  return new Map(rows.map((r) => [r.sectionId, r]));
}
