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
import { assertCanWriteBot, loadReadableBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import {
  installationNotFound,
  installationUrls,
  loadInstallation,
  openInstallation,
  requirePlatform,
  startInstall,
} from "../../ops/InstallationOps";

/**
 * `bot-installation:oauth-start` — the first hop of installing a bot's
 * platform app into a workspace by OAuth (Slack's `oauth/v2/authorize`). It
 * mints a single-use `state` bound to the installation and the person (in
 * Redis, for ten minutes) and sends the browser to the platform, or with
 * `format=json` answers the URL. Writes no row, so it is not audited: the
 * callback that completes the install is. A browser hop, never an MCP tool.
 * Needs the bot's write access.
 */
export class BotInstallationOauthStart implements Action {
  name = "bot-installation:oauth-start";
  description =
    "Begin installing a bot's platform app (Slack) into a workspace: redirects the browser to the platform's install page (or, with format json, answers its URL). The app must be created and its client credentials connected first. Needs the bot's write access.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/bot-installation/:installationId/oauth",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    installationId: idInput("The installation to install"),
    format: z
      .enum(["redirect", "json"])
      .optional()
      .describe(
        "redirect (the default) sends the browser on; json answers the URL",
      ),
  });

  /**
   * @param params - The inputs.
   * @param connection - The person's connection.
   * @returns A redirect, or the install URL.
   */
  async run(
    params: ActionParams<BotInstallationOauthStart>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const row = await loadInstallation(
      api.db.db,
      params.projectId,
      params.installationId,
    );
    const bot = await loadReadableBot(
      api.db.db,
      params.projectId,
      row.botId,
      tags,
    ).catch(() => {
      throw installationNotFound();
    });
    assertCanWriteBot(bot, tags);
    const adapter = requirePlatform(row.type);
    if (!adapter.oauth) {
      throw new TypedError({
        message: `A ${adapter.label} app is not installed by OAuth: connect its credentials instead.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "installationId",
      });
    }
    // An uninstalled app keeps its client credentials: installing it again is
    // how a workspace that removed it (or revoked its token) gets it back.
    if (!row.credentials) {
      throw new TypedError({
        message: `Connect the app's client credentials first (bot-installation:connect, or slack:app-create), then install it.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "installationId",
      });
    }
    const state = await startInstall({
      installationId: row.id,
      projectId: row.projectId,
      botId: row.botId,
      userId: connection.session?.data.userId as number,
    });
    const url = adapter.oauth.authorizeUrl(
      openInstallation(row),
      installationUrls(row.type, "").oauthRedirect,
      state,
    );
    if (params.format === "json") return { url };
    return new Response(null, { status: 302, headers: { location: url } });
  }
}
