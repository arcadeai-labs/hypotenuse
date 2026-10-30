import { eq } from "drizzle-orm";
import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { accessListSchema, assertAccessListTags } from "../../ops/AccessOps";
import { scrubParams } from "../../ops/AuditOps";
import {
  assertAliasesExist,
  assertCanWriteBot,
  assertHelpTag,
  assertNotLockedOut,
  assertSlugFree,
  avatarInput,
  botDescriptionInput,
  botDisplayNameInput,
  botFastModelAliasInput,
  botModelAliasInput,
  botNameInput,
  botPersonaInput,
  botSlugInput,
  botStanding,
  budgetColumn,
  decodeAvatar,
  halfLifeInput,
  helpNotifyTagInput,
  loadReadableBot,
  maxStepsPerTurnInput,
  monthlyBudgetInput,
  serializeBot,
  summarizeAvatar,
} from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import { bots, type NewBot } from "../../schema/bots";

/**
 * `bot:edit` — change a bot. Requires membership and the bot's write list
 * (`canWriteBot`). Only the fields sent change. An avatar arrives as base64 and
 * its bytes never reach the audit row — only their size, type, and digest.
 */
export class BotEdit extends AuditedAction {
  name = "bot:edit";
  description =
    "Edit a bot: any of its name, slug, description, display name, persona, model aliases, access lists, help tag, monthly budget, enabled flag, or avatar (a square PNG or JPEG, base64, at most 512 KB; null removes it). Only the fields sent change. Requires membership and the bot's write access; you cannot save access lists that would lock you out unless you are an admin.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/bot/:botId", method: HTTP_METHOD.POST };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot to edit"),
    name: botNameInput.optional(),
    slug: botSlugInput.optional(),
    description: botDescriptionInput.optional(),
    displayName: botDisplayNameInput.optional(),
    persona: botPersonaInput.optional(),
    modelAlias: botModelAliasInput.optional(),
    fastModelAlias: botFastModelAliasInput.optional(),
    accessRead: accessListSchema.optional(),
    accessWrite: accessListSchema.optional(),
    helpNotifyTag: helpNotifyTagInput.optional(),
    monthlyBudgetUsd: monthlyBudgetInput.optional(),
    maxStepsPerTurn: maxStepsPerTurnInput.optional(),
    memoryChannelHalfLifeDays: halfLifeInput("channel").optional(),
    memoryProjectHalfLifeDays: halfLifeInput("project").optional(),
    enabled: z
      .boolean()
      .optional()
      .describe("Whether the bot accepts new conversations"),
    avatar: avatarInput.optional(),
  });

  /**
   * @param tx - The transaction the update and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The bot and the caller's standing on it.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` for a bot the caller cannot
   *   read; `CONNECTION_CHANNEL_AUTHORIZATION` for one they cannot write;
   *   `CONNECTION_ACTION_PARAM_VALIDATION` for a bad field or a lockout.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<BotEdit>,
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
    connection.metadata.auditBefore = serializeBot(bot);

    if (params.accessRead !== undefined) {
      await assertAccessListTags(
        tx,
        params.projectId,
        params.accessRead,
        "accessRead",
      );
      assertNotLockedOut(params.accessRead, callerTags, "accessRead");
    }
    if (params.accessWrite !== undefined) {
      await assertAccessListTags(
        tx,
        params.projectId,
        params.accessWrite,
        "accessWrite",
      );
      assertNotLockedOut(params.accessWrite, callerTags, "accessWrite");
    }
    if (params.helpNotifyTag !== undefined) {
      await assertHelpTag(tx, params.projectId, params.helpNotifyTag);
    }
    await assertAliasesExist(tx, params.projectId, {
      modelAlias: params.modelAlias,
      fastModelAlias: params.fastModelAlias,
    });
    if (params.slug !== undefined && params.slug !== bot.slug) {
      await assertSlugFree(tx, params.projectId, params.slug, bot.id);
    }
    const avatar = params.avatar ? decodeAvatar(params.avatar) : null;

    const changes: Partial<NewBot> = {};
    for (const key of [
      "name",
      "slug",
      "description",
      "displayName",
      "persona",
      "modelAlias",
      "fastModelAlias",
      "accessRead",
      "accessWrite",
      "helpNotifyTag",
      "enabled",
      "maxStepsPerTurn",
      "memoryChannelHalfLifeDays",
      "memoryProjectHalfLifeDays",
    ] as const) {
      if (params[key] !== undefined) {
        (changes as Record<string, unknown>)[key] = params[key];
      }
    }
    if (params.monthlyBudgetUsd !== undefined) {
      changes.monthlyBudgetUsd = budgetColumn(params.monthlyBudgetUsd);
    }
    if (params.avatar !== undefined) {
      changes.avatar = avatar?.bytes ?? null;
      changes.avatarMimeType = avatar?.mimeType ?? null;
    }

    const [updated] =
      Object.keys(changes).length > 0
        ? await tx
            .update(bots)
            .set(changes)
            .where(eq(bots.id, bot.id))
            .returning()
        : [bot];

    const serialized = serializeBot(updated);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "bot";
    connection.metadata.auditTargetPath = updated.slug;
    if (params.avatar !== undefined) {
      connection.metadata.auditMetadata = {
        ...scrubParams({ ...params, avatar: undefined }),
        avatar: summarizeAvatar(avatar),
      };
    }
    return { bot: serialized, standing: botStanding(updated, callerTags) };
  }
}
