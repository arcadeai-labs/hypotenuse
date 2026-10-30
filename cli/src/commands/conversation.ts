/**
 * `hypotenuse conversation` — talk to the selected project's bots over the API
 * channel (`conversation:*`): start a conversation, send it messages, list and
 * read conversations, cancel one, and follow a transcript as the bot works.
 */
import type { Command } from "commander";
import {
  CONVERSATION_STATUS,
  type ConversationOutcome,
  type WaitingOn,
} from "../../../design/states";
import { resolveBotId } from "../api/resolve";
import {
  type CliContext,
  emit,
  type Paginated,
  pageFooter,
  pageQuery,
  runCommand,
  when,
  withPaging,
} from "../context";
import { parseNumber, readAllStdin } from "../input";
import { logger } from "../output/logger";
import {
  color,
  conversationGlyph,
  dim,
  glyph,
  table,
  truncateMiddle,
} from "../output/theme";

/** How a conversation ended, as the server names it. */
export type ServerOutcome = "completed" | "failed" | "cancelled";

/** A conversation as the conversation actions answer it. */
export interface Conversation {
  id: number;
  projectId: number;
  botId: number;
  channelId: number;
  title: string | null;
  state: "working" | "hibernating" | "waiting" | "ended";
  waitingOn: { kind: WaitingOn; at?: number } | null;
  outcome: ServerOutcome | null;
  epoch: number;
  working: boolean;
  cancelRequested: boolean;
  lastSeq: number;
  hasCallback: boolean;
  requestId: string | null;
  createdByUserId: number | null;
  lastActivityAt: number;
  createdAt: number;
  updatedAt: number;
}

/** A channel as the conversation actions answer it. */
interface Channel {
  id: number;
  type: string;
  name: string;
}

/** A conversation as `conversation:list` answers it: with its bot and channel. */
interface ListedConversation extends Conversation {
  bot: { id: number; name: string; slug: string };
  channel: Channel;
}

/** What `conversation:view` answers. */
interface ConversationViewResult {
  conversation: Conversation;
  bot: { id: number; name: string; slug: string; displayName: string };
  channel: Channel;
  standing: { canMessage: boolean; canCancel: boolean };
}

/** One transcript entry as `conversation:entries` answers it. */
export interface Entry {
  seq: number;
  kind:
    | "message"
    | "thinking"
    | "tool_call_intent"
    | "tool_result"
    | "context_update"
    | "status_change"
    | "compaction";
  role: string | null;
  content: Record<string, unknown>;
  toolName: string | null;
  interrupted: boolean;
  createdAt: number;
}

/** What `conversation:entries` answers. */
type EntriesResult = Paginated<"entries", Entry> & {
  conversation: Conversation;
};

/** The longest a tool call's arguments or a thought is shown on its one line. */
const LINE_WIDTH = 100;

/** How many entries one poll asks for. */
const ENTRIES_PAGE = 100;

/**
 * The tools that end a step by speaking: their input is what the bot said, so
 * a transcript shows it as the bot's message rather than as a tool call.
 */
const SPEAKING_TOOLS: Record<string, string> = {
  reply_and_wait: "text",
  complete: "summary",
  fail: "reason",
  ask_question: "question",
};

/**
 * The design table speaks of `complete`, the server of `completed`; the other
 * outcomes share their names.
 * @param outcome - The server's outcome.
 * @returns The design outcome.
 */
function designOutcome(outcome: ServerOutcome | null): ConversationOutcome {
  if (outcome === "completed") return "complete";
  if (outcome === "cancelled") return "cancelled";
  return "failed";
}

/**
 * A conversation's status as a person reads it: its glyph and its words.
 * @param c - The conversation (its state, what it waits on, how it ended).
 * @returns E.g. `◉ Waiting for an answer`, `✓ Complete`, `◦ Cancelled`.
 */
