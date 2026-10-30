/**
 * `hypotenuse skill` — the project's library of procedures (`skill:*`) and
 * which bots may use them (`bot-skill:*`). A skill is named by id or name.
 */
import type { Command } from "commander";
import type { ApiClient } from "../api/client";
import { findInPages, resolveBotId } from "../api/resolve";
import {
  emit,
  type Paginated,
  pageFooter,
  pageQuery,
  requireYes,
  runCommand,
  when,
  withPaging,
} from "../context";
import {
  bodyText,
  collect,
  parseArgSpec,
  parseList,
  parseNumber,
  type SkillArgumentSpec,
} from "../input";
import { dim, table } from "../output/theme";

/** A skill as the skill actions answer it. */
export interface Skill {
  id: number;
  name: string;
  description: string;
  arguments: (SkillArgumentSpec & { description?: string })[];
  currentVersion: number;
  accessRead: string[];
  accessWrite: string[];
  body?: string;
  canWrite?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A skill version. */
export interface SkillVersion {
  version: number;
  description: string;
  body: string;
  userId: number | null;
  changeNote: string | null;
  createdAt: number;
}

/** A skill attached to a bot. */
export interface BotSkill {
  id: number;
  botId: number;
  skillId: number;
  name: string;
  description: string;
  currentVersion: number;
  pinnedVersion: number | null;
  version: number;
}

/**
 * A skill's arguments as a person reads them: `since!, audience=customers`.
 * @param args - The arguments.
 * @returns The text, or `-`.
 */
export function argsText(args: Skill["arguments"]): string {
  if (args.length === 0) return "-";
  return args
    .map((a) =>
      a.required
        ? `${a.name}!`
        : a.default !== undefined
          ? `${a.name}=${a.default}`
          : a.name,
    )
    .join(", ");
}

/**
 * Resolve a skill id or name.
 * @param client - A signed-in client.
 * @param projectId - The project.
 * @param selector - An id, or the skill's name.
 * @returns The skill's id.
 * @throws {Error} When no skill the caller can see has that name.
 */
export async function resolveSkillId(
  client: ApiClient,
  projectId: number,
  selector: string,
): Promise<number> {
  if (/^\d+$/.test(selector)) return Number(selector);
  const match = await findInPages<Skill>(
    client,
    `/project/${projectId}/skills`,
    "skills",
    (s) => s.name === selector,
  );
  if (!match) throw new Error(`No skill named "${selector}"`);
  return match.id;
}

/** The flags `add` and `edit` share. */
interface SkillFlags {
  name?: string;
  description?: string;
  arg?: string[] | false;
  body?: string;
  bodyFile?: string;
  read?: string;
  write?: string;
  note?: string;
}

/**
 * The body `add` and `edit` send, from their flags.
 * @param o - The flags.
 * @returns The request body.
 */
async function skillBody(o: SkillFlags): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {};
  if (o.description !== undefined) body.description = o.description;
  if (o.arg === false) body.arguments = [];
  else if (o.arg !== undefined) body.arguments = o.arg.map(parseArgSpec);
  const text = await bodyText(o);
  if (text !== undefined) body.body = text;
  if (o.read !== undefined) body.accessRead = parseList(o.read);
  if (o.write !== undefined) body.accessWrite = parseList(o.write);
  if (o.note !== undefined) body.changeNote = o.note;
  return body;
}

/**
 * Add the flags `add` and `edit` share.
 * @param command - The command.
 * @returns The same command.
 */
function withSkillFlags(command: Command): Command {
  return command
    .option("--description <text>", "one line: what the skill does")
    .option(
      "--arg <spec>",
      "an argument: name, name! (required), or name=default (repeatable, in order; replaces the list)",
      collect,
    )
    .option("--no-arg", "the skill takes no arguments")
    .option(
      "--body <text>",
      "the template: markdown with $1, $ARGUMENTS, $<name> (- reads standard input)",
    )
    .option("--body-file <path>", "read the template from a file")
    .option("--read <tags>", "who may see it: tag names, comma-separated")
    .option("--write <tags>", "who may change it: tag names, comma-separated")
    .option("--note <text>", "why it changed, kept with the version");
}

