/**
 * `hypotenuse approval` — tool calls bots are waiting on (`approval:*`): what
 * each would call with which arguments, and a person's decision on it. A
 * decision made here is recorded as made from the CLI.
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
import { parseNumber } from "../input";
import { table } from "../output/theme";

/** Where an approval stands. */
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "consumed",
] as const;

/** An approval as the approval actions answer it. */
interface Approval {
  id: number;
  botId: number;
  botName: string;
  conversationId: number;
  name: string;
  args: unknown;
  reason: string | null;
  status: string;
  decidedVia: string | null;
  note: string | null;
  expiresAt: number;
  decidedAt: number | null;
  createdAt: number;
  canDecide: boolean;
  requestedByName?: string | null;
  decidedByName?: string | null;
}

/**
 * An approval's arguments on one line.
 * @param args - The scrubbed arguments.
 * @returns Compact JSON.
 */
function argsText(args: unknown): string {
  return JSON.stringify(args ?? {});
}

/**
 * Render an approval for a person.
 * @param a - The approval.
 * @returns The lines.
 */
function approvalDetail(a: Approval): string {
  const lines = [
    `approval ${a.id} — ${a.status}`,
    `bot           ${a.botName}`,
    `call          ${a.name}`,
    `arguments     ${JSON.stringify(a.args ?? {}, null, 2).replace(/\n/g, "\n              ")}`,
    `conversation  ${a.conversationId}`,
    `asked by      ${a.requestedByName ?? "-"}`,
    `asked         ${when(a.createdAt)}`,
    `expires       ${when(a.expiresAt)}`,
  ];
  if (a.reason) lines.push(`reason        ${a.reason}`);
  if (a.decidedAt) {
    lines.push(
      `decided       ${when(a.decidedAt)} by ${a.decidedByName ?? "-"} via ${a.decidedVia ?? "-"}`,
    );
  }
  if (a.note) lines.push(`note          ${a.note}`);
  lines.push(`you can       ${a.canDecide ? "decide it" : "only read it"}`);
  return lines.join("\n");
}

/**
 * Parse an approval id a person typed.
 * @param raw - What they typed.
 * @returns The id.
 */
function approvalId(raw: string): number {
  const id = parseNumber(raw, "<approval>");
  if (!Number.isInteger(id) || id < 1) {
    throw new Error(`An approval is named by its id; got "${raw}".`);
  }
  return id;
}

/**
 * Register `approval list|view|approve|deny`.
 * @param program - The root program.
 */
export function registerApprovalCommands(program: Command): void {
  const approval = program
    .command("approval")
    .description(
      "Tool calls bots are waiting on, and your decisions: list|view|approve|deny",
    );

  withPaging(
    approval
      .command("list")
      .description("List approvals for bots you can read, newest first")
      .option("--status <status>", `one of ${APPROVAL_STATUSES.join(", ")}`)
      .option("--bot <bot>", "only this bot's (id or slug)")
      .option("--conversation <id>", "only this conversation's"),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as {
        status?: string;
        bot?: string;
        conversation?: string;
      };
      if (
        o.status !== undefined &&
        !(APPROVAL_STATUSES as readonly string[]).includes(o.status)
      ) {
        throw new Error(
          `--status is one of ${APPROVAL_STATUSES.join(", ")}; got "${o.status}".`,
        );
      }
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId =
        o.bot !== undefined
          ? await resolveBotId(client, projectId, o.bot)
          : undefined;
      const result = await client.request<Paginated<"approvals", Approval>>(
        "GET",
        `/project/${projectId}/approvals`,
        {
          query: {
            ...pageQuery(this),
            status: o.status,
            botId,
            conversationId:
              o.conversation !== undefined
                ? parseNumber(o.conversation, "--conversation")
                : undefined,
          },
        },
      );
      emit(
        ctx,
        result,
        () =>
          table(
            result.approvals.map((a) => ({
              id: a.id,
              status: a.status,
              bot: a.botName,
              call: a.name,
              arguments: argsText(a.args),
              conversation: a.conversationId,
              expires: a.status === "pending" ? when(a.expiresAt) : "-",
              you: a.canDecide ? "decide" : "read",
            })),
            [
              { key: "id" },
              { key: "status" },
              { key: "bot", maxWidth: 24 },
              { key: "call", maxWidth: 40 },
              { key: "arguments", maxWidth: 50 },
              { key: "conversation" },
              { key: "expires" },
              { key: "you" },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  approval
    .command("view")
    .description(
      "Show an approval: the call, its arguments, who asked, and where it stands",
    )
    .argument("<approval>", "the approval's id")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<{ approval: Approval }>(
            "GET",
            `/project/${projectId}/approval/${approvalId(raw)}`,
          );
        emit(ctx, result, () => approvalDetail(result.approval));
      });
    });

  approval
    .command("approve")
    .description(
      "Run exactly that call, once, and let the bot carry on (write access or the bot's approver tag)",
    )
    .argument("<approval>", "the approval's id")
    .option(
      "--always",
      "also let the bot make this server/tool call without asking from now on",
    )
    .option("--note <text>", "a sentence for the record")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as { always?: boolean; note?: string };
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<{ approval: Approval }>(
            "POST",
            `/project/${projectId}/approval/${approvalId(raw)}`,
            {
              body: {
                decision: "approve",
                alwaysAllow: o.always || undefined,
                note: o.note,
                via: "cli",
              },
            },
          );
        const a = result.approval;
        emit(
          ctx,
          result,
          () =>
            `Approved ${a.name} (approval ${a.id})${o.always ? `; ${a.name} no longer asks` : ""}`,
        );
      });
    });

  approval
    .command("deny")
    .description(
      "Refuse the call; the bot is told not to retry it (write access or the bot's approver tag)",
    )
    .argument("<approval>", "the approval's id")
    .option("--note <text>", "what the bot should do instead; it reads this")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const o = this.opts() as { note?: string };
        const projectId = await ctx.projectId();
        const result = await ctx
          .signedInClient()
          .request<{ approval: Approval }>(
            "POST",
            `/project/${projectId}/approval/${approvalId(raw)}`,
            { body: { decision: "deny", note: o.note, via: "cli" } },
          );
        const a = result.approval;
        emit(ctx, result, () => `Denied ${a.name} (approval ${a.id})`);
      });
    });
}
