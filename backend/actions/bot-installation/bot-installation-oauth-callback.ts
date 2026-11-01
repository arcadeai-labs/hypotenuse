import { and, eq, ne } from "drizzle-orm";
import {
  type ActionParams,
  config,
  ErrorType,
  HTTP_METHOD,
  RateLimitMiddleware,
  secret,
  TypedError,
} from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/frontend";
import {
  installationUrls,
  loadInstallation,
  openInstallation,
  requirePlatform,
  sealCredentials,
  serializeInstallation,
  takeInstall,
} from "../../ops/InstallationOps";
import { botInstallations } from "../../schema/bot_installations";
import { bots } from "../../schema/bots";

/**
 * `bot-installation:oauth-callback` — the platform sends the person's browser
 * back here after they approve an install. The `state` names the install
 * (once, for ten minutes), so no session is needed: the person who started
 * it is the actor. The code is exchanged for the bot token, which is checked
 * and sealed; the installation records the workspace and the bot's own id
 * and becomes `active`; the browser lands on the bot's page. Audited as the
 * person's install. A browser hop, never an MCP tool.
 */
export class BotInstallationOauthCallback extends AuditedAction {
  name = "bot-installation:oauth-callback";
  description =
    "Where a platform (Slack, Linear) returns after a person installs a bot's app. Exchanges the code for the bot token, stores it encrypted, and redirects to the dashboard.";
  middleware = [RateLimitMiddleware];
  web = { route: "/installation/oauth/callback", method: HTTP_METHOD.GET };
  inputs = z.object({
    state: secret(z.string().min(8).max(512)).describe("The install's state"),
    code: secret(z.string().min(1).max(4096))
      .optional()
      .describe("The authorization code"),
    error: z.string().max(200).optional().describe("Why the install failed"),
  });

  /**
   * @param tx - The transaction the token and the audit row share.
   * @param params - The inputs.
   * @param connection - The browser's connection.
   * @returns A redirect to the bot's page.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` for an unknown state.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<BotInstallationOauthCallback>,
    connection: AuditedConnection,
  ) {
    const pending = await takeInstall(params.state);
    if (!pending) {
      throw new TypedError({
        message:
          "This install link expired or was already used. Start the install again from the bot's Channels section.",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "state",
      });
    }
    const existing = await loadInstallation(
      tx,
      pending.projectId,
      pending.installationId,
    );
    const adapter = requirePlatform(existing.type);
    const [bot] = await tx
      .select({ slug: bots.slug })
      .from(bots)
      .where(eq(bots.id, existing.botId));
    connection.metadata.auditUserId = pending.userId;
    connection.metadata.auditProjectId = pending.projectId;
    connection.metadata.auditTargetType = "bot-installation";
    connection.metadata.auditTargetPath = `${bot?.slug ?? existing.botId}/${existing.type}`;
    connection.metadata.auditBefore = serializeInstallation(existing);

    let failure: string | null = params.error
      ? `${adapter.label} did not install the app: ${params.error}.`
      : !params.code
        ? "The install returned no code."
        : !adapter.oauth
          ? `A ${adapter.label} app is not installed by OAuth.`
          : null;
    let row = existing;
    if (!failure && params.code && adapter.oauth) {
      try {
        const inst = openInstallation(existing);
        const got = await adapter.oauth.exchange(
          inst,
          params.code,
          installationUrls(existing.type, "").oauthRedirect,
          pending.codeVerifier,
        );
        // The workspace becomes the installation's on its first install; a
        // reinstall must land in the same one, or channels would split.
        const workspace =
          existing.status === "active"
            ? existing.externalWorkspaceId
            : got.externalWorkspaceId;
        if (
          existing.status === "active" &&
          got.externalWorkspaceId !== existing.externalWorkspaceId
        ) {
          throw new Error(
            `This app is already installed in workspace ${existing.externalWorkspaceId}; it was just installed into ${got.externalWorkspaceId}. A bot needs its own app per workspace.`,
          );
        }
        const [clash] = await tx
          .select({ id: botInstallations.id })
          .from(botInstallations)
          .where(
            and(
              eq(botInstallations.botId, existing.botId),
              eq(botInstallations.type, existing.type),
              eq(botInstallations.externalWorkspaceId, workspace),
              ne(botInstallations.id, existing.id),
            ),
          );
        if (clash) {
          throw new Error(
            `This bot already has another ${adapter.label} installation (${clash.id}) in that workspace. Disconnect one of them.`,
          );
        }
        [row] = await tx
          .update(botInstallations)
          .set({
            credentials: sealCredentials({
              ...inst.credentials,
              ...got.credentials,
            }),
            credentialVersion: existing.credentialVersion + 1,
            config: { ...existing.config, ...got.config },
            externalWorkspaceId: workspace,
            externalBotUserId: got.externalBotUserId,
            externalAppId: got.externalAppId ?? existing.externalAppId,
            status: "active",
            lastError: null,
            installedByUserId: pending.userId,
          })
          .where(eq(botInstallations.id, existing.id))
          .returning();
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      }
    }
    if (failure) {
      [row] = await tx
        .update(botInstallations)
        .set({ lastError: failure.slice(0, 1000) })
        .where(eq(botInstallations.id, existing.id))
        .returning();
    }
    connection.metadata.auditAfter = serializeInstallation(row);
    connection.metadata.auditMetadata = {
      installationId: row.id,
      installed: !failure,
      ...(failure ? { error: failure.slice(0, 300) } : {}),
    };
    const target = new URL(
      `${config.frontend.url.replace(/\/+$/, "")}/bots/${existing.botId}`,
    );
    target.searchParams.set("installation", String(row.id));
    if (failure) target.searchParams.set("installError", failure.slice(0, 300));
    else target.searchParams.set("installed", existing.type);
    return new Response(null, {
      status: 302,
      headers: { location: target.toString() },
    });
  }
}
