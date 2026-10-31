/**
 * `hypotenuse channel` and `hypotenuse binding` — the platform channels a
 * project's bots hear from (`channel:*`), and where each bot listens
 * (`channel-binding:*`). Binding a bot is an audience decision: everyone who
 * can read the bot can read what the channel says to it, so a private channel
 * needs `--confirm-audience`, said in so many words.
 */
import type { Command } from "commander";
import { resolveBotId } from "../api/resolve";
import {
  ApiError,
  emit,
  type Paginated,
  pageFooter,
  pageQuery,
  requireYes,
  runCommand,
  when,
  withPaging,
} from "../context";
import { collect } from "../input";
import { table } from "../output/theme";

/** How a bot listens in a channel. */
export const BINDING_MODES = ["mentions", "all", "dm"] as const;

/** How a message enters a working bot's turn. */
export const BINDING_DELIVERIES = ["steer", "queue"] as const;

/** Who may decide a bot's approvals from inside a channel. */
export const APPROVAL_POLICIES = [
  "dashboard",
  "participants",
  "listed",
] as const;

/** A platform channel as the channel actions answer it. */
export interface PlatformChannel {
  id: number;
  projectId: number;
  type: string;
  name: string;
  externalId: string;
  parentExternalId: string | null;
  botInstallationId: number | null;
  isPrivate: boolean;
  isShared: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  /** With `--bot`: the bot's binding here, or null when unbound. */
  binding?: Binding | null;
}

/** A binding as the binding actions answer it. */
export interface Binding {
  id: number;
  projectId: number;
  botId: number;
  channelId: number;
  mode: (typeof BINDING_MODES)[number];
  defaultDelivery: (typeof BINDING_DELIVERIES)[number];
  approvalPolicy: (typeof APPROVAL_POLICIES)[number];
  approverExternalIds: string[];
  allowPromotion: boolean;
  allowShared: boolean;
  enabled: boolean;
  autoBound: boolean;
  createdByUserId: number | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * Parse a numeric id a person typed.
 * @param raw - What they typed.
 * @param what - What it names, for the refusal ("A channel").
 * @returns The id.
 * @throws {Error} When it is not a positive whole number.
 */
function idOf(raw: string, what: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`${what} is named by its id (a number); got "${raw}".`);
  }
  return Number(raw);
}

/**
 * A channel's privacy and sharing as a few words.
 * @param c - The channel.
 * @returns E.g. `private, shared`, or `public`.
 */
export function audienceText(
  c: Pick<PlatformChannel, "isPrivate" | "isShared" | "archived">,
): string {
  const words = [c.isPrivate ? "private" : "public"];
  if (c.isShared) words.push("shared");
  if (c.archived) words.push("archived");
  return words.join(", ");
}

/**
 * A binding's settings as one line.
 * @param b - The binding.
 * @returns E.g. `mentions, steer, approvals: dashboard`.
 */
export function bindingText(b: Binding): string {
  const parts = [
    b.enabled ? b.mode : `${b.mode} (disabled)`,
    b.defaultDelivery,
    `approvals: ${b.approvalPolicy}${b.approvalPolicy === "listed" ? ` (${b.approverExternalIds.join(", ")})` : ""}`,
  ];
  if (b.allowPromotion) parts.push("promotes");
  if (b.allowShared) parts.push("shared ok");
  if (b.autoBound) parts.push("auto-bound");
  return parts.join(", ");
}

/**
 * Check a flag's value is one of a closed list.
 * @param value - The value, if given.
 * @param allowed - The list.
 * @param flag - The flag, for the refusal.
 * @returns The value.
 * @throws {Error} When it is not in the list.
 */