export function statusText(
  c: Pick<Conversation, "state" | "waitingOn" | "outcome">,
): string {
  switch (c.state) {
    case "working":
      return `${conversationGlyph({ state: "working" })} Working`;
    case "hibernating":
      return `${conversationGlyph({ state: "hibernating" })} Hibernating`;
    case "waiting": {
      const on = c.waitingOn?.kind ?? "answer";
      const words: Record<WaitingOn, string> = {
        answer: "Waiting for an answer",
        approval: "Waiting for approval",
        sandbox: "Waiting on a sandbox",
        timer: "Waiting on a timer",
      };
      const until =
        on === "timer" && c.waitingOn?.at
          ? ` until ${when(c.waitingOn.at)}`
          : "";
      return `${conversationGlyph({ state: "waiting", waitingOn: on })} ${words[on]}${until}`;
    }
    case "ended": {
      const outcome = designOutcome(c.outcome);
      return `${conversationGlyph({ state: "ended", outcome })} ${CONVERSATION_STATUS[`ended:${outcome}`].label}`;
    }
  }
}

/**
 * Indent every line after the first, so a multi-line message stays under its label.
 * @param text - The text.
 * @returns The indented text.
 */
function hang(text: string): string {
  return text.replace(/\n/g, "\n  ");
}

/**
 * One line of compact JSON for a tool's arguments.
 * @param value - The arguments.
 * @returns Them, shortened to {@link LINE_WIDTH}.
 */
function brief(value: unknown): string {
  return truncateMiddle(JSON.stringify(value ?? {}), LINE_WIDTH);
}

/**
 * Render one transcript entry for a person, or nothing. Messages are shown
 * whole; a tool call is one line; a tool's result only when it failed or was
 * interrupted; a step record (an assistant message with no text) is silent.
 * @param entry - The entry.
 * @param botName - The bot's name, to label what it said.
 * @returns The lines, or null when the entry shows nothing.
 */
export function formatEntry(entry: Entry, botName: string): string | null {
  const c = entry.content;
  const bot = color("accent", `${botName} (bot)`);
  switch (entry.kind) {
    case "message": {
      const text = String(c.text ?? "");
      if (entry.role === "assistant") {
        return text ? `${bot}: ${hang(text)}` : null;
      }
      return `${color("text-primary", "user")}: ${hang(text)}`;
    }
    case "thinking": {
      const text = String(c.text ?? "")
        .replace(/\s+/g, " ")
        .trim();
      return text
        ? dim(`  thinking: ${truncateMiddle(text, LINE_WIDTH)}`)
        : null;
    }
    case "tool_call_intent": {
      const name = entry.toolName ?? "tool";
      const input = (c.input ?? {}) as Record<string, unknown>;
      const field = SPEAKING_TOOLS[name];
      if (field && typeof input[field] === "string") {
        const said = hang(String(input[field]));
        const options = Array.isArray(input.options)
          ? `\n  ${dim(`options: ${input.options.join(" | ")}`)}`
          : "";
        return `${bot}: ${said}${options}`;
      }
      return dim(`  → ${name}(${brief(input)})`);
    }
    case "tool_result": {
      const name = entry.toolName ?? "tool";
      if (entry.interrupted) {
        return `  ${glyph("failed")} ${name} was interrupted`;
      }
      const output = c.output as {
        is_error?: unknown;
        message?: unknown;
      } | null;
      if (output && typeof output === "object" && output.is_error === true) {
        const why =
          typeof output.message === "string" ? `: ${output.message}` : "";
        return `  ${glyph("failed")} ${name} failed${truncateMiddle(why, LINE_WIDTH)}`;
      }
      return null;
    }
    case "status_change": {
      const to = String(c.to ?? "");
      const reason = c.reason ? ` (${String(c.reason)})` : "";
      const note = typeof c.text === "string" && c.text ? ` — ${c.text}` : "";
      return dim(`  · ${String(c.from ?? "")} → ${to}${reason}${note}`);
    }
    case "context_update":
      return dim("  · the bot's instructions changed");
    case "compaction":
      return dim(
        `  · earlier turns summarized${c.throughSeq != null ? ` (through #${String(c.throughSeq)})` : ""}`,
      );
    default:
      return null;
  }
}

/**
 * The message text a command was given: the flag's value, or all of standard
 * input when it is `-`.
 * @param raw - The `--text` value.
 * @returns The text.
 * @throws {Error} When it is empty.
 */
async function messageText(raw: string): Promise<string> {
  const text = raw === "-" ? (await readAllStdin()).replace(/\r?\n$/, "") : raw;
  if (text.trim() === "") {
    throw new Error(
      raw === "-"
        ? "Standard input was empty; a message needs text."
        : "A message needs text.",
    );
  }
  return text;
}

/**
 * Parse a conversation id argument.
 * @param raw - What the person typed.
 * @returns The id.
 * @throws {Error} When it is not a positive whole number.
 */
function conversationId(raw: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(
      `A conversation is named by its id (a number); got "${raw}".`,
    );
  }
  return Number(raw);
}

