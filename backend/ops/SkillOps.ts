import { and, eq } from "drizzle-orm";
import { ErrorType, TypedError } from "keryx";
import { z } from "zod";
import { type BotSkill, botSkills } from "../schema/bot_skills";
import {
  type Skill,
  type SkillArgument,
  type SkillVersion,
  skills,
  skillVersions,
} from "../schema/skills";
import type { Tag } from "../schema/tags";
import {
  type AccessListTable,
  canRead,
  canWrite,
  registerAccessListTable,
} from "./AccessOps";
import type { DbHandle } from "./DbOps";

/**
 * Skills: the project's library of procedures, how a template is filled in,
 * and who may see and change one. Access goes through `AccessOps` like every
 * other access list.
 *
 * **Substitution** (botholomew's rules). A call's arguments arrive as a string
 * (`/release-notes v2.1 customers`, or `use_skill`'s `arguments` string) or as
 * an object of named values.
 *
 * | In the body | Becomes |
 * |---|---|
 * | `$ARGUMENTS` | the whole argument string as given (the named values joined, for an object) |
 * | `$<name>` | that declared argument's value, or its default |
 * | `$1`, `$2`, … | the first, second, … declared argument's value; with none declared, the positional words |
 * | anything else after `$` | left alone (`$HOME` in a shell snippet survives) |
 *
 * In a string, `name:value` sets a declared argument by name, a quoted
 * `"two words"` is one word, and the remaining words fill the declared
 * arguments in order — the **last declared argument takes the rest**. A
 * required argument with no value and no default is an error.
 */

/** The skills table as `AccessOps` knows it. */
export const SKILL_ACCESS_LIST: AccessListTable = {
  kind: "skill",
  table: skills,
  id: skills.id,
  projectId: skills.projectId,
  label: skills.name,
  accessRead: skills.accessRead,
  accessWrite: skills.accessWrite,
  tagColumns: [],
};

registerAccessListTable(SKILL_ACCESS_LIST);

/** The longest skill body, in characters. */
export const SKILL_BODY_MAX = 20_000;

/** The Zod input for a skill name, which `/<name>` calls. */
export const skillNameInput = z
  .string()
  .trim()
  .toLowerCase()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "A skill name is lowercase letters, digits, and hyphens",
  )
  .describe("The skill's name, which /<name> and use_skill call");

/** The Zod input for a skill's one-line description. */
export const skillDescriptionInput = z
  .string()
  .trim()
  .min(1, "A skill needs a description")
  .max(280)
  .describe(
    "One line: what the skill does, shown in every attached bot's prompt",
  );

/** The Zod input for a skill's arguments. */
export const skillArgumentsInput = z
  .array(
    z.object({
      name: z
        .string()
        .trim()
        .regex(
          /^[A-Za-z_][A-Za-z0-9_]*$/,
          "An argument name is letters, digits, and underscores",
        )
        .max(40)
        .refine((n) => n !== "ARGUMENTS", "ARGUMENTS is reserved")
        .describe("The name, used as $<name> in the body"),
      description: z.string().trim().max(200).optional(),
      required: z.boolean().default(false),
      default: z.string().max(500).optional(),
    }),
  )
  .max(20)
  .refine(
    (args) => new Set(args.map((a) => a.name)).size === args.length,
    "Argument names must be unique",
  )
  .describe("The arguments the skill takes, in positional order");

/** The Zod input for a skill's template body. */
export const skillBodyInput = z
  .string()
  .min(1, "A skill needs a body")
  .max(SKILL_BODY_MAX, "A skill is at most 20,000 characters")
  .describe("The template: markdown with $1, $ARGUMENTS, and $<name>");

/** Why a skill could not be filled in. */
export class SkillArgumentError extends Error {}

/**
 * Split an argument string into words; a quoted run is one word.
 * @param raw - The string.
 * @returns The words.
 */
export function splitArguments(raw: string): string[] {
  const words: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of raw.matchAll(re)) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

/**
 * Resolve a call's arguments against a skill's declared ones.
 * @param declared - The skill's arguments.
 * @param given - A string, or named values.
 * @returns The value of each declared argument, the positional words, and the raw string.
 * @throws {SkillArgumentError} For a missing required argument or an unknown name.
 */
