import { and, eq } from "drizzle-orm";
import {
  type ActionParams,
  ErrorType,
  HTTP_METHOD,
  secret,
  TypedError,
} from "keryx";
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
  openInstallation,
  requirePlatform,
  sealCredentials,
  serializeInstallation,
} from "../../ops/InstallationOps";
import { urlRefusal } from "../../ops/NetworkGuardOps";
import { PLATFORM_TYPES } from "../../platforms/registry";
import { botInstallations } from "../../schema/bot_installations";

/**
 * `bot-installation:connect` — give a pending installation the credentials
 * the platform showed (and its non-secret settings), making it active. The
 * credentials are sealed and never returned. Needs the bot's write access.
 *
 * A platform installed by OAuth (Slack) stays `pending` until its install
 * completes — or until the credentials include a bot token pasted from the
 * platform. Connecting again keeps what the install stored (the bot token)
 * unless replaced, and a changed signing secret keeps the old one as
 * `signingSecretPrevious` (Linear: `webhookSecretPrevious`), so deliveries
 * signed during the rotation verify.
 */
export class BotInstallationConnect extends AuditedAction {
  name = "bot-installation:connect";
  description =
    "Connect a bot's platform app: paste the credentials the platform showed (webhook: the signing secret both sides share; slack: clientSecret and signingSecret, and botToken if you installed the app in Slack yourself; linear: clientSecret and webhookSecret) and its settings (webhook: the delivery URL the bot's messages are POSTed to; slack: clientId and appId; linear: clientId). Activates the installation the manifest created — for slack and linear, once it is installed (bot-installation:oauth-start), or for slack given a bot token. Credentials are stored sealed and never shown again. Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/installation",
    method: HTTP_METHOD.PUT,
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
      .optional()
      .describe(
        'The workspace the manifest was minted for (default "default")',
      ),
    config: z
      .record(z.string(), z.unknown())
      .describe(
        "The platform's settings: {deliveryUrl} for webhook, {clientId, appId} for slack, {clientId} for linear",
      ),
    credentials: secret(z.record(z.string(), z.unknown())).describe(
      "The platform's secrets: {signingSecret} for webhook, {clientSecret, signingSecret, botToken?} for slack, {clientSecret, webhookSecret} for linear",
    ),
    botUserId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "The bot's own user id on the platform, which its own messages carry (so it never answers itself)",
      ),
  });

  /**
   * @param tx - The transaction the change and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The installation, without its credentials.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<BotInstallationConnect>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const bot = await loadReadableBot(tx, params.projectId, params.botId, tags);
    assertCanWriteBot(bot, tags);
    const adapter = requirePlatform(params.type);
    const workspace = params.externalWorkspaceId ?? "default";
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
    if (!existing) {
      throw new TypedError({
        message: `"${bot.name}" has no ${params.type} installation for this workspace yet. Get its manifest (bot-installation:manifest) first: that mints the URL the platform delivers to.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "type",
      });
    }
    const settings = adapter.installationSchema.safeParse(params.config);
    if (!settings.success) {
      throw new TypedError({
        message: `The ${params.type} settings are not valid: ${settings.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "config",
      });
    }
    // An OAuth platform keeps what its install stored unless it is replaced.
    const previous =
      adapter.oauth && existing.credentials
        ? openInstallation(existing).credentials
        : {};
    const merged: Record<string, unknown> = adapter.oauth
      ? { ...previous, ...params.credentials }
      : { ...params.credentials };
    // A rotated signing secret keeps verifying until the platform stops
    // using it (Slack's `signingSecret`, Linear's `webhookSecret`).
    for (const key of ["signingSecret", "webhookSecret"]) {
      if (
        adapter.oauth &&
        typeof previous[key] === "string" &&
        previous[key] !== merged[key]
      ) {
        merged[`${key}Previous`] = previous[key];
      }
    }
    const secrets = adapter.credentialSchema.safeParse(merged);
    if (!secrets.success) {
      throw new TypedError({
        message: `The ${params.type} credentials are not valid: ${secrets.error.issues.map((i) => i.message).join("; ")}`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "credentials",
      });
    }
    for (const [key, value] of Object.entries(settings.data)) {
      if (key.toLowerCase().endsWith("url") && typeof value === "string") {
        const refusal = await urlRefusal(value);
        if (refusal) {
          throw new TypedError({
            message: refusal.replace("The base URL", `The ${key}`),
            type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
            key: "config",
          });
        }
      }
    }
    const ready = adapter.readyToActivate?.(secrets.data) ?? true;
    // A pasted bot token is checked at once, and tells us the bot's own id.
    let botUserId = params.botUserId ?? existing.externalBotUserId;
    let probeError: string | null = null;
    if (adapter.oauth && ready && params.credentials.botToken !== undefined) {
      try {
        botUserId = (
          await adapter.probe({
            installation: existing,
            credentials: secrets.data,
          })
        ).externalBotUserId;
      } catch (e) {
        probeError = e instanceof Error ? e.message : String(e);
      }
    }
    const [row] = await tx
      .update(botInstallations)
      .set({
        config: adapter.oauth
          ? { ...existing.config, ...settings.data }
          : settings.data,
        credentials: sealCredentials(secrets.data),
        credentialVersion: existing.credentialVersion + 1,
        externalBotUserId:
          botUserId ?? (adapter.oauth ? null : `bot:${bot.slug}`),
        ...(typeof settings.data.appId === "string"
          ? { externalAppId: settings.data.appId }
          : {}),
        status: probeError ? "error" : ready ? "active" : "pending",
        lastError: probeError,
      })
      .where(eq(botInstallations.id, existing.id))
      .returning();
    const installation = serializeInstallation(row);
    connection.metadata.auditBefore = serializeInstallation(existing);
    connection.metadata.auditAfter = installation;
    connection.metadata.auditTargetType = "bot-installation";
    connection.metadata.auditTargetPath = `${bot.slug}/${row.type}/${row.externalWorkspaceId}`;
    return { installation };
  }
}