/** How `follow` paces itself. */
interface FollowOptions {
  /** Print entries after this seq. */
  since: number;
  /** Wait this long between polls. */
  intervalMs: number;
}

/**
 * Print a conversation's transcript as it grows, polling `conversation:entries`
 * with `since` the last seq printed, until the conversation is no longer
 * `working`; then print where it rests. Under `--json` each entry is one line
 * of JSON, and the last line is `{ conversation }`. A conversation that ended
 * failed sets exit code 1.
 * @param ctx - The context.
 * @param projectId - The project.
 * @param id - The conversation.
 * @param options - Where to start and how often to poll.
 * @returns The conversation as it rests.
 */
async function follow(
  ctx: CliContext,
  projectId: number,
  id: number,
  options: FollowOptions,
): Promise<Conversation> {
  const client = ctx.signedInClient();
  const base = `/project/${projectId}/conversation/${id}`;
  const view = await client.request<ConversationViewResult>("GET", base);
  const botName = view.bot.displayName || view.bot.name;
  let since = options.since;
  for (;;) {
    const page = await client.request<EntriesResult>("GET", `${base}/entries`, {
      query: { since, limit: ENTRIES_PAGE },
    });
    for (const entry of page.entries) {
      since = entry.seq;
      if (ctx.json) {
        console.log(JSON.stringify(entry));
      } else {
        const line = formatEntry(entry, botName);
        if (line) console.log(line);
      }
    }
    // More already written: read it before deciding anything.
    if (page.entries.length === ENTRIES_PAGE) continue;
    // The state is read before the entries, so every entry written before it
    // stopped working is on this page: nothing is lost by stopping here.
    if (page.conversation.state !== "working") {
      const rest = page.conversation;
      if (ctx.json) {
        console.log(JSON.stringify({ conversation: rest }));
      } else {
        console.log(`${statusText(rest)} — conversation ${rest.id}`);
      }
      if (rest.state === "ended" && rest.outcome === "failed") {
        process.exitCode = 1;
      }
      return rest;
    }
    await Bun.sleep(options.intervalMs);
  }
}

/**
 * Add `--interval` to a command that can follow a conversation.
 * @param command - The command.
 * @returns The same command.
 */
function withInterval(command: Command): Command {
  return command.option(
    "--interval <seconds>",
    "seconds between polls while following (default 1)",
  );
}

/**
 * The poll interval a command was given.
 * @param command - The command, which declares `--interval`.
 * @returns Milliseconds.
 * @throws {Error} For a value that is not a positive number.
 */
function intervalMs(command: Command): number {
  const raw = (command.opts() as { interval?: string }).interval;
  if (raw === undefined) return 1000;
  const seconds = parseNumber(raw, "--interval");
  if (seconds <= 0)
    throw new Error("--interval takes a positive number of seconds.");
  return Math.round(seconds * 1000);
}

/**
 * Print one result as a single line of JSON (when following, so the whole
 * output stays one JSON value per line), else as {@link emit} does.
 * @param ctx - The context.
 * @param following - Whether a follow comes after.
 * @param value - The action's answer.
 * @param human - What a person sees.
 */
