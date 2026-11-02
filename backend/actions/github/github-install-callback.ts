import { and, eq } from "drizzle-orm";
import {
  type ActionParams,
  api,
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
import {
  assertUserAdministersInstallation,
  exchangeGitHubUserCode,
} from "../../ops/GitHubAppOps";
import {
  peekGitHubInstall,
  readAppInstallation,
  repositoriesPageUrl,
  takeGitHubInstall,
} from "../../ops/GitHubInstallOps";
import { isAdmin, resolveProjectAccess } from "../../ops/MembershipOps";
import { serializeGithubInstallation } from "../../ops/RepositoryOps";
import { githubInstallations } from "../../schema/github_installations";

/**
 * `github:install-callback` — GitHub's Setup URL: where it sends the browser
 * after a person installs (or configures) the deployment's GitHub App.
 *
 * **Nothing the query string says is trusted on its own.** The `state` names
 * the project and the admin who started the install (`github:install-url`),
 * and works once. It must belong to the signed-in person, who must still be
 * an admin of that project — a fresher answer than when they started. The
 * `installation_id` can be spoofed (GitHub says so), so the `code` beside it
 * is exchanged for a user token, the installation is read with the App's JWT,
 * and GitHub is asked whether that user **administers** the installation's
 * account — an owner of the organization, or the user account itself
 * (`assertUserAdministersInstallation`). Seeing an installation is not
 * enough: read access to one repository would otherwise attach a whole
 * organization. A spoofed id, or a person who is not an owner, writes nothing.
 *
 * `setup_action=request` means an organization member asked an owner to
 * install the App; nothing is installed yet, and the browser is told so.
 * GitHub also sends people here with no `state` at all — after an owner
 * changes the installation's repositories on GitHub (`setup_action=update`),
 * or from a link not started in Hypotenuse — so every input is optional and a
 * missing one is a redirect with a sentence, never a raw validation error.
 *
 * Every outcome is a redirect to the project's Repositories page: `installed`
 * names the attached row, `error` says what went wrong. A failure rolls back
 * and leaves no audit row; a success is audited as the admin's decision.
 * A browser hop, never an MCP tool.
 */
export class GithubInstallCallback extends AuditedAction {
  name = "github:install-callback";
  description =
    "Where GitHub returns after a person installs the deployment's GitHub App. Checks the install's state and that the person can see the installation on GitHub, attaches it to the project, and redirects to the dashboard.";
  middleware = [RateLimitMiddleware];
  web = { route: "/github/install/callback", method: HTTP_METHOD.GET };
  inputs = z.object({
    state: secret(z.string().max(512))
      .optional()
      .describe(
        "The install's state, from github:install-url; GitHub omits it when the installation was changed on GitHub",
      ),
    installation_id: z
      .string()
      .max(40)
      .optional()
      .describe("The installation GitHub says was installed"),
    setup_action: z
      .string()
      .max(40)
      .optional()
      .describe("install, update, or request"),
    code: secret(z.string().max(4096))
      .optional()
      .describe("The user-authorization code GitHub sends with the install"),
  });

  /**
   * Run the audited attach, and turn any refusal into a redirect that says
   * why, so a person's browser never lands on a JSON error. GitHub's
   * stateless `setup_action=update` redirect is answered with a notice
   * before any transaction opens.
   * @param params - The inputs.
   * @param connection - The browser's connection.
   * @returns A redirect to the project's Repositories page.
   */
  override async run(
    params: Record<string, unknown>,
    connection: AuditedConnection,
  ): Promise<Awaited<ReturnType<this["runWithAudit"]>>> {
    // GitHub's own "the installation changed" redirect carries no state:
    // nothing to attach and nothing to audit, so it never opens a transaction.
    if (
      !String(params.state ?? "").trim() &&
      params.setup_action === "update"
    ) {
      return redirect(
        repositoriesPageUrl(null, {
          notice:
            "The GitHub App installation's repositories were updated on GitHub. Grant any new ones to your bots here.",
        }),
      ) as Awaited<ReturnType<this["runWithAudit"]>>;
    }
    try {
      return await super.run(params, connection);
    } catch (e) {
      const message =
        e instanceof TypedError
          ? e.message
          : "The GitHub App could not be attached. Start again from Repositories.";
      return redirect(
        repositoriesPageUrl(connection.metadata.auditProjectId ?? null, {
          error: message.slice(0, 300),
        }),
      ) as Awaited<ReturnType<this["runWithAudit"]>>;
    }
  }

  /**
   * @param tx - The transaction the attach and its audit row share.
   * @param params - The inputs.
   * @param connection - The browser's connection.
   * @returns A redirect naming the attached installation.
   * @throws {TypedError} For every refusal; {@link run} redirects with it.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<GithubInstallCallback>,
    connection: AuditedConnection,
  ) {
    const state = params.state?.trim() ?? "";
    if (!state) {
      throw refusal(
        "GitHub sent no install state, so there is nothing to attach. Start the install from Repositories.",
      );
    }
    const seen = await peekGitHubInstall(state);
    if (!seen) throw refusal(expired());
    connection.metadata.auditProjectId = seen.projectId;

    const userId = connection.session?.data.userId;
    if (!userId) {
      throw refusal(
        "Sign in to Hypotenuse in this browser, then start the GitHub install again from Repositories.",
        ErrorType.CONNECTION_SESSION_NOT_FOUND,
      );
    }
    // Peeked first, so somebody else's browser cannot burn a live install.
    if (userId !== seen.userId) {
      throw refusal(
        "This GitHub install was started by somebody else. Start your own from Repositories.",
        ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      );
    }
    const pending = await takeGitHubInstall(state);
    if (!pending) throw refusal(expired());

    const access = await resolveProjectAccess(userId, pending.projectId, tx);
    if (!access || !isAdmin(access.callerTags)) {
      throw refusal(
        "Attaching a GitHub App installation takes admin standing in the project, and you no longer have it.",
        ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      );
    }
    connection.metadata.auditOrganizationId = access.project.organizationId;
    if (access.viaOrganizationOwner) {
      connection.metadata.viaOrganizationOwner = true;
    }

    if (params.setup_action === "request") {
      throw refusal(
        "Your request to install the GitHub App was sent to the organization's owners. An owner of the GitHub organization must approve it; then start again from Repositories.",
      );
    }
    const installationId = params.installation_id?.trim() ?? "";
    if (!/^\d+$/.test(installationId) || !params.code) {
      throw refusal(
        'GitHub did not return an installation and an authorization code. Check the App has "Request user authorization (OAuth) during installation" enabled and its Setup URL points here, then start again.',
      );
    }

    // The id is the query string's; the App reads which account it is on,
    // and the person's own GitHub token decides whether they administer it.
    const userToken = await exchangeGitHubUserCode(params.code);
    const live = await readAppInstallation(installationId);
    await assertUserAdministersInstallation(userToken, installationId, {
      login: live.accountLogin,
      id: live.accountId,
      type: live.accountType,
    });

    const [before] = await tx
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.projectId, pending.projectId),
          eq(githubInstallations.installationId, installationId),
        ),
      )
      .for("update");
    const values = {
      accountLogin: live.accountLogin,
      accountType: live.accountType,
      permissions: live.permissions,
      attachedByUserId: userId,
      suspendedAt: live.suspended ? new Date() : null,
      revokedAt: null,
    };
    const [row] = await tx
      .insert(githubInstallations)
      .values({
        projectId: pending.projectId,
        installationId,
        ...values,
      })
      .onConflictDoUpdate({
        target: [
          githubInstallations.projectId,
          githubInstallations.installationId,
        ],
        set: {
          ...values,
          // A suspension already recorded keeps its time.
          suspendedAt: live.suspended
            ? (before?.suspendedAt ?? new Date())
            : null,
        },
      })
      .returning();

    connection.metadata.auditBefore = before
      ? serializeGithubInstallation(before)
      : null;
    connection.metadata.auditAfter = serializeGithubInstallation(row);
    connection.metadata.auditTargetType = "github-installation";
    connection.metadata.auditTargetPath = row.accountLogin;
    connection.metadata.auditMetadata = {
      installationId,
      setupAction: params.setup_action ?? null,
      reattached: Boolean(before),
    };
    api.logger.info("GitHub App installation attached", {
      projectId: pending.projectId,
      installationId,
    });
    return redirect(
      repositoriesPageUrl(pending.projectId, { installed: String(row.id) }),
    );
  }
}

/**
 * A browser redirect.
 * @param location - Where to.
 * @returns The 302.
 */
function redirect(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

/**
 * The sentence for a state that is unknown, used, or expired.
 * @returns The message.
 */
function expired(): string {
  return "This GitHub install link expired or was already used. Start again from Repositories.";
}

/**
 * A refusal the callback turns into a redirect.
 * @param message - What the person reads.
 * @param type - The error type.
 * @returns The typed error.
 */
function refusal(
  message: string,
  type: ErrorType = ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
): TypedError {
  return new TypedError({ message, type });
}
