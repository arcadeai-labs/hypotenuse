/**
 * `hypotenuse inbox` — everything in the selected project waiting on a person
 * (`inbox:list`): pending approvals, help requests, and questions sandbox
 * jobs asked. Answer each with `approval decide`, `help-request answer`, or
 * `sandbox answer`.
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
import { table } from "../output/theme";

/** The kinds the inbox holds. */
export const INBOX_KINDS = ["approval", "help", "sandbox-question"] as const;

/** One inbox item as `inbox:list` answers it. */
export interface InboxItem {
  kind: (typeof INBOX_KINDS)[number];
  id: number;
  bot: { id: number; name: string; displayName: string };
  conversationId: number | null;
  jobId: number | null;
  title: string;
  detail: string | null;
  createdAt: number;
  expiresAt: number | null;
  canAnswer: boolean;
}

/**
 * Register `inbox list`.
 * @param program - The root command.
 */
export function registerInboxCommands(program: Command): void {
  const inbox = program
    .command("inbox")
    .description(
      "What waits on a person: approvals, help requests, and sandbox questions",
    );

  withPaging(
    inbox
      .command("list")
      .description(
        "List pending approvals, help requests, and sandbox questions, newest first",
      )
      .option("--kind <kind>", `only one kind: ${INBOX_KINDS.join(", ")}`)
      .option("--bot <bot>", "only this bot's: id or slug"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const flags = this.opts() as { kind?: string; bot?: string };
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId = flags.bot
        ? await resolveBotId(client, projectId, flags.bot)
        : undefined;
      const result = await client.request<Paginated<"items", InboxItem>>(
        "GET",
        `/project/${projectId}/inbox`,
        { query: { ...pageQuery(this), kind: flags.kind, botId } },
      );
      emit(
        ctx,
        result,
        () =>
          table(
            result.items.map((i) => ({
              kind: i.kind,
              id: i.id,
              bot: i.bot.name,
              conversation: i.conversationId ?? "",
              what: i.title,
              you: i.canAnswer ? "can answer" : "-",
              asked: when(i.createdAt),
            })),
            [
              { key: "kind" },
              { key: "id" },
              { key: "bot" },
              { key: "conversation" },
              { key: "what", maxWidth: 48 },
              { key: "you", header: "YOU" },
              { key: "asked" },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });
}