export function resolveArguments(
  declared: SkillArgument[],
  given: string | Record<string, string> | undefined,
): { values: Map<string, string>; positional: string[]; raw: string } {
  const values = new Map<string, string>();
  let positional: string[] = [];
  let raw = "";
  const names = new Set(declared.map((a) => a.name));
  if (typeof given === "string" || given === undefined) {
    raw = (given ?? "").trim();
    for (const word of splitArguments(raw)) {
      const named = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/s.exec(word);
      if (named && names.has(named[1])) values.set(named[1], named[2]);
      else positional.push(word);
    }
    const open = declared.filter((a) => !values.has(a.name));
    open.forEach((arg, i) => {
      if (i >= positional.length) return;
      const isLast = i === open.length - 1;
      values.set(
        arg.name,
        isLast ? positional.slice(i).join(" ") : positional[i],
      );
    });
  } else {
    for (const [name, value] of Object.entries(given)) {
      if (!names.has(name)) {
        throw new SkillArgumentError(
          `This skill has no argument "${name}"; it takes ${declared.map((a) => a.name).join(", ") || "none"}.`,
        );
      }
      values.set(name, String(value));
    }
    raw = declared
      .filter((a) => values.has(a.name))
      .map((a) => values.get(a.name))
      .join(" ");
    positional = [];
  }
  for (const arg of declared) {
    if (values.has(arg.name) && values.get(arg.name) !== "") continue;
    if (arg.default !== undefined) values.set(arg.name, arg.default);
    else if (arg.required) {
      throw new SkillArgumentError(
        `The argument "${arg.name}" is required${arg.description ? ` (${arg.description})` : ""}.`,
      );
    } else values.set(arg.name, "");
  }
  return { values, positional, raw };
}

/**
 * Fill in a skill's template.
 * @param body - The template.
 * @param declared - Its arguments.
 * @param given - The call's arguments.
 * @returns The rendered text.
 * @throws {SkillArgumentError} When the arguments do not satisfy the skill.
 */
export function renderSkill(
  body: string,
  declared: SkillArgument[],
  given: string | Record<string, string> | undefined,
): string {
  const { values, positional, raw } = resolveArguments(declared, given);
  return body.replace(/\$(ARGUMENTS|\d+|[A-Za-z_][A-Za-z0-9_]*)/g, (m, ref) => {
    if (ref === "ARGUMENTS") return raw;
    if (/^\d+$/.test(ref)) {
      const n = Number(ref);
      if (n < 1) return m;
      if (declared.length > 0) {
        const arg = declared[n - 1];
        return arg ? (values.get(arg.name) ?? "") : m;
      }
      return positional[n - 1] ?? m;
    }
    return values.has(ref) ? (values.get(ref) as string) : m;
  });
}

/**
 * Whether a caller may see (and attach) a skill.
 * @param skill - The skill.
 * @param callerTags - The caller's tags in its project.
 * @returns `true` if so.
 */
export function canReadSkill(skill: Skill, callerTags: Tag[]): boolean {
  return canRead(skill, callerTags);
}

/**
 * Whether a caller may change or delete a skill.
 * @param skill - The skill.
 * @param callerTags - The caller's tags in its project.
 * @returns `true` if so.
 */
export function canWriteSkill(skill: Skill, callerTags: Tag[]): boolean {
  return canWrite(skill, callerTags);
}

/**
 * The 404 for a skill that is missing or unreadable.
 * @returns The error.
 */
export function skillNotFound(): TypedError {
  return new TypedError({
    message: "Skill not found in this project",
    type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
  });
}

/**
 * Load a skill the caller may read.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param skillId - The skill.
 * @param callerTags - The caller's tags.
 * @param options.lock - Take its row lock.
 * @returns The skill.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function loadReadableSkill(
  db: DbHandle,
  projectId: number,
  skillId: number,
  callerTags: Tag[],
  options: { lock?: boolean } = {},
): Promise<Skill> {
  const query = db
    .select()
    .from(skills)
    .where(and(eq(skills.id, skillId), eq(skills.projectId, projectId)));
  const [row] = options.lock ? await query.for("update") : await query;
  if (!row || !canReadSkill(row, callerTags)) throw skillNotFound();
  return row;
}

/**
 * Refuse a caller who may not change a skill.
 * @param skill - The skill.
 * @param callerTags - The caller's tags.
 * @throws {TypedError} `CONNECTION_CHANNEL_AUTHORIZATION`.
 */
export function assertCanWriteSkill(skill: Skill, callerTags: Tag[]): void {
  if (!canWriteSkill(skill, callerTags)) {
    throw new TypedError({
      message: `You may read the skill "${skill.name}" but not change it; ask a project admin or someone with its write access`,
      type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
    });
  }
}

/**
 * One version of a skill.
 * @param db - A database handle.
 * @param skillId - The skill.
 * @param version - The version.
 * @returns The row, or `undefined`.
 */
