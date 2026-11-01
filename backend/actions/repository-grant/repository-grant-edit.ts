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
import {
  assertGrantBots,
  branchPrefixInput,
  grantBotIdsInput,
  grantWarnings,
  loadGrant,
} from "../../ops/RepositoryGrantOps";
import { serializeRepositoryGrant } from "../../ops/RepositoryOps";
import {
  type NewRepositoryGrant,
  repositoryGrants,
} from "../../schema/repository_grants";

/**
 * `repository-grant:edit` — change whether a grant may push, its branch
 * prefix, or which bots may use it. Only the fields sent change; the
 * repository and installation do not (delete the grant and make another).
 * Turning `push` on is an admin's decision like any other here, and a push
 * grant left without a branch prefix answers a warning.
 */
export class RepositoryGrantEdit extends AuditedAction {
  name = "repository-grant:edit";
  description =
    "Change a repository grant: push (whether jobs may push), branchPrefix (null clears it), or botIds (null for every bot). Only the fields sent change; the repository cannot. A push grant without a branch prefix answers a warning. Requires admin standing.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/repository-grant/:grantId",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    grantId: idInput("The grant to change"),
    push: z
      .boolean()
      .optional()
      .describe("Whether jobs may push branches and open pull requests"),
    branchPrefix: branchPrefixInput.nullable().optional(),
    botIds: grantBotIdsInput.optional(),
  });

  /**
   * @param tx - The transaction the update and its audit row share.
   * @param params - The inputs.
   * @param connection - The admin's connection.
   * @returns `{ repositoryGrant, warnings }`.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`, or
   *   `CONNECTION_ACTION_PARAM_VALIDATION` for an unknown bot.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<RepositoryGrantEdit>,
    connection: AuditedConnection,
  ) {
    const { grant, installation } = await loadGrant(
      tx,
      params.projectId,
      params.grantId,
      { lock: true },
    );
    connection.metadata.auditBefore = serializeRepositoryGrant(
      grant,
      installation,
    );

    const changes: Partial<NewRepositoryGrant> = {};
    if (params.push !== undefined) changes.push = params.push;
    if (params.branchPrefix !== undefined) {
      changes.branchPrefix = params.branchPrefix;
    }
    if (params.botIds !== undefined) {
      changes.botIds = await assertGrantBots(
        tx,
        params.projectId,
        params.botIds,
      );
    }
    const [updated] =
      Object.keys(changes).length > 0
        ? await tx
            .update(repositoryGrants)
            .set(changes)
            .where(eq(repositoryGrants.id, grant.id))
            .returning()
        : [grant];

    const serialized = serializeRepositoryGrant(updated, installation);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "repository-grant";
    connection.metadata.auditTargetPath = serialized.fullName;
    return { repositoryGrant: serialized, warnings: grantWarnings(updated) };
  }
}
