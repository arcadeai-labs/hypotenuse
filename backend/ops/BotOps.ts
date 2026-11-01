import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { config, ErrorType, TypedError } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/code";
import {
  BOT_SANDBOX_POLICIES,
  type Bot,
  bots,
  GITHUB_WAKE_EVENTS,
} from "../schema/bots";
import type { Tag } from "../schema/tags";
import {
  ACCESS_EVERYONE,
  type AccessListTable,
  assertAccessListTags,
  canRead,
  canWrite,
  registerAccessListTable,
  satisfiesAccess,
} from "./AccessOps";
import type { DbHandle } from "./DbOps";
import { isAdmin } from "./MembershipOps";
import { aliasNameInput, aliasNames, isReservedModelAlias } from "./ModelOps";
import { SLUG_PATTERN } from "./SlugOps";

/**
 * Bots: who may read and change one, how one is shown, and the rules its
 * fields obey. Every bot action goes through here, and access always goes
 * through `AccessOps` — there is no second implementation.
 */

/** The bots table as `AccessOps` knows it. */
export const BOT_ACCESS_LIST: AccessListTable = {
  kind: "bot",
  table: bots,
  id: bots.id,
  projectId: bots.projectId,
  label: bots.name,
  accessRead: bots.accessRead,
  accessWrite: bots.accessWrite,
  tagColumns: [bots.helpNotifyTag],
};

registerAccessListTable(BOT_ACCESS_LIST);

/** The largest avatar accepted, in bytes. */
export const MAX_AVATAR_BYTES = 512 * 1024;

/** The image types an avatar may be. */
export const AVATAR_MIME_TYPES = ["image/png", "image/jpeg"] as const;

/** One of {@link AVATAR_MIME_TYPES}. */
export type AvatarMimeType = (typeof AVATAR_MIME_TYPES)[number];

/**
 * Whether a caller may see a bot: `AccessOps.canRead` over its row.
 * @param bot - The bot.
 * @param callerTags - The caller's tags in its project.
 * @returns `true` if they may read it.
 */
export function canReadBot(bot: Bot, callerTags: Tag[]): boolean {
  return canRead(bot, callerTags);
}

/**
 * Whether a caller may change or delete a bot: `AccessOps.canWrite` over its row.
 * @param bot - The bot.
 * @param callerTags - The caller's tags in its project.
 * @returns `true` if they may write it.
 */
export function canWriteBot(bot: Bot, callerTags: Tag[]): boolean {
  return canWrite(bot, callerTags);
}

/**
 * A bot's avatar path beneath `/api`, carrying its last change so a browser
 * re-reads it after an upload. `null` when it has none.
 * @param bot - The bot.
 * @returns The path, or `null`.
 */
export function avatarPath(bot: Bot): string | null {
  if (!bot.avatarMimeType) return null;
  return `/project/${bot.projectId}/bot/${bot.id}/avatar?v=${bot.updatedAt.getTime()}`;
}

/**
 * Shape a bot for any answer. The avatar's bytes are never in it; `avatarUrl`
 * is the path that serves them. `persona` is the current text of the bot's
 * *Identity* prompt section, which the caller reads (`botPersona`).
 * @param bot - The bot row.
 * @param persona - Its *Identity* section's text.
 * @returns The serialized bot.
 */
export function serializeBot(bot: Bot, persona: string) {
  return {
    id: bot.id,
    projectId: bot.projectId,
    name: bot.name,
    slug: bot.slug,
    description: bot.description,
    displayName: bot.displayName,
    avatarUrl: avatarPath(bot),
    avatarMimeType: bot.avatarMimeType,
    persona,
    modelAlias: bot.modelAlias,
    fastModelAlias: bot.fastModelAlias,
    accessRead: bot.accessRead,
    accessWrite: bot.accessWrite,
    helpNotifyTag: bot.helpNotifyTag,
    monthlyBudgetUsd:
      bot.monthlyBudgetUsd === null ? null : Number(bot.monthlyBudgetUsd),
    enabled: bot.enabled,
    maxStepsPerTurn: bot.maxStepsPerTurn,
    memoryChannelHalfLifeDays: bot.memoryChannelHalfLifeDays,
    memoryProjectHalfLifeDays: bot.memoryProjectHalfLifeDays,
    hasCallbackSecret: bot.apiCallbackSecret !== null,
    approverTag: bot.approverTag,
    approvalTtlSeconds: bot.approvalTtlSeconds,
    promptBudgetTokens: bot.promptBudgetTokens,
    maxAgentSections: bot.maxAgentSections,
    codeModeEnabled: bot.codeModeEnabled,
    codeLimits: bot.codeLimits,
    capabilities: bot.capabilities,
    autoBind: bot.autoBind,
    participantRateLimit: bot.participantRateLimit,
    channelRateLimit: bot.channelRateLimit,
    sandboxPolicy: bot.sandboxPolicy,
    sandboxJobTokenBudget: bot.sandboxJobTokenBudget,
    githubWakeEvents: bot.githubWakeEvents,
    createdByUserId: bot.createdByUserId,
    createdAt: bot.createdAt.getTime(),
    updatedAt: bot.updatedAt.getTime(),
  };
}

