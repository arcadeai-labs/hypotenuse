import { eq } from "drizzle-orm";
import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { grantCoversBot } from "../../ops/GitAccessOps";
import { revokeLiveJobRepositoryTokens } from "../../ops/GitCredentialOps";
import { idInput } from "../../ops/InputOps";
import {
  assertGrantBots,
  branchPrefixInput,
  grantBotIdsInput,
  grantWarnings,
  loadGrant,
} from "../../ops/RepositoryGrantOps";
import { serializeRepositoryGrant } from "../../ops/RepositoryOps";
import { bots } from "../../schema/bots";
import {
  type NewRepositoryGrant,
  repositoryGrants,
} from "../../schema/repository_grants";

/**
 * `repository-grant:edit` — change whether a grant may push, its branch
 * prefix, or which bots may use it. Only the fields sent change; the
 * repository and installation do not (delete the grant and make another).
 * Turning `push` on is an admin's decision like any other here, and a push
 * grant left without a branch prefix answers a warning. A change that
 * narrows the grant — `push` turned off, bots taken off it — revokes the
 * GitHub tokens live jobs already hold for the repository once it commits,
 * so the narrower grant applies to running jobs too.
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

    // Who lost access: every job, when the grant can no longer push; the
    // bots no longer covered, when its bots changed.
    const lostPush = grant.push && !updated.push;
    const lostBots =
      params.botIds !== undefined && updated.botIds !== null
        ? await projectBotIds(tx, params.projectId).then((ids) =>
            ids.filter(
              (id) => grantCoversBot(grant, id) && !grantCoversBot(updated, id),
            ),
          )
        : [];
    if (lostPush || lostBots.length > 0) {
      connection.metadata.afterCommitData = {
        repository: `${grant.owner}/${grant.name}`,
        botIds: lostPush ? null : lostBots,
      };
    }

    const serialized = serializeRepositoryGrant(updated, installation);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "repository-grant";
    connection.metadata.auditTargetPath = serialized.fullName;
    return { repositoryGrant: serialized, warnings: grantWarnings(updated) };
  }

  /**
   * Revoke the tokens live jobs hold for the repository, when the edit
   * narrowed who may do what with it.
   * @param _result - The response.
   * @param params - The inputs.
   * @param connection - What {@link runWithAudit} found narrowed.
   */
  async afterCommit(
    _result: unknown,
    params: ActionParams<RepositoryGrantEdit>,
    connection: AuditedConnection,
  ) {
    const narrowed = connection.metadata.afterCommitData as
      | { repository: string; botIds: number[] | null }
      | undefined;
    if (!narrowed) return;
    await revokeLiveJobRepositoryTokens(
      params.projectId,
      [narrowed.repository],
      narrowed.botIds,
    );
  }
}

/**
 * Every bot id in a project.
 * @param tx - The transaction.
 * @param projectId - The project.
 * @returns The ids.
 */
async function projectBotIds(
  tx: TxHandle,
  projectId: number,
): Promise<number[]> {
  const rows = await tx
    .select({ id: bots.id })
    .from(bots)
    .where(eq(bots.projectId, projectId));
  return rows.map((r) => r.id);
}
