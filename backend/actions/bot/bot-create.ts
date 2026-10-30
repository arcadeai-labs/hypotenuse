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
  approvalTtlInput,
  approverTagInput,
  assertAliasesExist,
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
  botSlugs,
  botStanding,
  budgetColumn,
  decodeAvatar,
  halfLifeInput,
  helpNotifyTagInput,
  maxStepsPerTurnInput,
  monthlyBudgetInput,
  serializeBot,
  summarizeAvatar,
} from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import { firstFreeSlug, generateSlug } from "../../ops/SlugOps";
import { bots } from "../../schema/bots";

/**
 * `bot:create` — make a bot in a project. Member-level: a bot spends the
 * project's model budget only through the aliases an admin chose. The creator
 * must satisfy the access lists they set, so nobody makes a bot they cannot
 * open. Nothing runs yet; a bot is configuration.
 */
export class BotCreate extends AuditedAction {
  name = "bot:create";
  description =
    "Create a bot in a project: its name, persona (the identity part of its system prompt, in markdown), display name, description, model aliases (default: default and fast), who may read and edit it (tag lists), who it asks for help, who may approve its tool calls and how long an approval waits, a monthly budget, and optionally a square PNG or JPEG avatar (base64, at most 512 KB). Requires membership in the project; you must satisfy the access lists you set.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/bot", method: HTTP_METHOD.PUT };
  inputs = z.object({
    projectId: idInput("The project to create the bot in"),
    name: botNameInput,
    slug: botSlugInput
      .optional()
      .describe(
        "The bot's slug, unique in the project; generated from its name when omitted",
      ),
    description: botDescriptionInput.default(""),
    displayName: botDisplayNameInput.optional(),
    persona: botPersonaInput,
    modelAlias: botModelAliasInput.default("default"),
    fastModelAlias: botFastModelAliasInput.default("fast"),
    accessRead: accessListSchema.default([]),
    accessWrite: accessListSchema.default([]),
    helpNotifyTag: helpNotifyTagInput.default(null),
    approverTag: approverTagInput.default(null),
    approvalTtlSeconds: approvalTtlInput.default(86_400),
    monthlyBudgetUsd: monthlyBudgetInput.default(null),
    maxStepsPerTurn: maxStepsPerTurnInput.default(50),
    memoryChannelHalfLifeDays: halfLifeInput("channel").default(30),
    memoryProjectHalfLifeDays: halfLifeInput("project").default(180),
    enabled: z
      .boolean()
      .default(true)
      .describe("Whether the bot accepts new conversations"),
    avatar: avatarInput.optional(),
  });

  /**
   * @param tx - The transaction the insert and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The bot and the caller's standing on it.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` for an unknown tag
   *   or alias, a taken slug, a lockout, or a bad avatar.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<BotCreate>,
    connection: AuditedConnection,
  ) {
    const callerTags = connection.metadata.callerTags ?? [];
    await assertAccessListTags(
      tx,
      params.projectId,
      params.accessRead,
      "accessRead",
    );
    await assertAccessListTags(
      tx,
      params.projectId,
      params.accessWrite,
      "accessWrite",
    );
    assertNotLockedOut(params.accessRead, callerTags, "accessRead");
    assertNotLockedOut(params.accessWrite, callerTags, "accessWrite");
    await assertHelpTag(tx, params.projectId, params.helpNotifyTag);
    await assertHelpTag(
      tx,
      params.projectId,
      params.approverTag,
      "approverTag",
    );
    await assertAliasesExist(tx, params.projectId, {
      modelAlias: params.modelAlias,
      fastModelAlias: params.fastModelAlias,
    });
    const avatar = params.avatar ? decodeAvatar(params.avatar) : null;

    let slug = params.slug;
    if (slug) {
      await assertSlugFree(tx, params.projectId, slug);
    } else {
      slug = firstFreeSlug(
        generateSlug(params.name, "bot").slice(0, 60),
        await botSlugs(tx, params.projectId),
      );
    }

    const [bot] = await tx
      .insert(bots)
      .values({
        projectId: params.projectId,
        name: params.name,
        slug,
        description: params.description,
        displayName: params.displayName ?? params.name,
        persona: params.persona,
        modelAlias: params.modelAlias,
        fastModelAlias: params.fastModelAlias,
        accessRead: params.accessRead,
        accessWrite: params.accessWrite,
        helpNotifyTag: params.helpNotifyTag,
        approverTag: params.approverTag,
        approvalTtlSeconds: params.approvalTtlSeconds,
        monthlyBudgetUsd: budgetColumn(params.monthlyBudgetUsd),
        enabled: params.enabled,
        maxStepsPerTurn: params.maxStepsPerTurn,
        memoryChannelHalfLifeDays: params.memoryChannelHalfLifeDays,
        memoryProjectHalfLifeDays: params.memoryProjectHalfLifeDays,
        avatar: avatar?.bytes ?? null,
        avatarMimeType: avatar?.mimeType ?? null,
        createdByUserId: connection.session?.data.userId ?? null,
      })
      .returning();

    const serialized = serializeBot(bot);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "bot";
    connection.metadata.auditTargetPath = bot.slug;
    if (params.avatar !== undefined) {
      connection.metadata.auditMetadata = {
        ...scrubParams({ ...params, avatar: undefined }),
        avatar: summarizeAvatar(avatar),
      };
    }
    return { bot: serialized, standing: botStanding(bot, callerTags) };
  }
}
