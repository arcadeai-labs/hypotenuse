import { and, eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { GITHUB_HOST, parseRepositoryName } from "../../ops/GitAccessOps";
import { githubWebOrigin } from "../../ops/GitHubAppOps";
import { idInput } from "../../ops/InputOps";
import {
  assertGrantBots,
  branchPrefixInput,
  grantBotIdsInput,
  grantWarnings,
  loadUsableInstallation,
  probeRepositoryAccess,
} from "../../ops/RepositoryGrantOps";
import { serializeRepositoryGrant } from "../../ops/RepositoryOps";
import { repositoryGrants } from "../../schema/repository_grants";

/**
 * `repository-grant:create` — an admin's decision that bots in the project
 * may reach one repository, through an attached GitHub App installation, and
 * whether they may push to it.
 *
 * Before it is saved: the installation must be the project's and usable; the
 * repository's owner must be the installation's account; every listed bot
 * must be the project's; and the installation must be able to see the
 * repository — proven by minting a `metadata: read` token for it alone and
 * revoking it at once. A grant with `push` and no branch prefix is saved with
 * a warning: an installation token writes every branch, and only a ruleset on
 * GitHub keeps a job inside its prefix.
 */
export class RepositoryGrantCreate extends AuditedAction {
  name = "repository-grant:create";
  description =
    "Grant the project's bots a GitHub repository (owner/name) through an attached GitHub App installation: read-only, or with push. botIds limits it to some bots (omit for every bot); branchPrefix is the branch namespace jobs push into. The installation must be on the repository's owner and able to see it. A push grant without a branch prefix answers a warning. Requires admin standing.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/repository-grant",
    method: HTTP_METHOD.PUT,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    githubInstallationId: idInput(
      "The attached installation the repository is reached through (its id from github:installation-list)",
    ),
    repository: z
      .string()
      .trim()
      .min(3)
      .max(300)
      .describe("The repository, as owner/name (or its GitHub URL)"),
    push: z
      .boolean()
      .default(false)
      .describe(
        "Whether jobs may push branches and open pull requests (default false: read only)",
      ),
    branchPrefix: branchPrefixInput.nullable().optional(),
    botIds: grantBotIdsInput.optional(),
  });

  /**
   * @param tx - The transaction the insert and its audit row share.
   * @param params - The inputs.
   * @param connection - The admin's connection.
   * @returns `{ repositoryGrant, warnings }`.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` for every rule above.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<RepositoryGrantCreate>,
    connection: AuditedConnection,
  ) {
    const installation = await loadUsableInstallation(
      tx,
      params.projectId,
      params.githubInstallationId,
    );
    const repo = parseRepositoryName(params.repository, githubWebOrigin());
    if (!repo) {
      throw new TypedError({
        message: `"${params.repository}" is not a repository. Write it as owner/name, e.g. ${installation.accountLogin.toLowerCase()}/api.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "repository",
      });
    }
    if (repo.owner !== installation.accountLogin.toLowerCase()) {
      throw new TypedError({
        message: `Installation ${installation.id} is on the GitHub account ${installation.accountLogin}, so it cannot reach ${repo.owner}/${repo.repo}. Grant a repository owned by ${installation.accountLogin}, or attach the App's installation on ${repo.owner}.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "repository",
      });
    }
    const botIds = await assertGrantBots(
      tx,
      params.projectId,
      params.botIds ?? null,
    );
    const [existing] = await tx
      .select({ id: repositoryGrants.id })
      .from(repositoryGrants)
      .where(
        and(
          eq(repositoryGrants.projectId, params.projectId),
          eq(repositoryGrants.host, GITHUB_HOST),
          eq(repositoryGrants.owner, repo.owner),
          eq(repositoryGrants.name, repo.repo),
        ),
      )
      .limit(1);
    if (existing) {
      throw new TypedError({
        message: `${repo.owner}/${repo.repo} is already granted in this project (grant ${existing.id}). Edit that grant instead.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "repository",
      });
    }
    await probeRepositoryAccess(installation, repo.repo);

    const [grant] = await tx
      .insert(repositoryGrants)
      .values({
        projectId: params.projectId,
        githubInstallationId: installation.id,
        host: GITHUB_HOST,
        owner: repo.owner,
        name: repo.repo,
        push: params.push,
        branchPrefix: params.branchPrefix ?? null,
        botIds,
        createdByUserId: connection.session?.data.userId ?? null,
      })
      .returning();

    const serialized = serializeRepositoryGrant(grant, installation);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "repository-grant";
    connection.metadata.auditTargetPath = serialized.fullName;
    return { repositoryGrant: serialized, warnings: grantWarnings(grant) };
  }
}
