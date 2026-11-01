import { and, eq } from "drizzle-orm";
import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  actingJob,
  type JobConnection,
  JobTokenMiddleware,
  JobTokenRateLimitMiddleware,
} from "../../middleware/jobToken";
import { jobTokenInput } from "../../ops/SandboxInputOps";
import { claimNextJobMessage } from "../../ops/SandboxJobOps";
import { sandboxJobs } from "../../schema/sandbox_jobs";

/**
 * `sandbox:heartbeat` — the supervisor is alive, and the answer is **the only
 * server → sandbox control**: `cancelRequested`, a `followUp` for an
 * interactive job waiting between turns, or a `steer` for a running turn. A
 * message is claimed (stamped delivered) in the statement that hands it out,
 * so it is never handed out twice. Job token only; not audited.
 *
 * | Job | Answer |
 * |---|---|
 * | cancel requested | `cancelRequested: true` |
 * | `awaiting_input`, phase `idle`, a message queued | `followUp`; the job is `running` again |
 * | `running`, phase `turn`, a steer queued | `steer`: the supervisor interrupts the turn and resumes with it |
 * | otherwise | nothing to do |
 */
export class SandboxHeartbeat implements Action {
  name = "sandbox:heartbeat";
  description =
    "Report that a sandbox job's supervisor is alive, and collect a cancel, follow-up, or steer. Called by the in-sandbox supervisor with its job token; not for people.";
  middleware = [JobTokenMiddleware, JobTokenRateLimitMiddleware];
  web = { route: "/sandbox/heartbeat", method: HTTP_METHOD.POST };
  inputs = z.object({
    token: jobTokenInput,
    phase: z
      .enum(["turn", "idle"])
      .optional()
      .describe("Whether the coding agent is mid-turn or waiting"),
  });

  /**
   * @param params - The token, and whether the supervisor is mid-turn.
   * @param connection - The job's connection.
   * @returns What the supervisor must do.
   */
  async run(params: ActionParams<SandboxHeartbeat>, connection: JobConnection) {
    const job = actingJob(connection);
    await api.db.db
      .update(sandboxJobs)
      .set({ lastHeartbeatAt: new Date() })
      .where(eq(sandboxJobs.id, job.id));
    if (job.cancelRequested) return { cancelRequested: true };
    // A follow-up goes only to a supervisor waiting between turns, and a
    // steer only to one running a turn: a message is stamped delivered as it
    // is handed out, so one handed to a supervisor that cannot use it is lost.
    if (job.status === "awaiting_input" && params.phase === "idle") {
      const message = await claimNextJobMessage(job.id);
      if (!message) return { cancelRequested: false };
      await api.db.db
        .update(sandboxJobs)
        .set({
          status: "running",
          awaitingInputSince: null,
          lastActivityAt: new Date(),
        })
        .where(
          and(
            eq(sandboxJobs.id, job.id),
            eq(sandboxJobs.status, "awaiting_input"),
          ),
        );
      return {
        cancelRequested: false,
        followUp: { id: message.id, body: message.body },
      };
    }
    if (job.status === "running" && params.phase === "turn") {
      const steer = await claimNextJobMessage(job.id, "steer");
      if (steer) {
        return {
          cancelRequested: false,
          steer: { id: steer.id, body: steer.body },
        };
      }
    }
    return { cancelRequested: false };
  }
}