/**
 * What the caller may do with a bot, decided by the server so a client never
 * re-implements an access list.
 * @param bot - The bot.
 * @param callerTags - The caller's tags in its project.
 * @returns The caller's standing on the bot.
 */
export function botStanding(bot: Bot, callerTags: Tag[]) {
  return { canWrite: canWriteBot(bot, callerTags) };
}

/**
 * Load a bot the caller may read. A bot that does not exist, belongs to
 * another project, or is unreadable to the caller is the **same** 404, so an
 * access list cannot be probed for what it hides.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param botId - The bot.
 * @param callerTags - The caller's tags in the project.
 * @param options.lock - Take `FOR UPDATE` (inside a writing transaction).
 * @returns The bot.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function loadReadableBot(
  db: DbHandle,
  projectId: number,
  botId: number,
  callerTags: Tag[],
  options: { lock?: boolean } = {},
): Promise<Bot> {
  const query = db
    .select()
    .from(bots)
    .where(and(eq(bots.id, botId), eq(bots.projectId, projectId)))
    .limit(1);
  const [bot] = options.lock ? await query.for("update") : await query;
  if (!bot || !canReadBot(bot, callerTags)) {
    throw new TypedError({
      message: "Bot not found in this project",
      type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
    });
  }
  return bot;
}

/**
 * Refuse a caller who may read a bot but not change it.
 * @param bot - The bot.
 * @param callerTags - The caller's tags in its project.
 * @throws {TypedError} `CONNECTION_CHANNEL_AUTHORIZATION` naming who can.
 */
export function assertCanWriteBot(bot: Bot, callerTags: Tag[]): void {
  if (canWriteBot(bot, callerTags)) return;
  throw new TypedError({
    message: `You can read "${bot.name}" but not change it: its write access is limited to ${bot.accessWrite.map((t) => `"${t}"`).join(", ")}. Ask someone with one of those tags, or an admin.`,
    type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
  });
}

/**
 * **The lockout guard.** Refuse an access list the caller would not satisfy,
 * unless they are an admin: a member who saves a write list without any of
 * their own tags has locked themselves out of the bot they were editing, and
 * only an admin could let them back in. The read list gets the same rule,
 * since a bot its writer cannot read is one they cannot open to fix.
 * @param list - The list being saved.
 * @param callerTags - The caller's tags in the project.
 * @param key - Which list it is, `accessRead` or `accessWrite`.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` keyed on the list.
 */
export function assertNotLockedOut(
  list: string[],
  callerTags: Tag[],
  key: "accessRead" | "accessWrite",
): void {
  if (isAdmin(callerTags) || satisfiesAccess(list, callerTags)) return;
  const verb = key === "accessRead" ? "read" : "write";
  throw new TypedError({
    message: `That ${verb} access list would lock you out of this bot, because you hold none of its tags. Add one of your tags, or ask an admin.`,
    type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
    key,
  });
}

/**
 * Refuse a bot field naming a model alias the project lacks. `default` and
 * `fast` are always accepted: every project must define them before any bot
 * runs, and the Bots page says so while either is missing, so a bot may be
 * made before an admin has chosen its models.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param named - The alias each field names, keyed by param.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` naming the alias.
 */
