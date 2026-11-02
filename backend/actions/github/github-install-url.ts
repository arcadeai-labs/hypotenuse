import {
  type Action,
  type ActionParams,
  config,
  HTTP_METHOD,
  RateLimitMiddleware,
} from "keryx";
import { z } from "zod";
import type { AuditedConnection } from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { missingGitHubAppConfig } from "../../ops/GitHubAppOps";
import {
  GITHUB_INSTALL_STATE_TTL_SECONDS,
  githubInstallUrl,
  startGitHubInstall,
} from "../../ops/GitHubInstallOps";
import { idInput } from "../../ops/InputOps";

/**
 * `github:install-url` — the link an admin opens to install the deployment's
 * GitHub App on an organization or account and attach that installation to
 * the project. Mints a single-use state (ten minutes) bound to the project
 * and the admin; `github:install-callback` finishes it. Writes no row, so it
 * is not audited — the callback that attaches the installation is.
 *
 * When the deployment's App is not configured, answers `url: null` and what
 * is missing, as environment variable names, rather than a link that fails
 * on GitHub.
 */
export class GithubInstallUrl implements Action {
  name = "github:install-url";
  description =
    "Get the link that installs this deployment's GitHub App on a GitHub organization or account and attaches the installation to the project. Open it in a browser within ten minutes; GitHub returns to Hypotenuse, which checks you can see the installation. Answers url: null and the missing environment variables when the deployment's App is not configured. Requires admin standing.";
  middleware = [RateLimitMiddleware, AdminMiddleware()];
  web = {
    route: "/project/:projectId/github/install-url",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project to attach the installation to"),
  });

  /**
   * @param params - `projectId`.
   * @param connection - The admin's connection.
   * @returns `{ url, missing, expiresInSeconds }`.
   */
  async run(
    params: ActionParams<GithubInstallUrl>,
    connection: AuditedConnection,
  ) {
    const missing = missingGitHubAppConfig();
    if (missing.length > 0) {
      return {
        url: null,
        missing,
        appSlug: null,
        expiresInSeconds: null,
        message: `This deployment's GitHub App is not configured: set ${missing.join(", ")}.`,
      };
    }
    const state = await startGitHubInstall({
      projectId: params.projectId,
      userId: connection.session?.data.userId as number,
    });
    return {
      url: githubInstallUrl(state),
      missing,
      appSlug: String(config.github.appSlug).trim(),
      expiresInSeconds: GITHUB_INSTALL_STATE_TTL_SECONDS,
      message: null,
    };
  }
}