function emitThen(
  ctx: CliContext,
  following: boolean,
  value: unknown,
  human: () => string,
): void {
  if (following && ctx.json) console.log(JSON.stringify(value));
  else emit(ctx, value, human);
}

/**
 * Register `conversation create|message|list|view|cancel|follow`.
 * @param program - The root program.
 */
export function registerConversationCommands(program: Command): void {
  const conversation = program
    .command("conversation")
    .description("Talk to the selected project's bots over the API");

  withInterval(
    conversation
      .command("create")
      .description(
        "Start a conversation with a bot and send it the first message",
      )
      .requiredOption("--bot <bot>", "the bot: id or slug")
      .requiredOption(
        "--text <text>",
        "the message; - reads it from standard input",
      )
      .option(
        "--channel <key>",
        'which of the bot\'s API channels — what it remembers is per channel (default "default")',
      )
      .option(
        "--callback-url <url>",
        "an https URL each of the bot's messages is POSTed to, signed with its callback secret",
      )
      .option(
        "--request-id <id>",
        "your id for this request; a retry with it starts nothing new",
      )
      .option("--title <title>", "a title shown in lists (default: none)")
      .option(
        "--follow",
        "print the transcript as the bot works, until it stops",
      ),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const flags = this.opts() as {
        bot: string;
        text: string;
        channel?: string;
        callbackUrl?: string;
        requestId?: string;
        title?: string;
        follow?: boolean;
      };
      const pace = intervalMs(this);
      const text = await messageText(flags.text);
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId = await resolveBotId(client, projectId, flags.bot);
      const result = await client.request<{
        conversation: Conversation;
        channel: Channel;
        deduped: boolean;
      }>("PUT", `/project/${projectId}/bot/${botId}/conversation`, {
        body: {
          text,
          channelKey: flags.channel,
          callbackUrl: flags.callbackUrl,
          requestId: flags.requestId,
          title: flags.title,
        },
      });
      const c = result.conversation;
      emitThen(ctx, Boolean(flags.follow), result, () =>
        result.deduped
          ? `Conversation ${c.id} already started with this --request-id: ${statusText(c)}`
          : `Started conversation ${c.id} in ${result.channel.name}: ${statusText(c)}`,
      );
      if (flags.follow) {
        await follow(ctx, projectId, c.id, { since: 0, intervalMs: pace });
      } else {
        logger.info(`Follow it: hypotenuse conversation follow ${c.id}`);
      }
    });
  });

  withInterval(
    conversation
      .command("message")
      .description("Send a message into a conversation")
      .argument("<conversation>", "the conversation's id")
      .requiredOption(
        "--text <text>",
        "the message; - reads it from standard input",
      )
      .option(
        "--queue",
        "deliver after the bot's current turn (default: before its next step)",
      )
      .option(
        "--request-id <id>",
        "your id for this request; a retry with it sends nothing new",
      )
      .option(
        "--follow",
        "print the transcript as the bot works, until it stops",
      ),
  ).action(async function (this: Command, rawId: string) {
    await runCommand(this, async (ctx) => {
      const flags = this.opts() as {
        text: string;
        queue?: boolean;
        requestId?: string;
        follow?: boolean;
      };
      const id = conversationId(rawId);
      const pace = intervalMs(this);
      const text = await messageText(flags.text);
      const projectId = await ctx.projectId();
      const result = await ctx.signedInClient().request<{
        conversation: Conversation;
        deduped: boolean;
        message: { delivery: string; delivered: boolean };
      }>("PUT", `/project/${projectId}/conversation/${id}/message`, {
        body: {
          text,
          delivery: flags.queue ? "queue" : undefined,
          requestId: flags.requestId,
        },
      });
      const c = result.conversation;
      emitThen(ctx, Boolean(flags.follow), result, () =>
        result.deduped
          ? `Already sent with this --request-id; conversation ${c.id}: ${statusText(c)}`
          : `Sent to conversation ${c.id} (${result.message.delivery}): ${statusText(c)}`,
      );
      if (flags.follow) {
        await follow(ctx, projectId, id, {
          since: c.lastSeq,
          intervalMs: pace,
        });
      }
    });
  });

  withPaging(
    conversation
      .command("list")
      .description(
        "List conversations with the bots you can read, most recent first",
      )
      .option("--bot <bot>", "only this bot's: id or slug")
      .option(
        "--state <state>",
        "only those working, hibernating, waiting, or ended",
      ),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const flags = this.opts() as { bot?: string; state?: string };
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId = flags.bot
        ? await resolveBotId(client, projectId, flags.bot)
        : undefined;
      const result = await client.request<
        Paginated<"conversations", ListedConversation>
      >("GET", `/project/${projectId}/conversations`, {
        query: { ...pageQuery(this), botId, state: flags.state },
      });
      emit(
        ctx,
        result,
        () =>
          table(
            result.conversations.map((c) => ({
              id: c.id,
              status: statusText(c),
              bot: c.bot.slug,
              channel: c.channel.name,
              title: c.title ?? "",
              active: when(c.lastActivityAt),
            })),
            [
              { key: "id" },
              { key: "status" },
              { key: "bot" },
              { key: "channel", maxWidth: 24 },
              { key: "title", maxWidth: 40 },
              { key: "active", header: "LAST ACTIVE" },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  conversation
    .command("view")
    .description("Show a conversation: its bot, channel, and state")
    .argument("<conversation>", "the conversation's id")
    .action(async function (this: Command, rawId: string) {
      await runCommand(this, async (ctx) => {
        const id = conversationId(rawId);
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<ConversationViewResult>(
            "GET",
            `/project/${projectId}/conversation/${id}`,
          );
        const c = result.conversation;
        emit(ctx, result, () =>
          [
            `${c.title ?? "(untitled)"} (conversation ${c.id})`,
            `status        ${statusText(c)}${c.cancelRequested ? " — cancelling" : ""}`,
            `bot           ${result.bot.name} (${result.bot.slug}, id ${result.bot.id})`,
            `channel       ${result.channel.name} (${result.channel.type})`,
            `turns         ${c.epoch}`,
            `entries       ${c.lastSeq}`,
            `callback      ${c.hasCallback ? "yes" : "-"}`,
            `request id    ${c.requestId ?? "-"}`,
            `started       ${when(c.createdAt)}`,
            `last active   ${when(c.lastActivityAt)}`,
          ].join("\n"),
        );
      });
    });

  conversation
    .command("cancel")
    .description("Stop a conversation: the bot stops and it ends as cancelled")
    .argument("<conversation>", "the conversation's id")
    .action(async function (this: Command, rawId: string) {
      await runCommand(this, async (ctx) => {
        const id = conversationId(rawId);
        const projectId = await ctx.projectId();
        const result = await ctx.signedInClient().request<{
          conversation: Conversation;
          result: "ended" | "requested" | "noop";
        }>("POST", `/project/${projectId}/conversation/${id}/cancel`);
        const words = {
          ended: `Cancelled conversation ${id}`,
          requested: `Cancelling conversation ${id}: the bot stops within about a second`,
          noop: `Conversation ${id} had already ended: ${statusText(result.conversation)}`,
        };
        emit(ctx, result, () => words[result.result]);
      });
    });

  withInterval(
    conversation
      .command("follow")
      .description(
        "Print a conversation's transcript, then new entries as the bot works, until it stops",
      )
      .argument("<conversation>", "the conversation's id")
      .option(
        "--since <seq>",
        "only entries after this seq (default: the whole transcript)",
      ),
  ).action(async function (this: Command, rawId: string) {
    await runCommand(this, async (ctx) => {
      const id = conversationId(rawId);
      const raw = (this.opts() as { since?: string }).since;
      const since = raw === undefined ? 0 : parseNumber(raw, "--since");
      const pace = intervalMs(this);
      const projectId = await ctx.projectId();
      await follow(ctx, projectId, id, { since, intervalMs: pace });
    });
  });
}
