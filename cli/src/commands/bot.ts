/**
 * `hypotenuse bot` — the selected project's bots (`bot:*`): who each is, which
 * model aliases it thinks with, and who may read and change it.
 */
import type { Command } from "commander";
import { resolveBotId } from "../api/resolve";
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
  encodeAvatar,
  parseDuration,
  parseList,
  parseNumber,
  readFileFor,
} from "../input";
import { logger } from "../output/logger";
import { table } from "../output/theme";
import { registerBotToolsCommands } from "./bot-tools";

/** A bot as the bot actions answer it. */
interface Bot {
  id: number;
  name: string;
  slug: string;
  description: string;
  displayName: string;
  avatarUrl: string | null;
  persona: string;
  modelAlias: string;
  fastModelAlias: string;
  accessRead: string[];
  accessWrite: string[];
  helpNotifyTag: string | null;
  approverTag?: string | null;
  approvalTtlSeconds?: number;
  monthlyBudgetUsd: number | null;
  maxStepsPerTurn?: number;
  memoryChannelHalfLifeDays?: number;
  memoryProjectHalfLifeDays?: number;
  enabled: boolean;
  hasCallbackSecret?: boolean;
  createdAt: number;
  updatedAt: number;
  standing?: { canWrite: boolean };
}

/** The flags `bot create` and `bot edit` share, as commander parses them. */
export interface BotFlags {
  name?: string;
  slug?: string;
  description?: string;
  displayName?: string;
  personaFile?: string;
  avatarFile?: string;
  /** `false` from `--no-avatar`. */
  avatar?: boolean;
  model?: string;
  fastModel?: string;
  read?: string;
  write?: string;
  /** A tag name, or `false` from `--no-help-tag`. */
  helpTag?: string | false;
  /** A tag name, or `false` from `--no-approver-tag`. */
  approverTag?: string | false;
  /** How long a tool-call approval waits: seconds or `24h`-style. */
  approvalTtl?: string;
  /** Dollars, or `false` from `--no-budget`. */
  budget?: string | false;
  /** The most model steps one turn may take. */
  maxSteps?: string;
  /** Days for channel memory to fade to half its weight. */
  channelHalfLife?: string;
  /** Days for project memory to fade to half its weight. */
  projectHalfLife?: string;
  enable?: boolean;
  disable?: boolean;
}

/**
 * Declare the flags `bot create` and `bot edit` share.
 * @param command - The command.
 * @returns The same command.
 */
function withBotFlags(command: Command): Command {
  return command
    .option("--slug <slug>", "the bot's slug (default: from its name)")
    .option("--description <text>", "what the bot is for, shown in lists")
    .option(
      "--display-name <name>",
      "the name platforms show (default: its name)",
    )
    .option(
      "--persona-file <path>",
      "a markdown file: who the bot is, how it speaks, what it will not do",
    )
    .option("--avatar-file <path>", "a square PNG or JPEG of at most 512 KB")
    .option(
      "--model <alias>",
      "the model alias it thinks with (default: default)",
    )
    .option(
      "--fast-model <alias>",
      "the model alias for cheap auxiliary calls (default: fast)",
    )
    .option(
      "--read <tags>",
      'comma-separated tags that may read it; "" or * is every member',
    )
    .option(
      "--write <tags>",
      'comma-separated tags that may change it; "" or * is every member',
    )
    .option(
      "--help-tag <tag>",
      "the tag whose holders it asks for help (default: the admins)",
    )
    .option("--no-help-tag", "ask the project's admins for help")
    .option(
      "--approver-tag <tag>",
      "a tag whose holders may decide its tool-call approvals, besides those who may change it",
    )
    .option(
      "--no-approver-tag",
      "only those who may change it decide its approvals",
    )
    .option(
      "--approval-ttl <duration>",
      "how long a tool-call approval waits before it expires: seconds, or 30m / 24h / 7d (1m-30d, default 24h)",
    )
    .option(
      "--budget <usd>",
      "a monthly budget in US dollars; reported model costs stop the bot at it",
    )
    .option("--no-budget", "no monthly budget")
    .option(
      "--max-steps <n>",
      "the most model steps one turn may take (1-500, default 50)",
    )
    .option(
      "--channel-half-life <days>",
      "days until its channel memory fades to half its weight (1-3650, default 30)",
    )
    .option(
      "--project-half-life <days>",
      "days until project memory fades to half its weight for it (1-3650, default 180)",
    )
    .option("--enable", "accept new conversations")
    .option("--disable", "accept no new conversations");
}

/**
 * Turn the shared flags into an action body: only the fields that were given.
 * @param flags - What commander parsed.
 * @returns The body's fields.
 * @throws {Error} For contradictory flags, a bad number, or a bad file.
 */
