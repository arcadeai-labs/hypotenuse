import { eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
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
  approvalTtlInput,
  approverTagInput,
  assertAliasesExist,
  assertCanWriteBot,
  assertCodeLimits,
  assertHelpTag,
  assertNotLockedOut,
  assertSlugFree,
  autoBindInput,
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
  codeLimitsInput,
  codeModeEnabledInput,
  decodeAvatar,
  halfLifeInput,
  helpNotifyTagInput,
  loadReadableBot,
  maxAgentSectionsInput,
  maxStepsPerTurnInput,
  monthlyBudgetInput,
  promptBudgetInput,
  rateLimitInput,
  serializeBot,
  summarizeAvatar,
} from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import {
  alwaysTokensAfter,
  botPersona,
  lockIdentitySection,
  overBudgetMessage,
  writeSectionVersion,
} from "../../ops/PromptSectionOps";
import { botInstallations } from "../../schema/bot_installations";
import { bots, type NewBot } from "../../schema/bots";

/**
 * `bot:edit` — change a bot. Requires membership and the bot's write list
 * (`canWriteBot`). Only the fields sent change. An avatar arrives as base64 and
 * its bytes never reach the audit row — only their size, type, and digest.
 */
export class BotEdit extends AuditedAction {
  name = "bot:edit";
  description =
    "Edit a bot: any of its name, slug, description, display name, persona (its Identity prompt section; a change is a new version), model aliases, access lists, help tag, approver tag, approval expiry, monthly budget, prompt budget, how many sections it may create itself, code mode and its limits (which may only lower the deployment's), enabled flag, or avatar (a square PNG or JPEG, base64, at most 512 KB; null removes it). Only the fields sent change. Requires membership and the bot's write access; you cannot save access lists that would lock you out unless you are an admin.";
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
    approverTag: approverTagInput.optional(),
    approvalTtlSeconds: approvalTtlInput.optional(),
    monthlyBudgetUsd: monthlyBudgetInput.optional(),
    maxStepsPerTurn: maxStepsPerTurnInput.optional(),
    promptBudgetTokens: promptBudgetInput.optional(),
    maxAgentSections: maxAgentSectionsInput.optional(),
    codeModeEnabled: codeModeEnabledInput.optional(),
    codeLimits: codeLimitsInput.optional(),
    memoryChannelHalfLifeDays: halfLifeInput("channel").optional(),
    memoryProjectHalfLifeDays: halfLifeInput("project").optional(),
    enabled: z
      .boolean()
      .optional()
      .describe("Whether the bot accepts new conversations"),
    avatar: avatarInput.optional(),
    autoBind: autoBindInput.optional(),
    participantRateLimit: rateLimitInput("one platform person").optional(),
    channelRateLimit: rateLimitInput("one channel").optional(),
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
    const personaBefore = await botPersona(tx, bot.id);
    connection.metadata.auditBefore = serializeBot(bot, personaBefore);

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
    if (params.approverTag !== undefined) {
      await assertHelpTag(
        tx,
        params.projectId,
        params.approverTag,
        "approverTag",
      );
    }
    await assertAliasesExist(tx, params.projectId, {
      modelAlias: params.modelAlias,
      fastModelAlias: params.fastModelAlias,
    });
    if (params.slug !== undefined && params.slug !== bot.slug) {
      await assertSlugFree(tx, params.projectId, params.slug, bot.id);
      // Every platform app generated for the bot embeds its slug.
      const [installed] = await tx
        .select({ id: botInstallations.id })
        .from(botInstallations)
        .where(eq(botInstallations.botId, bot.id))
        .limit(1);
      if (installed) {
        throw new TypedError({
          message: `"${bot.name}" has platform apps whose manifests embed its slug, so the slug cannot change. Disconnect them first.`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "slug",
        });
      }
    }
    if (params.codeLimits !== undefined) assertCodeLimits(params.codeLimits);
    const avatar = params.avatar ? decodeAvatar(params.avatar) : null;

    const changes: Partial<NewBot> = {};
    for (const key of [
      "name",
      "slug",
      "description",
      "displayName",
      "modelAlias",
      "fastModelAlias",
      "accessRead",
      "accessWrite",
      "helpNotifyTag",
      "approverTag",
      "approvalTtlSeconds",
      "enabled",
      "maxStepsPerTurn",
      "promptBudgetTokens",
      "maxAgentSections",
      "codeModeEnabled",
      "codeLimits",
      "memoryChannelHalfLifeDays",
      "memoryProjectHalfLifeDays",
      "autoBind",
      "participantRateLimit",
      "channelRateLimit",
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

    let persona = personaBefore;
    if (params.persona !== undefined && params.persona !== personaBefore) {
      const identity = await lockIdentitySection(tx, bot.id);
      if (identity) {
        await writeSectionVersion(tx, identity, {
          body: params.persona,
          source: "person",
          userId: connection.session?.data.userId ?? null,
          changeNote: "Persona edited",
        });
      }
      persona = params.persona;
    }
    if (
      params.persona !== undefined ||
      params.promptBudgetTokens !== undefined
    ) {
      const { tokens, budget } = await alwaysTokensAfter(tx, updated);
      if (tokens > budget) {
        throw new TypedError({
          message: overBudgetMessage(updated.name, tokens, budget),
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        });
      }
    }

    const serialized = serializeBot(updated, persona);
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
