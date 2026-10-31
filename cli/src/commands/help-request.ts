/**
 * `hypotenuse help-request` — the help inbox (`help:*`): questions bots
 * escalated to the team because nobody in their channel could answer, and a
 * person's answer to one.
 *
 * Named `help-request`, not `help`: to a person at a command line, `help`
 * means "show me the help", and `--help` already does that for every command.
 * A data command named `help` would answer `hypotenuse help bot` with a
 * refusal, and would take the name commander's own `help [command]` uses
 * should the program ever turn it on.
 */
import type { Command } from "commander";
import { resolveBotId } from "../api/resolve";
import {
  emit,
  type Paginated,
  pageFooter,
  pageQuery,
  runCommand,
  when,
  withPaging,
} from "../context";
import { readAllStdin } from "../input";
import { table } from "../output/theme";

/** Where a help request stands. */
export const HELP_STATUSES = [
  "pending",
  "answered",
  "expired",
  "cancelled",
] as const;

/** A help request as the help actions answer it. */
export interface HelpRequest {
  id: number;
  projectId: number;
  botId: number;
  botName: string;
  conversationId: number;
  question: string;
  context: string;
  urgency: "low" | "normal" | "high";
  blocking: boolean;
  status: (typeof HELP_STATUSES)[number];
  answer: string | null;
  answeredByUserId: number | null;
  expiresAt: number;
  createdAt: number;
  answeredAt: number | null;
  /** On `help:list` rows: whether the caller may answer it. */
  canAnswer?: boolean;
}

/** What `help:view` answers. */
interface HelpViewResult {
  helpRequest: HelpRequest;
  standing: { canAnswer: boolean; canCancel: boolean };
}

/**
 * Parse a help request id a person typed.
 * @param raw - What they typed.
 * @returns The id.
 * @throws {Error} When it is not a positive whole number.
 */
function helpRequestId(raw: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new Error(`A help request is named by its id; got "${raw}".`);
  }
  return Number(raw);
}

/**
 * Indent every line after the first, so multi-line text stays under its label.
 * @param text - The text.
 * @returns The indented text.
 */
function hang(text: string): string {
  return text.replace(/\n/g, "\n              ");
}

/**
 * Render a help request for a person.
 * @param r - The request.
 * @param standing - What the caller may do with it.
 * @returns The lines.
 */
function helpDetail(
  r: HelpRequest,
  standing: HelpViewResult["standing"],
): string {
  const lines = [
    `help request ${r.id} — ${r.status}`,
    `bot           ${r.botName}`,
    `question      ${hang(r.question)}`,
  ];
  if (r.context) lines.push(`context       ${hang(r.context)}`);
  lines.push(
    `urgency       ${r.urgency}${r.blocking ? ", the bot waits for it" : ""}`,
    `conversation  ${r.conversationId}`,
    `asked         ${when(r.createdAt)}`,
    `expires       ${when(r.expiresAt)}`,
  );
  if (r.answer !== null) {
    lines.push(`answer        ${hang(r.answer)}`);
    lines.push(`answered      ${when(r.answeredAt)}`);
  }
  const can = [
    standing.canAnswer ? "answer it" : "",
    standing.canCancel ? "cancel it" : "",
  ].filter(Boolean);
  lines.push(`you can       ${can.length ? can.join(", ") : "only read it"}`);
  return lines.join("\n");
}

/**
 * Register `help-request list|view|answer|cancel`.
 * @param program - The root program.
 */
export function registerHelpRequestCommands(program: Command): void {
  const help = program
    .command("help-request")
    .description(
      "Questions bots escalated to the team, and your answers: list|view|answer|cancel",
    );

  withPaging(
    help
      .command("list")
      .description("List the help inbox for bots you can read, newest first")
      .option("--status <status>", `one of ${HELP_STATUSES.join(", ")}`)
      .option("--bot <bot>", "only this bot's (id or slug)"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as { status?: string; bot?: string };
      if (
        o.status !== undefined &&
        !(HELP_STATUSES as readonly string[]).includes(o.status)
      ) {
        throw new Error(
          `--status is one of ${HELP_STATUSES.join(", ")}; got "${o.status}".`,
        );
      }
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId =
        o.bot !== undefined
          ? await resolveBotId(client, projectId, o.bot)
          : undefined;
      const result = await client.request<
        Paginated<"helpRequests", HelpRequest>
      >("GET", `/project/${projectId}/help`, {
        query: { ...pageQuery(this), status: o.status, botId },
      });
      emit(
        ctx,
        result,
        () =>
          table(
            result.helpRequests.map((r) => ({
              id: r.id,
              status: r.status,
              bot: r.botName,
              urgency: r.urgency,
              question: r.question.replace(/\s+/g, " "),
              conversation: r.conversationId,
              asked: when(r.createdAt),
              you: r.canAnswer ? "answer" : "read",
            })),
            [
              { key: "id" },
              { key: "status" },
              { key: "bot", maxWidth: 24 },
              { key: "urgency" },
              { key: "question", maxWidth: 60 },
              { key: "conversation" },
              { key: "asked" },
              { key: "you" },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  help
    .command("view")
    .description(
      "Show a help request: the question, its context, and whether you may answer",
    )
    .argument("<request>", "the help request's id")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<HelpViewResult>(
            "GET",
            `/project/${projectId}/help/${helpRequestId(raw)}`,
          );
        emit(ctx, result, () =>
          helpDetail(result.helpRequest, result.standing),
        );
      });
    });

  help
    .command("answer")
    .description(
      'Answer a help request; the bot reads "Answer from <you>: …" and carries on',
    )
    .argument("<request>", "the help request's id")
    .requiredOption(
      "--text <text>",
      "your answer, in markdown; - reads it from standard input",
    )
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as { text: string };
        const id = helpRequestId(raw);
        const answer =
          o.text === "-"
            ? (await readAllStdin()).replace(/\r?\n$/, "")
            : o.text;
        if (answer.trim() === "") throw new Error("An answer needs text.");
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<{ helpRequest: HelpRequest }>(
            "POST",
            `/project/${projectId}/help/${id}`,
            { body: { answer } },
          );
        emit(
          ctx,
          result,
          () =>
            `Answered help request ${id}; conversation ${result.helpRequest.conversationId} carries on`,
        );
      });
    });

  help
    .command("cancel")
    .description(
      "Withdraw a help request; the bot is told to carry on without it (write access to the bot)",
    )
    .argument("<request>", "the help request's id")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const id = helpRequestId(raw);
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<{ helpRequest: HelpRequest }>(
            "DELETE",
            `/project/${projectId}/help/${id}`,
          );
        emit(ctx, result, () => `Cancelled help request ${id}`);
      });
    });
}
