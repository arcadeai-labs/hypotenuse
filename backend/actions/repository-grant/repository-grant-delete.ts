import { eq } from "drizzle-orm";
import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { revokeLiveJobRepositoryTokens } from "../../ops/GitCredentialOps";
import { idInput } from "../../ops/InputOps";
import { loadGrant } from "../../ops/RepositoryGrantOps";
import { serializeRepositoryGrant } from "../../ops/RepositoryOps";
import { repositoryGrants } from "../../schema/repository_grants";

/**
 * `repository-grant:delete` — take a repository away from the project's bots.
 * Once the delete commits, the GitHub tokens live jobs hold for the
 * repository are revoked, and no new one is handed out. Requires admin
 * standing.
 */
export class RepositoryGrantDelete extends AuditedAction {
  name = "repository-grant:delete";
  description =
    "Delete a repository grant: no bot in the project can reach the repository afterwards, and the GitHub tokens running jobs hold for it are revoked. Requires admin standing.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/repository-grant/:grantId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    grantId: idInput("The grant to delete"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - `projectId` and `grantId`.
   * @param connection - The admin's connection.
   * @returns `{ repositoryGrant }`, as it was.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<RepositoryGrantDelete>,
    connection: AuditedConnection,
  ) {
    const { grant, installation } = await loadGrant(
      tx,
      params.projectId,
      params.grantId,
      { lock: true },
    );
    await tx.delete(repositoryGrants).where(eq(repositoryGrants.id, grant.id));
    const serialized = serializeRepositoryGrant(grant, installation);
    connection.metadata.auditBefore = serialized;
    connection.metadata.auditAfter = null;
    connection.metadata.auditTargetType = "repository-grant";
    connection.metadata.auditTargetPath = serialized.fullName;
    return { repositoryGrant: serialized };
  }

  /**
   * Revoke the tokens live jobs hold for the repository.
   * @param result - The response, naming the repository.
   * @param params - The inputs.
   */
  async afterCommit(
    result: unknown,
    params: ActionParams<RepositoryGrantDelete>,
  ) {
    const { repositoryGrant } = result as {
      repositoryGrant: { fullName: string };
    };
    await revokeLiveJobRepositoryTokens(params.projectId, [
      repositoryGrant.fullName,
    ]);
  }
}
