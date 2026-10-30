import { and, eq } from "drizzle-orm";
import {
  type ActionParams,
  CONNECTION_TYPE,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  approvalNotFound,
  canDecide,
  decideApproval,
  serializeApproval,
} from "../../ops/ApprovalOps";
import { allowingPattern } from "../../ops/ApprovalPatternOps";
import { serializeBotMcpServer } from "../../ops/BotMcpServerOps";
import { canReadBot } from "../../ops/BotOps";
import { enqueueTick } from "../../ops/ConversationOps";
import { idInput } from "../../ops/InputOps";
import { approvals } from "../../schema/approvals";
import { botMcpServers } from "../../schema/bot_mcp_servers";
import { bots } from "../../schema/bots";
import type { Conversation } from "../../schema/conversations";
import { mcpServers } from "../../schema/mcp_servers";

/**
 * `approval:decide` — approve or deny one tool call a bot is waiting on.
 * Requires the bot's write access, or its approver tag. Approving runs
 * exactly that call, once; `alwaysAllow` also adds `server/tool` to the bot's
 * allowlist, under the same audit row. When every approval the conversation
 * waits on is decided, it wakes.
 */
export class ApprovalDecide extends AuditedAction {
  name = "approval:decide";
  description =
    "Approve or deny a tool call a bot is waiting on. Approving runs exactly that call (that tool, those arguments) once; denying tells the bot not to retry it. alwaysAllow (with approve) also lets the bot call that server/tool without asking from now on. Requires the bot's write access or its approver tag.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/approval/:approvalId",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    approvalId: idInput("The approval"),
    decision: z.enum(["approve", "deny"]).describe("approve or deny"),
    alwaysAllow: z
      .boolean()
      .optional()
      .describe(
        "With approve: also add server/tool to the bot's allowlist, so later calls run without asking",
      ),
    note: z
      .string()
      .trim()
      .max(500)
      .optional()
      .describe(
        "A sentence the bot reads with a denial, e.g. what to do instead",
      ),
    via: z
      .enum(["dashboard", "api", "cli"])
      .optional()
      .describe(
        "Where the decision was made (default api; mcp is recorded on its own)",
      ),
  });

  /**
   * @param tx - The transaction the decision, any allowlist change, and the audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The decided approval.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ApprovalDecide>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const [row] = await tx
      .select({ approval: approvals, bot: bots })
      .from(approvals)
      .innerJoin(bots, eq(bots.id, approvals.botId))
      .where(
        and(
          eq(approvals.id, params.approvalId),
          eq(approvals.projectId, params.projectId),
        ),
      )
      .limit(1);
    if (!row || !canReadBot(row.bot, tags)) throw approvalNotFound();
    if (!canDecide(row.bot, tags)) {
      throw new TypedError({
        message: `You can see this approval but not decide it: that takes write access to "${row.bot.name}"${row.bot.approverTag ? ` or the "${row.bot.approverTag}" tag` : ""}.`,
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }
    if (params.alwaysAllow && params.decision !== "approve") {
      throw new TypedError({
        message: "alwaysAllow goes with approve.",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "alwaysAllow",
      });
    }
    const via =
      connection.type === CONNECTION_TYPE.MCP ? "mcp" : (params.via ?? "api");
    const result = await decideApproval(tx, row.approval.id, {
      approve: params.decision === "approve",
      userId: connection.session?.data.userId ?? null,
      via,
      note: params.note ?? null,
    });

    let bindingBefore: unknown;
    let bindingAfter: unknown;
    if (params.alwaysAllow) {
      const [found] = await tx
        .select({ binding: botMcpServers, server: mcpServers })
        .from(botMcpServers)
        .innerJoin(mcpServers, eq(mcpServers.id, botMcpServers.mcpServerId))
        .where(
          and(
            eq(botMcpServers.botId, row.bot.id),
            eq(mcpServers.name, row.approval.server),
          ),
        )
        .for("update", { of: botMcpServers });
      if (found) {
        bindingBefore = serializeBotMcpServer(found.binding, found.server);
        const pattern = `${row.approval.server}/${row.approval.tool}`;
        const allowed = allowingPattern(
          found.binding.allowedTools,
          row.approval.server,
          row.approval.tool,
        )
          ? found.binding.allowedTools
          : [...found.binding.allowedTools, pattern];
        const [updated] = await tx
          .update(botMcpServers)
          .set({ allowedTools: allowed })
          .where(eq(botMcpServers.id, found.binding.id))
          .returning();
        bindingAfter = serializeBotMcpServer(updated, found.server);
      }
    }

    const approval = serializeApproval(result.approval);
    connection.metadata.auditBefore = {
      approval: serializeApproval(result.before),
      ...(bindingBefore ? { botMcpServer: bindingBefore } : {}),
    };
    connection.metadata.auditAfter = {
      approval,
      ...(bindingAfter ? { botMcpServer: bindingAfter } : {}),
    };
    connection.metadata.auditTargetType = "approval";
    connection.metadata.auditTargetPath = `${row.bot.slug}: ${approval.name}`;
    connection.metadata.auditMetadata = {
      approvalId: approval.id,
      decision: params.decision,
      alwaysAllow: Boolean(params.alwaysAllow),
      via,
    };
    connection.metadata.afterCommitData = { woke: result.woke };
    return { approval: { ...approval, botName: row.bot.displayName } };
  }

  /**
   * A woken conversation owes a tick.
   * @param _result - The response.
   * @param _params - The inputs.
   * @param connection - The woken conversation, if any.
   */
  async afterCommit(
    _result: unknown,
    _params: ActionParams<ApprovalDecide>,
    connection: AuditedConnection,
  ) {
    const woke = connection.metadata.afterCommitData?.woke as
      | Conversation
      | null
      | undefined;
    if (woke) await enqueueTick(woke);
  }
}
