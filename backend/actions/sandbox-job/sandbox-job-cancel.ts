import { eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { assertCanWriteBot } from "../../ops/BotOps";
import { lockConversation } from "../../ops/ConversationOps";
import { idInput } from "../../ops/InputOps";
import {
  finalizeSandboxJob,
  isTerminalJobStatus,
  loadReadableJob,
  lockJob,
  serializeSandboxJob,
} from "../../ops/SandboxJobOps";
import { sandboxJobs } from "../../schema/sandbox_jobs";

/**
 * `sandbox-job:cancel` — a person stops a job. A pending job ends at once; a
 * running one is flagged, and its supervisor stops the coding agent at its
 * next heartbeat (the reaper forces one that never acknowledges). The
 * conversation that started it is told. Needs write access to the bot.
 */
export class SandboxJobCancel extends AuditedAction {
  name = "sandbox-job:cancel";
  description =
    "Stop a sandbox job. A job not yet started ends at once; a running one stops within a heartbeat, and the conversation that started it is told it was cancelled. Requires membership and write access to the job's bot.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/sandbox-job/:jobId/cancel",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    jobId: idInput("The job to stop"),
  });

  /**
   * @param tx - The transaction the flag and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The job.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<SandboxJobCancel>,
    connection: AuditedConnection,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const { job: ref, bot } = await loadReadableJob(
      tx,
      params.projectId,
      params.jobId,
      tags,
    );
    assertCanWriteBot(bot, tags);
    await lockConversation(tx, ref.parentConversationId);
    const job = await lockJob(tx, ref.id);
    if (!job) throw new Error("The job is gone.");
    if (isTerminalJobStatus(job.status)) {
      throw new TypedError({
        message: `This job has already ended (${job.status.replace("_", " ")}).`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "jobId",
      });
    }
    connection.metadata.auditBefore = serializeSandboxJob(job);
    const [flagged] = await tx
      .update(sandboxJobs)
      .set({
        cancelRequested: true,
        cancelRequestedAt: job.cancelRequestedAt ?? new Date(),
        endReason: "person",
      })
      .where(eq(sandboxJobs.id, job.id))
      .returning();
    connection.metadata.auditAfter = serializeSandboxJob(flagged);
    connection.metadata.auditTargetType = "sandbox-job";
    connection.metadata.auditTargetPath = `${bot.slug}/${job.id}`;
    connection.metadata.afterCommitData = { pending: job.status === "pending" };
    return { sandboxJob: serializeSandboxJob(flagged) };
  }

  /**
   * A job that never started ends now; a running one ends when its
   * supervisor stops.
   * @param _result - The response.
   * @param params - The inputs.
   * @param connection - Whether the job was pending.
   */
  async afterCommit(
    _result: unknown,
    params: ActionParams<SandboxJobCancel>,
    connection: AuditedConnection,
  ) {
    if (connection.metadata.afterCommitData?.pending) {
      await finalizeSandboxJob(params.jobId, {
        status: "cancelled",
        reason: "person",
      });
    }
  }
}
