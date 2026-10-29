import { eq } from "drizzle-orm";
import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  assertCanWriteBot,
  loadReadableBot,
  serializeBot,
} from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import { bots } from "../../schema/bots";

/**
 * `bot:delete` — delete a bot. Requires membership and the bot's write list.
 */
export class BotDelete extends AuditedAction {
  name = "bot:delete";
  description =
    "Delete a bot from a project. Requires membership and the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/bot/:botId", method: HTTP_METHOD.DELETE };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot to delete"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - `projectId` and `botId`.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The deleted bot.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` for a bot the caller cannot
   *   read; `CONNECTION_CHANNEL_AUTHORIZATION` for one they cannot write.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<BotDelete>,
    connection: AuditedConnection,
  ) {
    const callerTags = connection.metadata.callerTags ?? [];
    const bot = await loadReadableBot(
      tx,
      params.projectId,
      params.botId,
      callerTags,
      { lock: true },
    );
    assertCanWriteBot(bot, callerTags);

    await tx.delete(bots).where(eq(bots.id, bot.id));
    const serialized = serializeBot(bot);
    connection.metadata.auditBefore = serialized;
    connection.metadata.auditTargetType = "bot";
    connection.metadata.auditTargetPath = bot.slug;
    return { bot: serialized };
  }
}