export async function skillVersion(
  db: DbHandle,
  skillId: number,
  version: number,
): Promise<SkillVersion | undefined> {
  const [row] = await db
    .select()
    .from(skillVersions)
    .where(
      and(
        eq(skillVersions.skillId, skillId),
        eq(skillVersions.version, version),
      ),
    );
  return row;
}

/** A skill as a bot uses it: the attachment and the version in force. */
export interface AttachedSkill {
  skill: Skill;
  binding: BotSkill;
  version: SkillVersion;
}

/**
 * The skill attached to a bot under a name, at its pinned or current version.
 * @param db - A database handle.
 * @param botId - The bot.
 * @param name - The skill's name.
 * @returns The skill, or `null` when none by that name is attached.
 */
export async function attachedSkill(
  db: DbHandle,
  botId: number,
  name: string,
): Promise<AttachedSkill | null> {
  const [row] = await db
    .select({ skill: skills, binding: botSkills })
    .from(botSkills)
    .innerJoin(skills, eq(skills.id, botSkills.skillId))
    .where(
      and(eq(botSkills.botId, botId), eq(skills.name, name.toLowerCase())),
    );
  if (!row) return null;
  const version = await skillVersion(
    db,
    row.skill.id,
    row.binding.pinnedVersion ?? row.skill.currentVersion,
  );
  if (!version) return null;
  return { ...row, version };
}

/**
 * Shape a skill for any answer, with its current body when given.
 * @param skill - The row.
 * @param current - Its current version.
 * @returns The serialized skill.
 */
export function serializeSkill(skill: Skill, current?: SkillVersion) {
  return {
    id: skill.id,
    projectId: skill.projectId,
    name: skill.name,
    description: skill.description,
    arguments: skill.arguments,
    currentVersion: skill.currentVersion,
    accessRead: skill.accessRead,
    accessWrite: skill.accessWrite,
    createdByUserId: skill.createdByUserId,
    ...(current ? { body: current.body } : {}),
    createdAt: skill.createdAt.getTime(),
    updatedAt: skill.updatedAt.getTime(),
  };
}

/**
 * Shape a skill version for any answer.
 * @param v - The row.
 * @returns The serialized version.
 */
export function serializeSkillVersion(v: SkillVersion) {
  return {
    id: v.id,
    skillId: v.skillId,
    version: v.version,
    description: v.description,
    arguments: v.arguments,
    body: v.body,
    userId: v.userId,
    changeNote: v.changeNote,
    createdAt: v.createdAt.getTime(),
  };
}

/**
 * Shape an attachment for any answer.
 * @param binding - The attachment.
 * @param skill - Its skill.
 * @returns The serialized attachment.
 */
export function serializeBotSkill(binding: BotSkill, skill: Skill) {
  return {
    id: binding.id,
    botId: binding.botId,
    skillId: skill.id,
    name: skill.name,
    description: skill.description,
    arguments: skill.arguments,
    currentVersion: skill.currentVersion,
    pinnedVersion: binding.pinnedVersion,
    version: binding.pinnedVersion ?? skill.currentVersion,
    createdAt: binding.createdAt.getTime(),
  };
}

/** What a message that invokes a skill looks like once expanded. */
export interface SkillInvocation {
  name: string;
  version: number;
  arguments: string;
  /** The rendered body, or `null` when the arguments did not satisfy it. */
  text: string | null;
  error?: string;
}

/**
 * Detect `/<name> args…` at the start of a message (after a leading
 * `@mention`, if any) naming a skill attached to the bot, and expand it.
 * @param db - A database handle.
 * @param botId - The bot.
 * @param message - The message text.
 * @returns The invocation, or `null` when the message invokes no attached skill.
 */
export async function expandInvocation(
  db: DbHandle,
  botId: number,
  message: string,
): Promise<SkillInvocation | null> {
  const m =
    /^\s*(?:<?@[^\s>]+>?\s+)?\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/i.exec(
      message,
    );
  if (!m) return null;
  const found = await attachedSkill(db, botId, m[1]);
  if (!found) return null;
  const args = (m[2] ?? "").trim();
  try {
    return {
      name: found.skill.name,
      version: found.version.version,
      arguments: args,
      text: renderSkill(found.version.body, found.version.arguments, args),
    };
  } catch (error) {
    if (!(error instanceof SkillArgumentError)) throw error;
    return {
      name: found.skill.name,
      version: found.version.version,
      arguments: args,
      text: null,
      error: error.message,
    };
  }
}
