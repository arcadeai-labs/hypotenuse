import { and, eq, ne } from "drizzle-orm";
import {
  type ActionParams,
  ErrorType,
  HTTP_METHOD,
  RateLimitMiddleware,
  TypedError,
} from "keryx";
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
  generateRunnerToken,
  hashRunnerToken,
  publishRunnersChanged,
  revokeRunners,
  runnerNameInput,
  serializeRunner,
} from "../../ops/RunnerOps";
import { type Runner, runners } from "../../schema/runners";

/**
 * `runner:register` — register a machine as a runner in a project, owned by
 * the caller, and return its token **once**.
 *
 * There is no "show token" and no rotate-in-place: `replace: true` revokes
 * the unrevoked runner of the same name (the caller's own, or anyone's for an
 * admin) and registers a new one, so a token that leaked is dead the moment
 * its owner re-registers. The token is never in the audit row — it is an
 * output, and `serializeRunner` has no field for it.
 *
 * Never an MCP tool: a model holding it could mint a credential that outlives
 * the conversation.
 */
export class RunnerRegister extends AuditedAction {
  name = "runner:register";
  description =
    "Register a machine as a runner in a project, owned by you, and return its runner token once. With replace, revokes the existing runner of that name first. Requires membership in the project.";
  middleware = [RateLimitMiddleware, ProjectMemberMiddleware()];
  web = { route: "/runner", method: HTTP_METHOD.PUT };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project to register the runner in"),
    name: runnerNameInput.describe(
      "The runner's name, unique in the project, e.g. evan-mbp",
    ),
    replace: z
      .union([z.boolean(), z.enum(["true", "false"])])
      .optional()
      .transform((v) => v === true || v === "true")
      .describe(
        "Revoke an existing runner with this name and register a new one",
      ),
  });

  /**
   * @param tx - The transaction the revoke, the insert, and the audit row share.
   * @param params - The project, the name, and whether to replace.
   * @param connection - The caller's connection.
   * @returns The new runner, its token (shown once), and what it replaced.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` when the name is
   *   taken and `replace` is not set; `CONNECTION_CHANNEL_AUTHORIZATION` when
   *   replacing a runner the caller cannot manage.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<RunnerRegister>,
    connection: AuditedConnection,
  ) {
    const userId = connection.session!.data.userId!;
    const [existing] = await tx
      .select()
      .from(runners)
      .where(
        and(
          eq(runners.projectId, params.projectId),
          eq(runners.name, params.name),
          ne(runners.status, "revoked"),
        ),
      )
      .for("update")
      .limit(1);

    let replaced: Runner[] = [];
    if (existing) {
      if (!params.replace) {
        throw new TypedError({
          message: `A runner named "${params.name}" is already registered in this project. Pass replace to revoke it and register again.`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "name",
        });
      }
      if (
        !canManageRunner(userId, connection.metadata.callerTags ?? [], existing)
      ) {
        throw new TypedError({
          message: `Only its owner or a project admin can replace the runner "${params.name}"`,
          type: ErrorType.CONNECTION_CHANNEL_AUTHORIZATION,
        });
      }
      replaced = await revokeRunners(tx, [existing.id], "replaced");
      connection.metadata.auditBefore = serializeRunner(existing);
    }

    const token = generateRunnerToken();
    // DO NOTHING on the name index: two registrations racing on one name
    // must not both land, and the loser is told the name is taken.
    const [runner] = await tx
      .insert(runners)
      .values({
        projectId: params.projectId,
        userId,
        name: params.name,
        tokenHash: hashRunnerToken(token),
        tokenLastFour: token.slice(-4),
      })
      .onConflictDoNothing()
      .returning();
    if (!runner) {
      throw new TypedError({
        message: `A runner named "${params.name}" is already registered in this project`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "name",
      });
    }

    const serialized = serializeRunner(runner);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "runner";
    connection.metadata.auditTargetPath = runner.name;
    return {
      runner: serialized,
      token,
      replacedRunnerId: replaced[0]?.id ?? null,
    };
  }

  /**
   * Revoke the replaced runner's sessions and frame it, and refresh the
   * project's runner list.
   * @param result - What {@link RunnerRegister.runWithAudit} returned.
   * @param params - The validated inputs.
   */
  async afterCommit(
    result: { replacedRunnerId: number | null },
    params: ActionParams<RunnerRegister>,
  ) {
    if (result.replacedRunnerId !== null) {
      await afterRunnersRevoked([
        { id: result.replacedRunnerId, projectId: params.projectId },
      ]);
    }
    await publishRunnersChanged(params.projectId);
  }
}
