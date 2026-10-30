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
  botStanding,
  loadReadableBot,
  serializeBot,
} from "../../ops/BotOps";
import { encryptSecret } from "../../ops/CryptoOps";
import { idInput } from "../../ops/InputOps";
import { generateCallbackSecret } from "../../ops/OutboxOps";
import { botPersona } from "../../ops/PromptSectionOps";
import { bots } from "../../schema/bots";

/**
 * `bot:rotate-callback-secret` — make a new secret for signing the API
 * channel's callbacks, replacing any old one at once. The plaintext is in
 * this answer and nowhere else, ever: it is sealed at rest, never serialized,
 * and the audit row records only that it changed. Requires membership and the
 * bot's write access.
 */
export class BotRotateCallbackSecret extends AuditedAction {
  name = "bot:rotate-callback-secret";
  description =
    "Create (or replace) the secret a bot signs its API callbacks with, and return it once: store it where your receiver can read it, since it is never shown again. Callbacks signed with the old secret stop at once. Requires membership and write access to the bot.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/callback-secret",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
  });

  /**
   * @param tx - The transaction the new secret and its audit row share.
   * @param params - The project and bot.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The bot and the new secret, shown once.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`; `CONNECTION_CHANNEL_AUTHORIZATION`.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<BotRotateCallbackSecret>,
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
    const persona = await botPersona(tx, bot.id);
    connection.metadata.auditBefore = serializeBot(bot, persona);
    const callbackSecret = generateCallbackSecret();
    const [updated] = await tx
      .update(bots)
      .set({ apiCallbackSecret: encryptSecret(callbackSecret) })
      .where(eq(bots.id, bot.id))
      .returning();
    const serialized = serializeBot(updated, persona);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "bot";
    connection.metadata.auditTargetPath = updated.slug;
    return {
      bot: serialized,
      standing: botStanding(updated, callerTags),
      callbackSecret,
    };
  }
}