function oneOf<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  flag: string,
): T | undefined {
  if (value === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${flag} is one of ${allowed.join(", ")}; got "${value}".`);
  }
  return value as T;
}

/** The binding settings a command was given. */
interface BindingFlags {
  mode?: string;
  delivery?: string;
  approvalPolicy?: string;
  approver?: string[];
  approvers?: boolean;
  allowPromotion?: boolean;
  allowShared?: boolean;
}

/**
 * Declare the settings `binding create` and `binding edit` share.
 * @param command - The command.
 * @returns The same command.
 */
function withBindingOptions(command: Command): Command {
  return command
    .option("--mode <mode>", `how the bot listens: ${BINDING_MODES.join(", ")}`)
    .option(
      "--delivery <delivery>",
      "steer: a message reaches a working bot before its next step; queue: after its turn",
    )
    .option(
      "--approval-policy <policy>",
      `who decides approvals from inside the channel: ${APPROVAL_POLICIES.join(", ")}`,
    )
    .option(
      "--approver <externalUserId>",
      "a platform user id who may decide under the listed policy (repeatable; replaces the list)",
      collect,
    )
    .option(
      "--allow-promotion",
      "let facts from this channel be promoted to project memory",
    )
    .option("--no-allow-promotion", "keep this channel's facts in the channel")
    .option(
      "--allow-shared",
      "answer even though the channel is shared with another organization",
    )
    .option("--no-allow-shared", "stay silent if the channel is shared");
}

/**
 * The body fields for the binding settings a command was given; flags not
 * given are left out, so `edit` changes only those.
 * @param o - The flags.
 * @returns The settings.
 */
function bindingBody(o: BindingFlags): Record<string, unknown> {
  return {
    mode: oneOf(o.mode, BINDING_MODES, "--mode"),
    defaultDelivery: oneOf(o.delivery, BINDING_DELIVERIES, "--delivery"),
    approvalPolicy: oneOf(
      o.approvalPolicy,
      APPROVAL_POLICIES,
      "--approval-policy",
    ),
    approverExternalIds: o.approvers === false ? [] : o.approver,
    allowPromotion: o.allowPromotion,
    allowShared: o.allowShared,
  };
}

/** The server's input names, as the flags `binding create` spells them. */
const FLAG_FOR_INPUT: Record<string, string> = {
  "confirmAudience: true": "--confirm-audience",
  "allowShared: true": "--allow-shared",
  approverExternalIds: "--approver",
};

/**
 * Say a server refusal in the command line's words: where it names an input
 * ("Pass confirmAudience: true"), name the flag instead. The refusal is
 * otherwise the server's, word for word.
 * @param error - What the request threw.
 * @returns The error to throw.
 */
export function flagWords(error: unknown): unknown {
  if (!(error instanceof ApiError)) return error;
  let message = error.message;
  for (const [input, flag] of Object.entries(FLAG_FOR_INPUT)) {
    message = message.split(input).join(flag);
  }
  return message === error.message
    ? error
    : new ApiError(
        message,
        error.status,
        error.type,
        error.detail,
        error.retryAfterMs,
      );
}

/**
 * Register `channel list|view`.
 * @param program - The root program.
 */
export function registerChannelCommands(program: Command): void {
  const channel = program
    .command("channel")
    .description(
      "The platform channels the project's bots hear from: list|view",
    );

  withPaging(
    channel
      .command("list")
      .description(
        "List platform channels, newest first; with --bot, those it is bound to or has heard from, and its binding",
      )
      .option("--bot <bot>", "only this bot's: id or slug")
      .option("--type <platform>", "only this platform, e.g. webhook"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as { bot?: string; type?: string };
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId =
        o.bot !== undefined
          ? await resolveBotId(client, projectId, o.bot)
          : undefined;
      const result = await client.request<
        Paginated<"channels", PlatformChannel>
      >("GET", `/project/${projectId}/channels`, {
        query: { ...pageQuery(this), botId, type: o.type },
      });
      emit(
        ctx,
        result,
        () =>
          table(
            result.channels.map((c) => ({
              id: c.id,
              platform: c.type,
              name: c.name,
              audience: audienceText(c),
              ...(botId !== undefined
                ? {
                    binding: c.binding
                      ? `${c.binding.id}: ${bindingText(c.binding)}`
                      : "unbound",
                  }
                : {}),
            })),
            [
              { key: "id" },
              { key: "platform" },
              { key: "name", maxWidth: 30 },
              { key: "audience" },
              ...(botId !== undefined
                ? [{ key: "binding" as const, maxWidth: 60 }]
                : []),
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  channel
    .command("view")
    .description("Show a channel and how each bot you can read is bound there")
    .argument("<channel>", "the channel's id")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx.signedInClient().request<{
          channel: PlatformChannel;
          bindings: Binding[];
        }>("GET", `/project/${projectId}/channel/${idOf(raw, "A channel")}`);
        const c = result.channel;
        emit(ctx, result, () => {
          const lines = [
            `${c.name} (channel ${c.id})`,
            `platform      ${c.type}`,
            `external id   ${c.externalId}`,
            `audience      ${audienceText(c)}`,
            `installation  ${c.botInstallationId ?? "-"}`,
            `first heard   ${when(c.createdAt)}`,
          ];
          if (result.bindings.length === 0) {
            lines.push("bindings      none you can read");
            return lines.join("\n");
          }
          return `${lines.join("\n")}\n\n${table(
            result.bindings.map((b) => ({
              binding: b.id,
              bot: b.botId,
              settings: bindingText(b),
            })),
            [{ key: "binding" }, { key: "bot" }, { key: "settings" }],
          )}`;
        });
      });
    });
}

/**
 * Register `binding list|create|edit|delete`.
 * @param program - The root program.
 */
export function registerBindingCommands(program: Command): void {
  const binding = program
    .command("binding")
    .description("Where a bot listens: list|create|edit|delete");

  withPaging(
    binding
      .command("list")
      .description("List the channels a bot is bound to, with each binding")
      .requiredOption("--bot <bot>", "the bot: id or slug"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as { bot: string };
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId = await resolveBotId(client, projectId, o.bot);
      const result = await client.request<
        Paginated<"bindings", Binding & { channel: PlatformChannel }>
      >("GET", `/project/${projectId}/bot/${botId}/channel-bindings`, {
        query: pageQuery(this),
      });
      emit(
        ctx,
        result,
        () =>
          table(
            result.bindings.map((b) => ({
              id: b.id,
              channel: `${b.channel.name} (${b.channel.id})`,
              platform: b.channel.type,
              audience: audienceText(b.channel),
              settings: bindingText(b),
            })),
            [
              { key: "id" },
              { key: "channel", maxWidth: 30 },
              { key: "platform" },
              { key: "audience" },
              { key: "settings", maxWidth: 60 },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  withBindingOptions(
    binding
      .command("create")
      .description(
        "Bind a bot to a channel so it listens there (write access to the bot)",
      )
      .requiredOption("--bot <bot>", "the bot: id or slug")
      .requiredOption("--channel <channel>", "the channel's id")
      .option(
        "--confirm-audience",
        "for a private channel: confirm everyone who can read the bot may read this channel's conversations and memory",
      ),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as BindingFlags & {
        bot: string;
        channel: string;
        confirmAudience?: boolean;
      };
      const channelId = idOf(o.channel, "A channel");
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId = await resolveBotId(client, projectId, o.bot);
      const result = await client
        .request<{ binding: Binding }>(
          "PUT",
          `/project/${projectId}/channel-binding`,
          {
            body: {
              botId,
              channelId,
              ...bindingBody(o),
              confirmAudience: o.confirmAudience || undefined,
            },
          },
        )
        .catch((error: unknown) => {
          throw flagWords(error);
        });
      const b = result.binding;
      emit(
        ctx,
        result,
        () =>
          `Bound bot ${b.botId} to channel ${b.channelId} (binding ${b.id}): ${bindingText(b)}`,
      );
    });
  });

  withBindingOptions(
    binding
      .command("edit")
      .description(
        "Change a binding: only the flags given (write access to the bot)",
      )
      .argument("<binding>", "the binding's id")
      .option("--no-approvers", "clear the listed approvers")
      .option("--enable", "listen in the channel again")
      .option("--disable", "stop listening, keeping the binding"),
  ).action(async function (this: Command, raw: string) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as BindingFlags & {
        enable?: boolean;
        disable?: boolean;
      };
      if (o.enable && o.disable) {
        throw new Error("Pass --enable or --disable, not both.");
      }
      const id = idOf(raw, "A binding");
      const projectId = await ctx.projectId();
      const result = await ctx
        .signedInClient()
        .request<{ binding: Binding }>(
          "POST",
          `/project/${projectId}/channel-binding/${id}`,
          {
            body: {
              ...bindingBody(o),
              enabled: o.enable ? true : o.disable ? false : undefined,
            },
          },
        )
        .catch((error: unknown) => {
          throw flagWords(error);
        });
      emit(ctx, result, () => `Binding ${id}: ${bindingText(result.binding)}`);
    });
  });

  binding
    .command("delete")
    .description(
      "Unbind a bot from a channel; it stops listening there (write access to the bot)",
    )
    .argument("<binding>", "the binding's id")
    .option("--yes", "confirm")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const id = idOf(raw, "A binding");
        requireYes(
          this,
          `Deleting binding ${id} stops the bot listening in that channel. Re-run with --yes.`,
        );
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<{ binding: Binding }>(
            "DELETE",
            `/project/${projectId}/channel-binding/${id}`,
          );
        emit(ctx, result, () => `Deleted binding ${id}`);
      });
    });
}
