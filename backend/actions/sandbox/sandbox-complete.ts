import { and, eq } from "drizzle-orm";
import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  actingJob,
  type JobConnection,
  JobTokenMiddleware,
  JobTokenRateLimitMiddleware,
} from "../../middleware/jobToken";
import { lockConversation } from "../../ops/ConversationOps";
import { jobTokenInput } from "../../ops/SandboxInputOps";
import {
  afterRelay,
  finalizeSandboxJob,
  lockJob,
} from "../../ops/SandboxJobOps";
import { type RelayResult, relayJobTurn } from "../../ops/SandboxRelayOps";
import { sandboxJobs } from "../../schema/sandbox_jobs";

/**
 * `sandbox:complete` — the coding CLI exited. An interactive job's
 * successful turn parks the job in `awaiting_input` (and tells the
 * conversation what the turn said); anything else ends the job through
 * `finalizeSandboxJob`. A cancel's exit is `cancelled`, never `failed`.
 * Idempotent: a job that already ended answers `alreadyFinal`. Job token
 * only; not audited.
 *
 * | Outcome | Interactive | Job |
 * |---|---|---|
 * | `succeeded` | yes, no cancel | `awaiting_input` |
 * | `succeeded` | no | `succeeded` |
 * | `failed` | either | `failed` |
 * | `cancelled` | either | `cancelled` |
 */
export class SandboxComplete implements Action {
  name = "sandbox:complete";
  description =
    "Report that a sandbox job's coding agent exited, with its exit code, closing text, and usage. Called by the in-sandbox supervisor with its job token; not for people.";
  middleware = [JobTokenMiddleware, JobTokenRateLimitMiddleware];
  web = { route: "/sandbox/complete", method: HTTP_METHOD.POST };
  inputs = z.object({
    token: jobTokenInput,
    exitCode: z.number().int().describe("The CLI's exit code"),
    outcome: z
      .enum(["succeeded", "failed", "cancelled"])
      .describe("How the supervisor read the exit"),
    closingText: z
      .string()
      .max(200_000)
      .nullish()
      .describe("The agent's last message"),
    error: z.string().max(20_000).nullish().describe("Why it failed"),
    cliSessionId: z
      .string()
      .max(200)
      .nullish()
      .describe("The CLI's resumable session"),
    usage: z
      .record(z.string(), z.unknown())
      .nullish()
      .describe("The CLI's own usage report"),
  });

  /**
   * @param params - The exit.
   * @param connection - The job's connection.
   * @returns The job's status, and whether it had already ended.
   */
  async run(params: ActionParams<SandboxComplete>, connection: JobConnection) {
    const job = actingJob(connection);
    const parks =
      job.interactive && params.outcome === "succeeded" && !job.cancelRequested;
    if (parks) {
      let relay: RelayResult | null = null;
      const parked = await api.db.db.transaction(async (tx) => {
        const locked = await lockConversation(tx, job.parentConversationId);
        const row = await lockJob(tx, job.id);
        if (!row || row.status !== "running") return row;
        const [updated] = await tx
          .update(sandboxJobs)
          .set({
            status: "awaiting_input",
            awaitingInputSince: new Date(),
            lastActivityAt: new Date(),
            closingText: params.closingText ?? null,
            cliSessionId: params.cliSessionId ?? row.cliSessionId,
            cliUsage: params.usage ?? row.cliUsage,
            exitCode: params.exitCode,
          })
          .where(
            and(eq(sandboxJobs.id, job.id), eq(sandboxJobs.status, "running")),
          )
          .returning();
        if (locked && updated) {
          relay = await relayJobTurn(tx, locked.conversation, updated);
        }
        return updated;
      });
      await afterRelay(job, relay);
      return { status: parked?.status ?? job.status, alreadyFinal: false };
    }
    const result = await finalizeSandboxJob(job.id, {
      status: job.cancelRequested ? "cancelled" : params.outcome,
      reason: job.cancelRequested ? (job.endReason ?? "cancelled") : "complete",
      error: params.outcome === "failed" ? (params.error ?? null) : null,
      closingText: params.closingText ?? null,
      exitCode: params.exitCode,
      cliUsage: params.usage ?? null,
      cliSessionId: params.cliSessionId ?? null,
    });
    return { status: result.job.status, alreadyFinal: result.alreadyFinal };
  }
}
