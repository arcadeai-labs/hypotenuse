import { eq } from "drizzle-orm";
import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { loadGrant } from "../../ops/RepositoryGrantOps";
import { serializeRepositoryGrant } from "../../ops/RepositoryOps";
import { repositoryGrants } from "../../schema/repository_grants";

/**
 * `repository-grant:delete` — take a repository away from the project's bots.
 * A job already running keeps the tokens it holds until it ends (each expires
 * within the hour); no new one is handed out. Requires admin standing.
 */
export class RepositoryGrantDelete extends AuditedAction {
  name = "repository-grant:delete";
  description =
    "Delete a repository grant: no bot in the project can reach the repository afterwards (a job already running keeps its short-lived token until it ends). Requires admin standing.";
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
}
