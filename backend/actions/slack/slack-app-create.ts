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
  generateRoutingKey,
  hashRoutingKey,
  installationUrls,
  sealCredentials,
  serializeInstallation,
} from "../../ops/InstallationOps";
import { buildSlackManifest } from "../../ops/SlackManifestOps";
import { SlackApiError, slackCall } from "../../ops/SlackOps";
import { botInstallations } from "../../schema/bot_installations";

/** What `apps.manifest.create` answers (https://api.slack.com/methods/apps.manifest.create). */
interface ManifestCreated {
  app_id: string;
  credentials: {
    client_id: string;
    client_secret: string;
    signing_secret: string;
  };
}

/**
 * `slack:app-create` — create a bot's Slack app for it, from the manifest
 * Hypotenuse generates, with an app configuration token the person pastes
 * (Slack: Your Apps → "Your App Configuration Tokens" → Generate). The token
 * is used for this one `apps.manifest.create` call and never stored. The
 * app's client and signing secrets are sealed on a pending installation with
 * a fresh routing key; installing it into the workspace is
 * `bot-installation:oauth-start`. Slack's `invalid_manifest` pointers are
 * answered verbatim, because the person is the one who can fix them.
 * Audited. Needs the bot's write access.
 */
export class SlackAppCreate extends AuditedAction {
  name = "slack:app-create";
  description =
    "Create a bot's own Slack app from its generated manifest, using a Slack app configuration token (used once, never stored). Leaves a pending Slack installation with the app's credentials sealed; then install it into the workspace with bot-installation:oauth-start. Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot/:botId/slack/app",
    method: HTTP_METHOD.PUT,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    botId: idInput("The bot"),
    configToken: secret(
      z
        .string()
        .trim()
        .regex(/^xoxe/, "An app configuration token starts with xoxe")
        .max(512),
    ).describe(
      "A Slack app configuration token (xoxe.xoxp-…), from Your Apps → Your App Configuration Tokens. Used once, never stored",
    ),
    externalWorkspaceId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[^/]+$/, "A workspace id has no slash")
      .optional()
      .describe(
        'A name for the workspace until the install sets it (default "default")',
      ),
  });

  /**
   * @param tx - The transaction the installation and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The pending installation and the app's id.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<SlackAppCreate>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const bot = await loadReadableBot(tx, params.projectId, params.botId, tags);
    assertCanWriteBot(bot, tags);
    const workspace = params.externalWorkspaceId ?? "default";
    const [existing] = await tx
      .select()
      .from(botInstallations)
      .where(
        and(
          eq(botInstallations.botId, bot.id),
          eq(botInstallations.type, "slack"),
          eq(botInstallations.externalWorkspaceId, workspace),
        ),
      )
      .for("update");
    if (existing && existing.status === "active") {
      throw new TypedError({
        message: `"${bot.name}" already has an installed Slack app here. Disconnect it first to create a new one.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "botId",
      });
    }
    const routingKey = generateRoutingKey();
    const urls = installationUrls("slack", routingKey);
    let created: ManifestCreated;
    try {
      created = await slackCall<ManifestCreated>(
        "apps.manifest.create",
        { manifest: JSON.stringify(buildSlackManifest(bot, urls)) },
        { token: params.configToken },
      );
    } catch (e) {
      throw manifestError(e);
    }
    const values = {
      config: {
        appId: created.app_id,
        clientId: created.credentials.client_id,
      },
      credentials: sealCredentials({
        clientSecret: created.credentials.client_secret,
        signingSecret: created.credentials.signing_secret,
      }),
      externalAppId: created.app_id,
      externalBotUserId: null,
      routingKeyHash: hashRoutingKey(routingKey),
      status: "pending" as const,
      lastError: null,
    };
    const [row] = existing
      ? await tx
          .update(botInstallations)
          .set({
            ...values,
            credentialVersion: existing.credentialVersion + 1,
          })
          .where(eq(botInstallations.id, existing.id))
          .returning()
      : await tx
          .insert(botInstallations)
          .values({
            ...values,
            projectId: bot.projectId,
            botId: bot.id,
            type: "slack",
            externalWorkspaceId: workspace,
            credentialVersion: 1,
            installedByUserId: connection.session?.data.userId ?? null,
          })
          .returning();
    const installation = serializeInstallation(row);
    connection.metadata.auditBefore = existing
      ? serializeInstallation(existing)
      : null;
    connection.metadata.auditAfter = installation;
    connection.metadata.auditTargetType = "bot-installation";
    connection.metadata.auditTargetPath = `${bot.slug}/slack/${workspace}`;
    connection.metadata.auditMetadata = { appId: created.app_id };
    return {
      installation,
      appId: created.app_id,
      next: `Install it into the workspace: bot-installation:oauth-start for installation ${row.id}.`,
    };
  }
}

/**
 * What a failed `apps.manifest.create` tells the person.
 * @param e - The failure.
 * @returns A validation error naming what to fix.
 */
function manifestError(e: unknown): TypedError {
  if (!(e instanceof SlackApiError)) {
    return new TypedError({
      message: `Slack could not be reached: ${e instanceof Error ? e.message : String(e)}`,
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }
  if (e.code === "invalid_manifest") {
    const errors = (e.response?.errors ?? []) as {
      message?: string;
      pointer?: string;
    }[];
    const detail = errors
      .map((x) => `${x.pointer ?? "?"}: ${x.message ?? "invalid"}`)
      .join("; ");
    return new TypedError({
      message: `Slack refused the manifest: ${detail || "invalid_manifest"}. Fix the bot's name or description and try again.`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
      key: "botId",
    });
  }
  if (e.retryable) {
    return new TypedError({
      message: `Slack is busy (${e.code}). Try again in a minute.`,
      type: ErrorType.CONNECTION_ACTION_RUN,
    });
  }
  return new TypedError({
    message: `Slack refused the app configuration token (${e.code}). Configuration tokens expire after 12 hours: generate a new one under Your Apps → Your App Configuration Tokens.`,
    type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
    key: "configToken",
  });
}
