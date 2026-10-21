import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  afterRunnersRevoked,
  canManageRunner,
  revokeRunners,
  runnerInProject,
  serializeRunner,
} from "../../ops/RunnerOps";

/**
 * `runner:revoke` — permanently revoke a runner. Complete in one transaction
 * plus one publish: the row is `revoked` (and work it holds is returned to
 * the queue by work routing, in the same transaction, once work exists); then
 * a `revoked` frame on its channel and the deletion of every session
 * `daemon:connect` minted for it, so its socket loses its authority now.
 * Its owner or a project admin only.
 */
export class RunnerRevoke extends AuditedAction {
  name = "runner:revoke";
  description =
    "Permanently revoke a runner: its token stops working immediately and its daemon is told to stop. Only the runner's owner or a project admin.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/runner/:id", method: HTTP_METHOD.DELETE };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project the runner belongs to"),
    id: z.coerce.number().int().positive().describe("The runner's id"),
  });

  /**
   * @param tx - The transaction the revocation and its audit row share.
   * @param params - The runner.
   * @param connection - The caller's connection.
   * @returns The revoked runner.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`; `CONNECTION_CHANNEL_AUTHORIZATION`
   *   for someone who is neither owner nor admin; `CONNECTION_ACTION_PARAM_VALIDATION`
   *   when it is already revoked.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<RunnerRevoke>,
    connection: AuditedConnection,
  ) {
    const before = await runnerInProject(params.projectId, params.id, tx, true);
    if (
      !canManageRunner(
        connection.session!.data.userId!,
        connection.metadata.callerTags ?? [],
        before,
      )
    ) {
      throw new TypedError({
        message: "Only the runner's owner or a project admin can revoke it",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }
    if (before.status === "revoked") {
      throw new TypedError({
        message: "This runner is already revoked",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "id",
      });
    }
    const [after] = await revokeRunners(tx, [before.id], "revoked");
    connection.metadata.auditBefore = serializeRunner(before);
    connection.metadata.auditAfter = serializeRunner(after!);
    connection.metadata.auditTargetType = "runner";
    connection.metadata.auditTargetPath = before.name;
    return { runner: serializeRunner(after!) };
  }

  /**
   * Frame the runner, delete its sessions, and refresh the runner list.
   * @param _result - Unused.
   * @param params - The validated inputs.
   */
  async afterCommit(_result: unknown, params: ActionParams<RunnerRevoke>) {
    await afterRunnersRevoked([{ id: params.id, projectId: params.projectId }]);
  }
}