export async function assertAliasesExist(
  db: DbHandle,
  projectId: number,
  named: Record<string, string | undefined>,
): Promise<void> {
  const entries = Object.entries(named).filter(
    (e): e is [string, string] =>
      e[1] !== undefined && !isReservedModelAlias(e[1]),
  );
  if (entries.length === 0) return;
  const defined = await aliasNames(db, projectId);
  for (const [key, alias] of entries) {
    if (!defined.has(alias)) {
      throw new TypedError({
        message: `This project has no model named "${alias}". Pick one of its model names, or ask an admin to add it under Settings → Models.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key,
      });
    }
  }
}

/**
 * Refuse a `helpNotifyTag` naming a tag the project lacks.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param tag - The tag name, or `null` for the project's admins.
 * @param key - The input it came in (`helpNotifyTag` or `approverTag`).
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` keyed on `key`.
 */
export async function assertHelpTag(
  db: DbHandle,
  projectId: number,
  tag: string | null | undefined,
  key: "helpNotifyTag" | "approverTag" = "helpNotifyTag",
): Promise<void> {
  if (!tag) return;
  // An access list reads `*` as every member, but a help tag names one tag
  // whose holders are asked; "everyone" is not a tag anyone holds.
  if (tag.trim() === ACCESS_EVERYONE) {
    throw new TypedError({
      message: `This names one tag, not "${ACCESS_EVERYONE}". Choose a tag, or null.`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key,
    });
  }
  await assertAccessListTags(db, projectId, [tag], key);
}

/**
 * Refuse a slug another bot of the project already has.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param slug - The slug.
 * @param exceptBotId - The bot being edited, which may keep its own.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` keyed on `slug`.
 */
export async function assertSlugFree(
  db: DbHandle,
  projectId: number,
  slug: string,
  exceptBotId?: number,
): Promise<void> {
  const [taken] = await db
    .select({ id: bots.id })
    .from(bots)
    .where(and(eq(bots.projectId, projectId), eq(bots.slug, slug)))
    .limit(1);
  if (taken && taken.id !== exceptBotId) {
    throw new TypedError({
      message: `Another bot in this project already has the slug "${slug}". Choose another.`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "slug",
    });
  }
}

/**
 * Every bot slug in a project, for choosing a free one.
 * @param db - A database handle.
 * @param projectId - The project.
 * @returns The slugs taken.
 */
export async function botSlugs(
  db: DbHandle,
  projectId: number,
): Promise<string[]> {
  const rows = await db
    .select({ slug: bots.slug })
    .from(bots)
    .where(eq(bots.projectId, projectId));
  return rows.map((r) => r.slug);
}

/** A decoded, validated avatar. */
export interface Avatar {
  bytes: Buffer;
  mimeType: AvatarMimeType;
  width: number;
  height: number;
}

/**
 * The width and height of a PNG, from its `IHDR` chunk.
 * @param bytes - The file.
 * @returns The dimensions, or `null` when it is not a PNG.
 */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return null;
  if (bytes.subarray(12, 16).toString("latin1") !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * The width and height of a JPEG, from its first start-of-frame marker.
 * @param bytes - The file.
 * @returns The dimensions, or `null` when it is not a JPEG or has no frame.
 */
function jpegSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    // Fill bytes and markers with no length.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    // Start of frame: every SOFn but DHT (C4), JPG (C8), and DAC (CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * Decode and validate an avatar sent as base64 (a `data:` URL is accepted
 * too). The type is read from the bytes, never from the client's word for it.
 * @param raw - The base64 string.
 * @returns The bytes, type, and size.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` keyed on `avatar`.
 */
export function decodeAvatar(raw: string): Avatar {
  const refuse = (message: string) =>
    new TypedError({
      message,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "avatar",
    });
  const base64 = raw.replace(/^data:[^;,]*;base64,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length === 0) {
    throw refuse("The avatar must be a base64-encoded PNG or JPEG.");
  }
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length > MAX_AVATAR_BYTES) {
    throw refuse(
      `The avatar is ${Math.ceil(bytes.length / 1024)} KB; the most is ${MAX_AVATAR_BYTES / 1024} KB.`,
    );
  }
  const png = pngSize(bytes);
  const jpeg = png ? null : jpegSize(bytes);
  const size = png ?? jpeg;
  if (!size) throw refuse("The avatar must be a PNG or JPEG image.");
  if (size.width !== size.height || size.width === 0) {
    throw refuse(
      `The avatar must be square; this one is ${size.width}×${size.height}.`,
    );
  }
  return {
    bytes,
    mimeType: png ? "image/png" : "image/jpeg",
    width: size.width,
    height: size.height,
  };
}

/**
 * What an audit row records about an avatar: its size, type, and digest —
 * never the bytes.
 * @param avatar - The decoded avatar, or `null` for one removed.
 * @returns The summary.
 */
export function summarizeAvatar(avatar: Avatar | null) {
  if (!avatar) return { removed: true };
  return {
    bytes: avatar.bytes.length,
    mimeType: avatar.mimeType,
    width: avatar.width,
    height: avatar.height,
    sha256: createHash("sha256").update(avatar.bytes).digest("hex"),
  };
}

/** The Zod input for a bot's slug. */
export const botSlugInput = z
  .string()
  .trim()
  .min(1)
  .max(64, "A slug is at most 64 characters")
  .regex(
    SLUG_PATTERN,
    "A slug uses lowercase letters and digits, separated by single dashes",
  )
  .describe(
    "The bot's slug: lowercase letters, digits, and dashes, unique in the project. Generated platform app manifests embed it",
  );

/** The Zod input for a bot's name. */
export const botNameInput = z
  .string()
  .trim()
  .min(1, "A bot needs a name")
  .max(80, "A bot's name is at most 80 characters")
  .describe('The bot\'s name, e.g. "Ada"');

/** The Zod input for a bot's display name. */
export const botDisplayNameInput = z
  .string()
  .trim()
  .min(1)
  .max(80, "A display name is at most 80 characters")
  .describe("The name platforms show for the bot; defaults to its name");

/** The Zod input for a bot's description. */
export const botDescriptionInput = z
  .string()
  .trim()
  .max(280, "A description is at most 280 characters")
  .describe("What the bot is for, shown in lists");

/** The Zod input for a bot's persona: the text of its *Identity* section. */
export const botPersonaInput = z
  .string()
  .trim()
  .min(1, "A bot needs a persona")
  .max(20_000, "A persona is at most 20,000 characters")
  .describe(
    "The identity section of the bot's system prompt, in markdown: who it is, how it speaks, what it will not do",
  );

/** The Zod input for a bot's model aliases. */
export const botModelAliasInput = aliasNameInput(
  "The model alias the bot thinks with (default: default)",
);

/** The Zod input for a bot's fast model alias. */
export const botFastModelAliasInput = aliasNameInput(
  "The model alias for the bot's cheap auxiliary calls (default: fast)",
);

/** The Zod input for the tag a bot asks for help. */
export const helpNotifyTagInput = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(256)
  .nullable()
  .describe(
    "The tag whose holders the bot asks for help when nobody answers in-channel; null means the project's admins",
  );

/** The Zod input for the tag whose holders may decide a bot's approvals. */
export const approverTagInput = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(256)
  .nullable()
  .describe(
    "A tag whose holders may approve or deny this bot's tool calls, besides the people who may change the bot; they are also the ones notified. null means only the bot's writers decide, and the project's admins are notified",
  );

/** The Zod input for how long an approval waits. */
export const approvalTtlInput = z
  .number()
  .int()
  .min(60)
  .max(30 * 24 * 60 * 60)
  .describe(
    "How long a tool-call approval waits for a decision before it expires and counts as denied, in seconds (default 86400, a day)",
  );

/** The Zod input for a monthly budget in US dollars. */
export const monthlyBudgetInput = z
  .number()
  .nonnegative()
  .max(99_999_999.99)
  .nullable()
  .describe(
    "A monthly spending ceiling in US dollars, or null for none. Once the costs a provider reports reach it, the bot takes no more steps that month; costs a provider does not report are not counted yet",
  );

/** The Zod input for the most model steps one turn may take. */
export const maxStepsPerTurnInput = z
  .number()
  .int()
  .min(1)
  .max(500)
  .describe(
    "The most model steps one turn may take before it fails (default 50)",
  );

/** The Zod input for an avatar. */
export const avatarInput = z
  .string()
  .max(800_000, "The avatar is too large; the most is 512 KB")
  .nullable()
  .describe(
    "A square PNG or JPEG of at most 512 KB, base64-encoded (a data: URL is accepted); null removes the avatar",
  );

/**
 * A budget as the `numeric` column stores it.
 * @param value - The dollars, or `null`.
 * @returns The column value.
 */
export function budgetColumn(value: number | null): string | null {
  return value === null ? null : value.toFixed(2);
}

/**
 * The Zod input for a memory half-life, in days: 1 to 3650.
 * @param scope - Which memory it is for.
 * @returns The schema.
 */
export function halfLifeInput(scope: "channel" | "project") {
  return z
    .number()
    .int()
    .min(1, "A half-life is at least one day")
    .max(3650, "A half-life is at most 3650 days")
    .describe(
      scope === "channel"
        ? "Days an unused channel memory takes to lose half its search weight (default 30); faded channel memory is eventually forgotten"
        : "Days an unused project memory takes to lose half of its search weight for this bot (default 180); project memory is never forgotten by decay",
    );
}

/** The Zod input for a bot's prompt budget. */
export const promptBudgetInput = z
  .number()
  .int()
  .min(1_000, "A prompt budget is at least 1,000 tokens")
  .max(200_000)
  .describe(
    "The system prompt's budget in tokens (estimated at four characters each); contextual sections are dropped to fit it",
  );

/** Whether a bot may start sandbox jobs, and whether each waits for approval. */
export const sandboxPolicyInput = z
  .enum(BOT_SANDBOX_POLICIES)
  .describe(
    "Sandbox jobs (sandbox_start): off, approve (each job waits for a person's approval), or allow",
  );

/** The model tokens one sandbox job may use. */
export const sandboxJobTokenBudgetInput = z
  .number()
  .int()
  .min(1_000)
  .nullable()
  .describe(
    "The most model tokens (input plus output) one sandbox job may use before it is stopped; null for no cap",
  );

/**
 * Which events on a pull request one of the bot's jobs opened wake its
 * conversation; deduplicated, in {@link GITHUB_WAKE_EVENTS} order.
 */
export const githubWakeEventsInput = z
  .array(z.enum(GITHUB_WAKE_EVENTS))
  .max(GITHUB_WAKE_EVENTS.length * 4)
  .transform((events) => GITHUB_WAKE_EVENTS.filter((e) => events.includes(e)))
  .describe(
    `Which events on a pull request one of the bot's sandbox jobs opened wake the conversation that asked for it: any of ${GITHUB_WAKE_EVENTS.join(", ")}; the rest are recorded for its next turn. An empty list wakes it for none`,
  );

/** Whether a bot is offered `run_code`. */
export const codeModeEnabledInput = z
  .boolean()
  .describe("Whether the bot may run code (run_code)");

/** A bot's own code-mode limits; each may only lower the deployment's. */
export const codeLimitsInput = z
  .object({
    timeoutMs: z
      .number()
      .int()
      .min(1_000)
      .optional()
      .describe("Wall-clock milliseconds one program may take"),
    memoryBytes: z
      .number()
      .int()
      .min(8 * 1024 * 1024)
      .optional()
      .describe("Bytes of memory one program may use"),
    bridgeRequests: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Host calls (memory, MCP) one program may make"),
  })
  .strict()
  .describe(
    "Lower this bot's code-mode limits; omit a key for the deployment's. A value above the deployment's is refused",
  );

/**
 * Refuse a bot limit above the deployment's: a bot can lower a limit, never
 * raise one.
 * @param limits - The limits sent.
 * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION`, naming the ceiling.
 */
export function assertCodeLimits(
  limits: z.infer<typeof codeLimitsInput>,
): void {
  const ceilings = {
    timeoutMs: config.code.timeoutMs,
    memoryBytes: config.code.memoryBytes,
    bridgeRequests: config.code.bridgeRequests,
  };
  for (const [key, ceiling] of Object.entries(ceilings)) {
    const value = limits[key as keyof typeof ceilings];
    if (value !== undefined && value > ceiling) {
      throw new TypedError({
        message: `codeLimits.${key} may only lower the deployment's limit of ${ceiling}.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "codeLimits",
      });
    }
  }
}

/** The Zod input for how many sections a bot may create itself. */
export const maxAgentSectionsInput = z
  .number()
  .int()
  .min(0)
  .max(50)
  .describe("How many prompt sections the bot may create itself (0 stops it)");

/** The Zod input for where a bot binds itself when invited. */
export const autoBindInput = z
  .object({
    public: z.boolean().describe("Public channels"),
    private: z.boolean().describe("Private channels"),
    dm: z.boolean().describe("Direct messages"),
  })
  .describe(
    "Whether the bot starts listening by itself in a channel it is invited to, per kind. Private channels and DMs default to off: a person binds them, which records who may read them",
  );

/**
 * The Zod input for a per-minute message limit.
 * @param who - Whose messages it counts.
 * @returns The input.
 */
export function rateLimitInput(who: string) {
  return z
    .number()
    .int()
    .min(1)
    .max(10_000)
    .describe(
      `The most messages a minute ${who} may send the bot before it ignores them for the rest of the minute`,
    );
}
