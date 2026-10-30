import { and, eq } from "drizzle-orm";
import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  approvalNotFound,
  canDecide,
  serializeApproval,
} from "../../ops/ApprovalOps";
import { canReadBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import { approvals } from "../../schema/approvals";
import { bots } from "../../schema/bots";
import { users } from "../../schema/users";

/**
 * `approval:view` — one approval. A missing one and one whose bot the caller
 * cannot read are the same 404. Requires membership.
 */
export class ApprovalView implements Action {
  name = "approval:view";
  description =
    "View one tool-call approval: the bot, the server/tool and its scrubbed arguments, the conversation, who asked, its status, who decided and how, and whether you may decide it. Requires membership and the bot's read access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/approval/:approvalId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    approvalId: idInput("The approval"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The approval.
   */
  async run(params: ActionParams<ApprovalView>, connection: AuditedConnection) {
    const tags = connection.metadata.callerTags ?? [];
    const [row] = await api.db.db
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
    const names = async (id: number | null) =>
      id
        ? ((
            await api.db.db
              .select({ name: users.name })
              .from(users)
              .where(eq(users.id, id))
          )[0]?.name ?? null)
        : null;
    return {
      approval: {
        ...serializeApproval(row.approval),
        botName: row.bot.displayName,
        requestedByName: await names(row.approval.requestedByUserId),
        decidedByName: await names(row.approval.decidedByUserId),
        canDecide: canDecide(row.bot, tags),
      },
    };
  }
}