/**
 * Render a skill for a person.
 * @param s - The skill.
 * @returns The text.
 */
export function renderSkill(s: Skill): string {
  return [
    `${s.name}  ${dim(`#${s.id} v${s.currentVersion}`)}`,
    s.description,
    `arguments  ${argsText(s.arguments)}`,
    `read       ${s.accessRead.join(", ") || "every member"}`,
    `write      ${s.accessWrite.join(", ") || "every member"}`,
    ...(s.body !== undefined ? ["", s.body] : []),
  ].join("\n");
}

/**
 * Register `skill list|view|versions|add|edit|remove|attach|detach`.
 * @param program - The root command.
 */
export function registerSkillCommands(program: Command): void {
  const skill = program
    .command("skill")
    .description(
      "The project's skills and which bots use them: list|view|versions|add|edit|remove|attach|detach",
    );

  withPaging(
    skill
      .command("list")
      .description(
        "List the project's skills you may see, or with --bot the ones attached to a bot",
      )
      .option("--bot <bot>", "the skills attached to this bot"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as { bot?: string };
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      if (o.bot) {
        const botId = await resolveBotId(client, projectId, o.bot);
        const result = await client.request<Paginated<"botSkills", BotSkill>>(
          "GET",
          `/project/${projectId}/bot/${botId}/skills`,
          { query: pageQuery(this) },
        );
        emit(ctx, result, () =>
          result.botSkills.length === 0
            ? "No skills attached. `hypotenuse skill attach <skill> --bot <bot>` attaches one."
            : table(
                result.botSkills.map((b) => ({
                  name: b.name,
                  version: b.pinnedVersion
                    ? `${b.version} (pinned)`
                    : `${b.version} (latest)`,
                  description: b.description,
                })),
                [
                  { key: "name", maxWidth: 30 },
                  { key: "version" },
                  { key: "description", maxWidth: 60 },
                ],
              ) + pageFooter(result.pagination),
        );
        return;
      }
      const result = await client.request<Paginated<"skills", Skill>>(
        "GET",
        `/project/${projectId}/skills`,
        { query: pageQuery(this) },
      );
      emit(ctx, result, () =>
        result.skills.length === 0
          ? "No skills. `hypotenuse skill add <name> --description <d> --body-file <path>` adds one."
          : table(
              result.skills.map((s) => ({
                id: s.id,
                name: s.name,
                version: s.currentVersion,
                arguments: argsText(s.arguments),
                description: s.description,
              })),
              [
                { key: "id" },
                { key: "name", maxWidth: 30 },
                { key: "version" },
                { key: "arguments", maxWidth: 30 },
                { key: "description", maxWidth: 50 },
              ],
            ) + pageFooter(result.pagination),
      );
    });
  });

  skill
    .command("view")
    .description("Show a skill and its template")
    .argument("<skill>", "id or name")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveSkillId(client, projectId, selector);
        const result = await client.request<{ skill: Skill }>(
          "GET",
          `/project/${projectId}/skill/${id}`,
        );
        emit(ctx, result, () => renderSkill(result.skill));
      });
    });

  withPaging(
    skill
      .command("versions")
      .description("A skill's history, newest first")
      .argument("<skill>", "id or name"),
  ).action(async function (this: Command, selector: string) {
    await runCommand(this, async (ctx) => {
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const id = await resolveSkillId(client, projectId, selector);
      const result = await client.request<Paginated<"versions", SkillVersion>>(
        "GET",
        `/project/${projectId}/skill/${id}/versions`,
        { query: pageQuery(this) },
      );
      emit(
        ctx,
        result,
        () =>
          table(
            result.versions.map((v) => ({
              version: v.version,
              by: `user ${v.userId ?? "-"}`,
              when: when(v.createdAt),
              note: v.changeNote ?? "",
            })),
            [
              { key: "version" },
              { key: "by" },
              { key: "when" },
              { key: "note", maxWidth: 60 },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  withSkillFlags(
    skill
      .command("add")
      .description("Add a skill to the project's library")
      .argument(
        "<name>",
        "what /<name> and use_skill call: lowercase-with-hyphens",
      ),
  ).action(async function (this: Command, name: string) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as SkillFlags;
      if (!o.description) throw new Error("A skill needs --description.");
      const body = await skillBody(o);
      if (body.body === undefined) {
        throw new Error("A skill needs --body or --body-file.");
      }
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const result = await client.request<{ skill: Skill }>(
        "PUT",
        `/project/${projectId}/skill`,
        { body: { name, ...body } },
      );
      emit(
        ctx,
        result,
        () => `Added skill ${result.skill.name} (#${result.skill.id})`,
      );
    });
  });

  withSkillFlags(
    skill
      .command("edit")
      .description(
        "Change a skill; a new description, arguments, or body is a new version",
      )
      .argument("<skill>", "id or name")
      .option("--name <name>", "rename it"),
  ).action(async function (this: Command, selector: string) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as SkillFlags;
      const body = await skillBody(o);
      if (o.name !== undefined) body.name = o.name;
      if (Object.keys(body).length === 0) throw new Error("Nothing to change.");
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const id = await resolveSkillId(client, projectId, selector);
      const result = await client.request<{ skill: Skill }>(
        "POST",
        `/project/${projectId}/skill/${id}`,
        { body },
      );
      emit(
        ctx,
        result,
        () =>
          `${result.skill.name} is at version ${result.skill.currentVersion}`,
      );
    });
  });

  skill
    .command("remove")
    .description("Delete a skill; every bot it was attached to loses it")
    .argument("<skill>", "id or name")
    .option("--yes", "confirm")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        requireYes(this, "Deleting a skill needs --yes.");
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const id = await resolveSkillId(client, projectId, selector);
        const result = await client.request<{ skill: Skill }>(
          "DELETE",
          `/project/${projectId}/skill/${id}`,
        );
        emit(ctx, result, () => `Deleted skill ${result.skill.name}`);
      });
    });

  skill
    .command("attach")
    .description(
      "Let a bot use a skill, at its latest version or --pin one (attaching again changes the pin)",
    )
    .argument("<skill>", "id or name")
    .requiredOption("--bot <bot>", "the bot's id or slug")
    .option("--pin <version>", "use this version, even after the skill changes")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as { bot: string; pin?: string };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = await resolveBotId(client, projectId, o.bot);
        const skillId = await resolveSkillId(client, projectId, selector);
        const result = await client.request<{ botSkill: BotSkill }>(
          "PUT",
          `/project/${projectId}/bot/${botId}/skill`,
          {
            body: {
              skillId,
              pinnedVersion:
                o.pin === undefined ? null : parseNumber(o.pin, "--pin"),
            },
          },
        );
        const b = result.botSkill;
        emit(
          ctx,
          result,
          () =>
            `Attached ${b.name} at version ${b.version}${b.pinnedVersion ? " (pinned)" : " (follows the latest)"}`,
        );
      });
    });

  skill
    .command("detach")
    .description("Take a skill away from a bot")
    .argument("<skill>", "id or name")
    .requiredOption("--bot <bot>", "the bot's id or slug")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as { bot: string };
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = await resolveBotId(client, projectId, o.bot);
        const skillId = await resolveSkillId(client, projectId, selector);
        const result = await client.request<{ botSkill: BotSkill }>(
          "DELETE",
          `/project/${projectId}/bot/${botId}/skill/${skillId}`,
        );
        emit(ctx, result, () => `Detached ${result.botSkill.name}`);
      });
    });
}
