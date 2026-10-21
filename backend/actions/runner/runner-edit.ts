import { and, eq, ne } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import {
  canManageRunner,
  isUniqueViolation,
  publishRunnersChanged,
  runnerInProject,
  runnerNameInput,
  serializeRunner,
} from "../../ops/RunnerOps";
import { type Runner, runners } from "../../schema/runners";

/**
 * `runner:edit` — rename a runner, or pause and resume it. A paused
 * (`enabled: false`) runner still heartbeats, so it shows online, but it is
 * never offered work and every other daemon call is refused. Its owner or a
 * project admin only.
 */
export class RunnerEdit extends AuditedAction {
  name = "runner:edit";
  description =
    "Rename a runner, or pause (enabled: false) or resume it. A paused runner stays connected but is offered no work. Only the runner's owner or a project admin.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/runner/:id", method: HTTP_METHOD.POST };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project the runner belongs to"),
    id: z.coerce.number().int().positive().describe("The runner's id"),
    name: runnerNameInput
      .optional()
      .describe("A new name, unique in the project"),
    enabled: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .optional()
      .transform((v) =>
        v === undefined ? undefined : v === true || v === "true",
      )
      .describe("false pauses the runner; true resumes it"),
  });

  /**
   * @param tx - The transaction the update and its audit row share.
   * @param params - The runner and what to change.
   * @param connection - The caller's connection.
   * @returns The updated runner.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`; `CONNECTION_CHANNEL_AUTHORIZATION`
   *   for someone who is neither owner nor admin; `CONNECTION_ACTION_PARAM_VALIDATION`
   *   for a revoked runner or a taken name.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<RunnerEdit>,
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
        message: "Only the runner's owner or a project admin can change it",
        type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
      });
    }
    if (before.status === "revoked") {
      throw new TypedError({
        message: "This runner is revoked",
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "id",
      });
    }
    if (params.name !== undefined && params.name !== before.name) {
      const [taken] = await tx
        .select({ id: runners.id })
        .from(runners)
        .where(
          and(
            eq(runners.projectId, params.projectId),
            eq(runners.name, params.name),
            ne(runners.status, "revoked"),
          ),
        )
        .limit(1);
      if (taken) throw nameTaken(params.name);
    }

    // In a savepoint: a concurrent rename onto the same name passes the check
    // above too, and the name index refuses the loser. The savepoint keeps
    // the transaction usable so that refusal is the same 406, not a 500.
    let after: Runner | undefined;
    try {
      [after] = await tx.transaction((sp) =>
        sp
          .update(runners)
          .set({
            ...(params.name !== undefined ? { name: params.name } : {}),
            ...(params.enabled !== undefined
              ? { enabled: params.enabled }
              : {}),
          })
          .where(eq(runners.id, before.id))
          .returning(),
      );
    } catch (error) {
      if (!isUniqueViolation(error, "runners_project_name_idx")) throw error;
      throw nameTaken(params.name!);
    }

    connection.metadata.auditBefore = serializeRunner(before);
    connection.metadata.auditAfter = serializeRunner(after!);
    connection.metadata.auditTargetType = "runner";
    connection.metadata.auditTargetPath = after!.name;
    return { runner: serializeRunner(after!) };
  }

  /**
   * Refresh the project's runner list.
   * @param _result - Unused.
   * @param params - The validated inputs.
   */
  async afterCommit(_result: unknown, params: ActionParams<RunnerEdit>) {
    await publishRunnersChanged(params.projectId);
  }
}

/**
 * The refusal for a name another unrevoked runner in the project holds.
 * @param name - The name asked for.
 * @returns A 406 on `name`.
 */
function nameTaken(name: string): TypedError {
  return new TypedError({
    message: `A runner named "${name}" is already registered in this project`,
    type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
    key: "name",
  });
}
