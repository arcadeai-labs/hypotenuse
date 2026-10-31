import { and, eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { assertCanWriteBot, loadReadableBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import {
  generateRoutingKey,
  hashRoutingKey,
  manifestFor,
  requirePlatform,
  serializeInstallation,
} from "../../ops/InstallationOps";
import { PLATFORM_TYPES } from "../../platforms/registry";
import { botInstallations } from "../../schema/bot_installations";

/**
 * `bot-installation:manifest` — the app definition for one bot on one
 * platform workspace, with a freshly minted routing key in its URLs. The key
 * is shown in this answer only and stored as a hash; asking again for a
 * pending installation mints a new one (the old URL stops working). An
 * active installation keeps its key: disconnect it first. Audited, because
 * minting a routing key is a write. Needs the bot's write access.
 */
export class BotInstallationManifest extends AuditedAction {
  name = "bot-installation:manifest";
  description =
    "Get the app definition (manifest) for a bot on a platform, with the webhook URL the platform must deliver to. Creates a pending installation and mints its routing key, which appears in this answer only — copy the URL now. Then create the app on the platform and connect its credentials with bot-installation:connect. Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/installation/:type/manifest",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
    type: z.enum(PLATFORM_TYPES).describe("The platform, e.g. webhook"),
    externalWorkspaceId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^/]+$/, "A workspace id has no slash")
      .optional()
      .describe(
        'The platform workspace this app is for (default "default"); one installation per bot per workspace',
      ),
  });

  /**
   * @param tx - The transaction the installation and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The installation, its manifest, and the routing key's URLs.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<BotInstallationManifest>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const bot = await loadReadableBot(tx, params.projectId, params.botId, tags);
    assertCanWriteBot(bot, tags);
    requirePlatform(params.type);
    const workspace = params.externalWorkspaceId ?? "default";
    const routingKey = generateRoutingKey();
    const [existing] = await tx
      .select()
      .from(botInstallations)
      .where(
        and(
          eq(botInstallations.botId, bot.id),
          eq(botInstallations.type, params.type),
          eq(botInstallations.externalWorkspaceId, workspace),
        ),
      )
      .for("update");
    if (existing && existing.status === "active") {
      throw new TypedError({
        message: `"${bot.name}" is already connected to this ${params.type} workspace. Disconnect it first to start over with a new URL.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "type",
      });
    }
    const [row] = existing
      ? await tx
          .update(botInstallations)
          .set({
            routingKeyHash: hashRoutingKey(routingKey),
            status: "pending",
            lastError: null,
          })
          .where(eq(botInstallations.id, existing.id))
          .returning()
      : await tx
          .insert(botInstallations)
          .values({
            projectId: bot.projectId,
            botId: bot.id,
            type: params.type,
            externalWorkspaceId: workspace,
            routingKeyHash: hashRoutingKey(routingKey),
            installedByUserId: connection.session?.data.userId ?? null,
          })
          .returning();
    const installation = serializeInstallation(row);
    connection.metadata.auditBefore = existing
      ? serializeInstallation(existing)
      : null;
    connection.metadata.auditAfter = installation;
    connection.metadata.auditTargetType = "bot-installation";
    connection.metadata.auditTargetPath = `${bot.slug}/${params.type}/${workspace}`;
    return {
      installation,
      ...manifestFor(bot, params.type, routingKey),
    };
  }
}
