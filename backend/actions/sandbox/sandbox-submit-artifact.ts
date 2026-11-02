import { and, eq, sql } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import {
  actingJob,
  type JobConnection,
  JobTokenMiddleware,
  JobTokenRateLimitMiddleware,
} from "../../middleware/jobToken";
import {
  PULL_REQUEST_ARTIFACT,
  recordJobPullRequest,
} from "../../ops/PullRequestOps";
import { jobTokenInput } from "../../ops/SandboxInputOps";
import { redactJobTokens } from "../../ops/SandboxJobOps";
import { sandboxJobs } from "../../schema/sandbox_jobs";

/** The most artifacts one job keeps. */
const MAX_ARTIFACTS = 20;

/**
 * `sandbox:submit-artifact` — the coding agent hands back a named text: its
 * `result`, a report, a diff. Stored on the job (a name submitted again is
 * replaced) and given to the bot with the job's ending. Job token only; not
 * audited.
 *
 * `pull_request`, whose content is a pull request's URL, also records the
 * pull request against the job and relays its link to the conversation
 * (`PullRequestOps`). A URL that is not a pull request, or one on a
 * repository the bot is not granted, is stored as an artifact and answered
 * with `pullRequest: null` and a `note` saying why.
 */
export class SandboxSubmitArtifact implements Action {
  name = "sandbox:submit-artifact";
  description =
    'Hand back a named piece of text with your work. Always submit your final answer as name "result": what you did, what you found, and where. When you open a pull request, submit its URL as name "pull_request" so the people who asked see it. Submitting a name again replaces it. At most 20 names.';
  middleware = [JobTokenMiddleware, JobTokenRateLimitMiddleware];
  web = { route: "/sandbox/job/artifact", method: HTTP_METHOD.PUT };
  inputs = z.object({
    token: jobTokenInput,
    name: z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9._-]{0,79}$/, "lowercase letters, digits, . _ -")
      .describe("The artifact's name, e.g. result"),
    content: z.string().max(200_000).describe("The text"),
  });

  /**
   * @param params - The artifact.
   * @param connection - The job's connection.
   * @returns The names the job now holds; for `pull_request`, the pull
   *   request recorded (or `null` and why not).
   * @throws {TypedError} Past the artifact cap.
   */
  async run(
    params: ActionParams<SandboxSubmitArtifact>,
    connection: JobConnection,
  ) {
    // A sandbox's own token never reaches a row or a relay.
    params = redactJobTokens(params);
    const job = actingJob(connection);
    const value = JSON.stringify({
      content: params.content,
      updatedAt: Date.now(),
    });
    const [row] = await api.db.db
      .update(sandboxJobs)
      .set({
        artifacts: sql`${sandboxJobs.artifacts} || jsonb_build_object(${params.name}::text, ${value}::jsonb)`,
        lastActivityAt: new Date(),
      })
      // The cap is checked in the statement that writes, so parallel
      // submissions with new names cannot race past it.
      .where(
        and(
          eq(sandboxJobs.id, job.id),
          sql`(${sandboxJobs.artifacts} ? ${params.name} or (select count(*) from jsonb_object_keys(${sandboxJobs.artifacts})) < ${MAX_ARTIFACTS})`,
        ),
      )
      .returning({ artifacts: sandboxJobs.artifacts });
    if (!row) {
      throw new TypedError({
        message: `This job already holds ${MAX_ARTIFACTS} artifacts. Replace one by submitting its name again.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "name",
      });
    }
    const names = Object.keys(row?.artifacts ?? {});
    if (params.name !== PULL_REQUEST_ARTIFACT) return { names };
    const recorded = await recordJobPullRequest(job, params.content.trim());
    if (!recorded.recorded) {
      return { names, pullRequest: null, note: recorded.reason };
    }
    const pr = recorded.pullRequest;
    return {
      names,
      pullRequest: {
        repository: `${pr.owner}/${pr.name}`,
        number: pr.number,
        url: pr.url,
      },
      note: recorded.created
        ? "Recorded; the link is shown to the people who asked."
        : "Already recorded; nothing changed.",
    };
  }
}
