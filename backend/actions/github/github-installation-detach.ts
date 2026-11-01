import { and, asc, eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { serializeGithubInstallation } from "../../ops/RepositoryOps";
import { githubInstallations } from "../../schema/github_installations";
import { repositoryGrants } from "../../schema/repository_grants";

/**
 * `github:installation-detach` — stop a project using a GitHub App
 * installation. **Deleting the row deletes every repository grant made
 * through it** (the grants cascade), which is the point: no bot in the
 * project can reach those repositories afterwards. The App stays installed on
 * GitHub, where only the account's owners can remove it. Requires admin
 * standing; audited with the grants it took away.
 */
export class GithubInstallationDetach extends AuditedAction {
  name = "github:installation-detach";
  description =
    "Detach a GitHub App installation from the project. Every repository grant made through it is deleted with it, so no bot in the project can reach those repositories afterwards; the App stays installed on GitHub. Requires admin standing.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/github/installation/:installationId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    installationId: idInput(
      "The attached installation's id in Hypotenuse (from github:installation-list), not GitHub's",
    ),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - `projectId` and `installationId`.
   * @param connection - The admin's connection.
   * @returns `{ installation, removedGrants }`: the detached row and the grants deleted with it.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<GithubInstallationDetach>,
    connection: AuditedConnection,
  ) {
    const [row] = await tx
      .select()
      .from(githubInstallations)
      .where(
        and(
          eq(githubInstallations.id, params.installationId),
          eq(githubInstallations.projectId, params.projectId),
        ),
      )
      .for("update");
    if (!row) {
      throw new TypedError({
        message: "GitHub installation not found in this project",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    const grants = await tx
      .select({
        id: repositoryGrants.id,
        owner: repositoryGrants.owner,
        name: repositoryGrants.name,
      })
      .from(repositoryGrants)
      .where(eq(repositoryGrants.githubInstallationId, row.id))
      .orderBy(asc(repositoryGrants.id));
    const removedGrants = grants.map((g) => ({
      id: g.id,
      fullName: `${g.owner}/${g.name}`,
    }));

    // The cascade would delete them too; deleting them here keeps the
    // revocation inside this transaction rather than a database side effect.
    await tx
      .delete(repositoryGrants)
      .where(eq(repositoryGrants.githubInstallationId, row.id));
    await tx
      .delete(githubInstallations)
      .where(eq(githubInstallations.id, row.id));

    const serialized = serializeGithubInstallation(row);
    connection.metadata.auditBefore = serialized;
    connection.metadata.auditAfter = null;
    connection.metadata.auditTargetType = "github-installation";
    connection.metadata.auditTargetPath = row.accountLogin;
    connection.metadata.auditMetadata = {
      projectId: params.projectId,
      installationId: row.installationId,
      removedGrants,
    };
    return { installation: serialized, removedGrants };
  }
}