export function botBody(flags: BotFlags): Record<string, unknown> {
  if (flags.enable && flags.disable) {
    throw new Error("Pass --enable or --disable, not both.");
  }
  if (flags.avatarFile && flags.avatar === false) {
    throw new Error("Pass --avatar-file or --no-avatar, not both.");
  }
  const body: Record<string, unknown> = {};
  if (flags.name !== undefined) body.name = flags.name;
  if (flags.slug !== undefined) body.slug = flags.slug;
  if (flags.description !== undefined) body.description = flags.description;
  if (flags.displayName !== undefined) body.displayName = flags.displayName;
  if (flags.personaFile !== undefined) {
    body.persona = readFileFor(flags.personaFile, "--persona-file").toString(
      "utf8",
    );
  }
  if (flags.avatarFile !== undefined) {
    body.avatar = encodeAvatar(
      readFileFor(flags.avatarFile, "--avatar-file"),
      flags.avatarFile,
    );
  }
  if (flags.avatar === false) body.avatar = null;
  if (flags.model !== undefined) body.modelAlias = flags.model;
  if (flags.fastModel !== undefined) body.fastModelAlias = flags.fastModel;
  if (flags.read !== undefined) body.accessRead = parseList(flags.read);
  if (flags.write !== undefined) body.accessWrite = parseList(flags.write);
  if (flags.helpTag === false) body.helpNotifyTag = null;
  else if (flags.helpTag !== undefined) body.helpNotifyTag = flags.helpTag;
  if (flags.approverTag === false) body.approverTag = null;
  else if (flags.approverTag !== undefined) {
    body.approverTag = flags.approverTag;
  }
  if (flags.approvalTtl !== undefined) {
    body.approvalTtlSeconds = parseDuration(
      flags.approvalTtl,
      "--approval-ttl",
    );
  }
  if (flags.budget === false) body.monthlyBudgetUsd = null;
  else if (flags.budget !== undefined) {
    body.monthlyBudgetUsd = parseNumber(flags.budget, "--budget");
  }
  if (flags.maxSteps !== undefined) {
    body.maxStepsPerTurn = parseNumber(flags.maxSteps, "--max-steps");
  }
  if (flags.channelHalfLife !== undefined) {
    body.memoryChannelHalfLifeDays = parseNumber(
      flags.channelHalfLife,
      "--channel-half-life",
    );
  }
  if (flags.projectHalfLife !== undefined) {
    body.memoryProjectHalfLifeDays = parseNumber(
      flags.projectHalfLife,
      "--project-half-life",
    );
  }
  if (flags.enable) body.enabled = true;
  if (flags.disable) body.enabled = false;
  return body;
}

/**
 * An access list as a person reads it.
 * @param list - Tag names; empty means every member.
 * @returns The rendering.
 */
function accessText(list: string[]): string {
  return list.length === 0 || list.includes("*")
    ? "every member"
    : list.join(", ");
}

/**
 * A number of seconds as a person reads it.
 * @param seconds - The duration.
 * @returns e.g. `24h`, `7d`, `90m`.
 */
