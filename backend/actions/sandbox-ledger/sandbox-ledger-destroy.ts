import { and, eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { publishJobStale } from "../../ops/DashboardEffectsOps";
import { idInput } from "../../ops/InputOps";
import { providerForProject } from "../../ops/SandboxCredentialOps";
import { isTerminalJobStatus } from "../../ops/SandboxJobOps";
import { LIVE_SANDBOX_STATUSES, serializeSandbox } from "../../ops/SandboxOps";
import { SandboxNotFoundError } from "../../sandbox/types";
import { sandboxJobs } from "../../schema/sandbox_jobs";
import { sandboxes } from "../../schema/sandboxes";

/**
 * `sandbox-ledger:destroy` — destroy one ledgered sandbox at its provider and
 * close its row: for a sandbox nothing else will collect soon (a failed
 * provision, a leak the orphan sweep has not reached). Refused while its job
 * is still live — cancelling the job is how that sandbox ends, with the
 * conversation told. Requires admin standing.
 */
export class SandboxLedgerDestroy extends AuditedAction {
  name = "sandbox-ledger:destroy";
  description =
    "Destroy one of the project's sandboxes at its provider and mark it destroyed in the ledger. Refused while the sandbox's job is still running: cancel the job instead (sandbox-job:cancel), which ends its sandbox and tells the conversation. A sandbox the provider has already collected is closed in the ledger. Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/sandbox/:sandboxId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    sandboxId: idInput("The ledger row of the sandbox to destroy"),
  });

  /**
   * @param tx - The transaction the ledger update and its audit row share.
   * @param params - `projectId` and `sandboxId`.
   * @param connection - The caller's connection (audit snapshots written here).
   * @returns The ledger row, closed.
   * @throws {TypedError} 404 for another project's row; a refusal while its
   *   job runs or its provider cannot be reached.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<SandboxLedgerDestroy>,
    connection: AuditedConnection,
  ) {
    const [row] = await tx
      .select()
      .from(sandboxes)
      .where(
        and(
          eq(sandboxes.id, params.sandboxId),
          eq(sandboxes.projectId, params.projectId),
        ),
      )
      .limit(1)
      .for("update");
    if (!row) {
      throw new TypedError({
        message: "Sandbox not found in this project",
        type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
      });
    }
    connection.metadata.auditBefore = serializeSandbox(row);
    connection.metadata.auditTargetType = "sandbox";
    connection.metadata.auditTargetPath = String(row.id);
    if (!LIVE_SANDBOX_STATUSES.includes(row.status)) {
      connection.metadata.auditAfter = serializeSandbox(row);
      return { sandbox: serializeSandbox(row) };
    }
    if (row.jobId) {
      const [job] = await tx
        .select({ status: sandboxJobs.status })
        .from(sandboxJobs)
        .where(eq(sandboxJobs.id, row.jobId))
        .limit(1);
      if (job && !isTerminalJobStatus(job.status)) {
        throw new TypedError({
          message: `Sandbox ${row.id} belongs to job ${row.jobId}, which is still ${job.status}. Cancel the job instead; that ends its sandbox and tells the conversation.`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "sandboxId",
        });
      }
    }
    if (row.externalId) {
      try {
        const provider = await providerForProject(
          tx,
          row.projectId,
          row.provider,
        );
        await (await provider.connect(row.externalId)).destroy();
      } catch (e) {
        if (!(e instanceof SandboxNotFoundError)) {
          throw new TypedError({
            message: `Could not destroy sandbox ${row.id} at its provider: ${e instanceof Error ? e.message : String(e)}`,
            type: ErrorType.CONNECTION_ACTION_RUN,
          });
        }
      }
    }
    const [closed] = await tx
      .update(sandboxes)
      .set({ status: "destroyed", destroyedAt: new Date() })
      .where(eq(sandboxes.id, row.id))
      .returning();
    const serialized = serializeSandbox(closed);
    connection.metadata.auditAfter = serialized;
    connection.metadata.afterCommitData = { jobId: closed.jobId };
    return { sandbox: serialized };
  }

  /**
   * Tell the sandboxes list its ledger changed.
   * @param _result - The response.
   * @param _params - The inputs.
   * @param connection - Carries the destroyed sandbox's job, if any.
   */
  async afterCommit(
    _result: unknown,
    _params: ActionParams<SandboxLedgerDestroy>,
    connection: AuditedConnection,
  ) {
    const jobId = connection.metadata.afterCommitData?.jobId;
    if (typeof jobId === "number") await publishJobStale(jobId);
  }
}
