import { eq } from "drizzle-orm";
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
import { afterRelay, redactJobTokens } from "../../ops/SandboxJobOps";
import { type RelayResult, relayJobStatus } from "../../ops/SandboxRelayOps";
import { sandboxJobs } from "../../schema/sandbox_jobs";

/**
 * `sandbox:report-status` — the coding agent says where it is. The status is
 * kept on the job and relayed to the conversation's surface ("Running
 * tests…"); it never wakes the bot. Job token only; not audited.
 */
export class SandboxReportStatus implements Action {
  name = "sandbox:report-status";
  description =
    "Tell the people waiting on you what you are doing now, at each milestone: cloning, running tests, writing the fix. Short and specific. It shows where they asked; it does not interrupt anyone.";
  middleware = [JobTokenMiddleware, JobTokenRateLimitMiddleware];
  web = { route: "/sandbox/job/status", method: HTTP_METHOD.POST };
  inputs = z.object({
    token: jobTokenInput,
    state: z
      .string()
      .trim()
      .min(1)
      .max(60)
      .describe("A word or two for where you are, e.g. running-tests"),
    message: z
      .string()
      .trim()
      .min(1)
      .max(1_000)
      .describe(
        "One sentence for the people waiting, e.g. Running the 412 unit tests",
      ),
  });

  /**
   * @param params - The status.
   * @param connection - The job's connection.
   * @returns An acknowledgement.
   */
  async run(
    params: ActionParams<SandboxReportStatus>,
    connection: JobConnection,
  ) {
    // A sandbox's own token never reaches a row or a relay.
    params = redactJobTokens(params);
    const job = actingJob(connection);
    let relay: RelayResult | null = null;
    await api.db.db.transaction(async (tx) => {
      const locked = await lockConversation(tx, job.parentConversationId);
      const [updated] = await tx
        .update(sandboxJobs)
        .set({
          reportedStatus: params.state,
          statusMessage: params.message,
          lastActivityAt: new Date(),
        })
        .where(eq(sandboxJobs.id, job.id))
        .returning();
      if (locked) {
        relay = await relayJobStatus(
          tx,
          locked.conversation,
          updated,
          params.state,
          params.message,
        );
      }
    });
    await afterRelay(job, relay);
    return { ok: true, note: "Status shown to the people waiting." };
  }
}