function ttlText(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

/**
 * Render a bot for a person.
 * @param bot - The bot.
 * @param canWrite - Whether the caller may change it.
 * @returns The lines.
 */
function botDetail(bot: Bot, canWrite: boolean): string {
  return [
    `${bot.name} (${bot.slug}, id ${bot.id})${bot.enabled ? "" : " — disabled"}`,
    `display name  ${bot.displayName}`,
    `description   ${bot.description || "-"}`,
    `models        ${bot.modelAlias} / ${bot.fastModelAlias} (fast)`,
    `read          ${accessText(bot.accessRead)}`,
    `write         ${accessText(bot.accessWrite)}`,
    `help          ${bot.helpNotifyTag ?? "the admins"}`,
    `approvals     decided by ${bot.approverTag ? `writers or the ${bot.approverTag} tag` : "those who may change it"}; wait ${ttlText(bot.approvalTtlSeconds ?? 86_400)}`,
    `budget        ${bot.monthlyBudgetUsd == null ? "-" : `$${bot.monthlyBudgetUsd}/month`}`,
    `steps/turn    ${bot.maxStepsPerTurn ?? 50}`,
    `half-life     ${bot.memoryChannelHalfLifeDays ?? 30} days channel memory, ${bot.memoryProjectHalfLifeDays ?? 180} days project memory`,
    `callbacks     ${bot.hasCallbackSecret ? "signed (secret set)" : "no secret yet"}`,
    `avatar        ${bot.avatarUrl ? "yes" : "-"}`,
    `you can       ${canWrite ? "read and change it" : "read it"}`,
    `created       ${when(bot.createdAt)}`,
    "",
    bot.persona,
  ].join("\n");
}

/**
 * Register `bot list|view|create|edit|delete|callback-secret` and `bot tools …`.
 * @param program - The root program.
 */
export function registerBotCommands(program: Command): void {
  const bot = program.command("bot").description("The selected project's bots");

  withPaging(
    bot.command("list").description("List the bots you can read"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const projectId = await ctx.projectId();
      const result = await ctx
        .signedInClient()
        .request<Paginated<"bots", Bot>>("GET", `/project/${projectId}/bots`, {
          query: pageQuery(this),
        });
      emit(
        ctx,
        result,
        () =>
          table(
            result.bots.map((b) => ({
              id: b.id,
              slug: b.slug,
              name: b.name,
              models: `${b.modelAlias} / ${b.fastModelAlias}`,
              enabled: b.enabled ? "yes" : "no",
              access: b.standing?.canWrite ? "write" : "read",
              description: b.description,
            })),
            [
              { key: "id" },
              { key: "slug" },
              { key: "name", maxWidth: 30 },
              { key: "models" },
              { key: "enabled" },
              { key: "access" },
              { key: "description", maxWidth: 40 },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  bot
    .command("view")
    .description("Show a bot, its persona, and whether you can change it")
    .argument("<bot>", "id or slug")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = await resolveBotId(client, projectId, selector);
        const result = await client.request<{
          bot: Bot;
          standing: { canWrite: boolean };
        }>("GET", `/project/${projectId}/bot/${botId}`);
        emit(ctx, result, () =>
          botDetail(result.bot, result.standing.canWrite),
        );
      });
    });

  withBotFlags(
    bot
      .command("create")
      .description("Create a bot")
      .requiredOption("--name <name>", "the bot's name"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const flags = this.opts() as BotFlags;
      if (!flags.personaFile) {
        throw new Error(
          "A bot needs a persona. Write it in a markdown file and pass --persona-file <path>.",
        );
      }
      const body = botBody(flags);
      const projectId = await ctx.projectId();
      const result = await ctx
        .signedInClient()
        .request<{ bot: Bot }>("PUT", `/project/${projectId}/bot`, { body });
      emit(
        ctx,
        result,
        () =>
          `Created ${result.bot.name} (${result.bot.slug}, id ${result.bot.id})`,
      );
    });
  });

  withBotFlags(
    bot
      .command("edit")
      .description("Change a bot; only the flags given change")
      .argument("<bot>", "id or slug")
      .option("--name <name>", "a new name")
      .option("--no-avatar", "remove the avatar"),
  ).action(async function (this: Command, selector: string) {
    await runCommand(this, async (ctx) => {
      const body = botBody(this.opts() as BotFlags);
      if (Object.keys(body).length === 0) {
        throw new Error(
          "Nothing to change. `hypotenuse bot edit --help` lists the flags.",
        );
      }
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId = await resolveBotId(client, projectId, selector);
      const result = await client.request<{ bot: Bot }>(
        "POST",
        `/project/${projectId}/bot/${botId}`,
        { body },
      );
      emit(
        ctx,
        result,
        () => `Updated ${result.bot.name} (${result.bot.slug}, id ${botId})`,
      );
    });
  });

  bot
    .command("delete")
    .description("Delete a bot")
    .argument("<bot>", "id or slug")
    .option("--yes", "confirm; required, because this cannot be undone")
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        requireYes(
          this,
          `Deleting a bot cannot be undone. Re-run with --yes to delete ${selector}.`,
        );
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = await resolveBotId(client, projectId, selector);
        const result = await client.request<{ bot: Bot }>(
          "DELETE",
          `/project/${projectId}/bot/${botId}`,
        );
        emit(ctx, result, () => `Deleted ${result.bot.name}`);
      });
    });

  bot
    .command("callback-secret")
    .description(
      "Create or replace the secret a bot signs its API callbacks with, and print it once",
    )
    .argument("<bot>", "id or slug")
    .option(
      "--yes",
      "confirm replacing an existing secret; required, because callbacks signed with it stop at once",
    )
    .action(async function (this: Command, selector: string) {
      await runCommand(this, async (ctx) => {
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const botId = await resolveBotId(client, projectId, selector);
        const current = await client.request<{ bot: Bot }>(
          "GET",
          `/project/${projectId}/bot/${botId}`,
        );
        if (current.bot.hasCallbackSecret) {
          requireYes(
            this,
            `${current.bot.name} already has a callback secret, and a new one stops callbacks signed with the old one at once. Re-run with --yes to replace it.`,
          );
        }
        const result = await client.request<{
          bot: Bot;
          standing: { canWrite: boolean };
          callbackSecret: string;
        }>("POST", `/project/${projectId}/bot/${botId}/callback-secret`);
        // The secret alone on stdout, so it can be redirected into a file.
        emit(ctx, result, () => result.callbackSecret);
        logger.tell(
          `This is ${result.bot.name}'s callback secret. Store it now: it is never shown again.`,
        );
      });
    });

  registerBotToolsCommands(bot);
}
