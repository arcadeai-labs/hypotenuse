import { eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { canReadBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import {
  loadLargeResult,
  pageOf,
  serializeLargeResult,
} from "../../ops/LargeResultOps";
import { bots } from "../../schema/bots";
import { conversations } from "../../schema/conversations";

/**
 * `large-result:view` — read a stored large tool result, a page at a time.
 * Requires the read access of the bot whose conversation produced it.
 */
export class LargeResultView implements Action {
  name = "large-result:view";
  description =
    "Read a tool result that was too long to show inline (the lr_<id> a transcript names), a page of characters at a time. Requires read access to the bot whose conversation produced it.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/large-result/:largeResultId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    largeResultId: idInput("The result's number (the digits of lr_<id>)"),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("The first character (default 0)"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(200_000)
      .optional()
      .describe("How many characters (default 50000)"),
  });

  /**
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The result's metadata and one page.
   */
  async run(
    params: ActionParams<LargeResultView>,
    connection: AuditedConnection,
  ) {
    const row = await loadLargeResult(
      api.db.db,
      params.projectId,
      params.largeResultId,
    );
    const [owner] = await api.db.db
      .select({ bot: bots })
      .from(conversations)
      .innerJoin(bots, eq(bots.id, conversations.botId))
      .where(eq(conversations.id, row.conversationId));
    if (
      !owner ||
      !canReadBot(owner.bot, connection.metadata.callerTags ?? [])
    ) {
      throw new TypedError({
        message: "Large result not found in this project",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    return {
      largeResult: serializeLargeResult(row),
      page: pageOf(row, params.offset ?? 0, params.limit ?? 50_000),
    };
  }
}
