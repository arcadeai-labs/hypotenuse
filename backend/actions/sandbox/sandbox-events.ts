import { eq } from "drizzle-orm";
import { type Action, type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  actingJob,
  type JobConnection,
  JobTokenMiddleware,
  JobTokenRateLimitMiddleware,
} from "../../middleware/jobToken";
import { jobTokenInput } from "../../ops/SandboxInputOps";
import { redactJobTokens } from "../../ops/SandboxJobOps";
import { sandboxJobEvents } from "../../schema/sandbox_job_events";
import { sandboxJobs } from "../../schema/sandbox_jobs";

/**
 * The most events one job may store: its `seq` is bounded by it, so a job's
 * transcript is bounded too (each event's text and payload are capped).
 */
const MAX_EVENTS_PER_JOB = 20_000;

/** The largest payload kept for one event, serialized; longer ones are cut. */
const MAX_PAYLOAD_CHARS = 20_000;

/**
 * Keep a payload within {@link MAX_PAYLOAD_CHARS}, or replace it with a note.
 * @param payload - What the supervisor sent.
 * @returns What is stored.
 */
function boundedPayload(payload: unknown): unknown {
  if (payload === undefined) return null;
  const serialized = JSON.stringify(payload) ?? "null";
  return serialized.length <= MAX_PAYLOAD_CHARS
    ? payload
    : { truncated: true, chars: serialized.length };
}

/** One event as the supervisor posts it. */
const eventInput = z.object({
  type: z.string().max(40),
  toolName: z.string().max(200).optional(),
  text: z.string().max(20_000).optional(),
  payload: z.unknown().optional(),
  seq: z.number().int().positive().max(MAX_EVENTS_PER_JOB),
  occurredAt: z.number().int().positive().optional(),
});

/**
 * `sandbox:events` — the supervisor's batched transcript of the coding CLI,
 * appended to `sandbox_job_events`. A retried batch is an upsert on
 * `(jobId, seq)`, so nothing is recorded twice. Bumps the job's activity
 * clock. Job token only; not audited (the sandbox's machine half, recorded
 * in `sandbox_job_events`).
 */
export class SandboxEvents implements Action {
  name = "sandbox:events";
  description =
    "Append a batch of a sandbox job's transcript events. Called by the in-sandbox supervisor with its job token; not for people.";
  middleware = [JobTokenMiddleware, JobTokenRateLimitMiddleware];
  web = { route: "/sandbox/events", method: HTTP_METHOD.PUT };
  inputs = z.object({
    token: jobTokenInput,
    events: z.array(eventInput).max(2_000).describe("The events, in order"),
  });

  /**
   * @param params - The token and the events.
   * @param connection - The job's connection.
   * @returns How many were stored.
   */
  async run(params: ActionParams<SandboxEvents>, connection: JobConnection) {
    // A sandbox's own token never reaches a row or a relay.
    params = redactJobTokens(params);
    const job = actingJob(connection);
    if (params.events.length === 0) return { stored: 0 };
    const rows = await api.db.db
      .insert(sandboxJobEvents)
      .values(
        params.events.map((e) => ({
          jobId: job.id,
          seq: e.seq,
          kind: e.type,
          toolName: e.toolName ?? null,
          text: e.text ?? null,
          payload: boundedPayload(e.payload),
          occurredAt: e.occurredAt ? new Date(e.occurredAt) : new Date(),
        })),
      )
      .onConflictDoNothing()
      .returning({ id: sandboxJobEvents.id });
    const init = params.events.find((e) => e.type === "init" && e.text);
    await api.db.db
      .update(sandboxJobs)
      .set({
        lastActivityAt: new Date(),
        ...(init?.text ? { cliSessionId: init.text } : {}),
      })
      .where(eq(sandboxJobs.id, job.id));
    return { stored: rows.length };
  }
}
