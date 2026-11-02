import { asc, desc, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  HTTP_METHOD,
} from "keryx";
import { z } from "zod";
import {
  ProjectMemberMiddleware,
  type RbacConnectionMeta,
} from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import { canWriteBot } from "../../ops/BotOps";
import { idInput } from "../../ops/InputOps";
import {
  serializeGitHandout,
  serializePullRequest,
} from "../../ops/RepositoryOps";
import {
  loadReadableJob,
  serializeJobMessage,
  serializeJobQuestion,
  serializeSandboxJob,
} from "../../ops/SandboxJobOps";
import { serializeSandbox } from "../../ops/SandboxOps";
import { sandboxJobGitTokens } from "../../schema/sandbox_job_git_tokens";
import { sandboxJobMessages } from "../../schema/sandbox_job_messages";
import { sandboxJobPullRequests } from "../../schema/sandbox_job_pull_requests";
import { sandboxJobQuestions } from "../../schema/sandbox_job_questions";
import { sandboxes } from "../../schema/sandboxes";

/**
 * `sandbox-job:view` — one job with its questions, the messages sent to it,
 * the sandboxes it ran in, its git handouts, and its pull requests. Needs the bot's read access; `canWrite` says
 * whether the caller may cancel it or answer its questions.
 */
export class SandboxJobView implements Action {
  name = "sandbox-job:view";
  description =
    "Read one sandbox job: its task and the briefing the coding agent saw, status, the agent's last reported status, closing text, artifacts, questions and their answers, messages sent to it, its sandboxes, every git credential it asked for (repository, permission, issued or refused, revoked), and the pull requests it opened. Requires membership and read access to the job's bot.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/sandbox-job/:jobId",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    jobId: idInput("The job"),
  });

  /**
   * @param params - The project and job.
   * @param connection - The caller's connection.
   * @returns The job and what belongs to it.
   */
  async run(
    params: ActionParams<SandboxJobView>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const tags = connection.metadata.callerTags ?? [];
    const { job, bot } = await loadReadableJob(
      api.db.db,
      params.projectId,
      params.jobId,
      tags,
    );
    const [questions, messages, ledger, handouts, pulls] = await Promise.all([
      api.db.db
        .select()
        .from(sandboxJobQuestions)
        .where(eq(sandboxJobQuestions.jobId, job.id))
        .orderBy(asc(sandboxJobQuestions.id)),
      api.db.db
        .select()
        .from(sandboxJobMessages)
        .where(eq(sandboxJobMessages.jobId, job.id))
        .orderBy(asc(sandboxJobMessages.id)),
      api.db.db
        .select()
        .from(sandboxes)
        .where(eq(sandboxes.jobId, job.id))
        .orderBy(desc(sandboxes.id)),
      api.db.db
        .select()
        .from(sandboxJobGitTokens)
        .where(eq(sandboxJobGitTokens.jobId, job.id))
        .orderBy(asc(sandboxJobGitTokens.id)),
      api.db.db
        .select()
        .from(sandboxJobPullRequests)
        .where(eq(sandboxJobPullRequests.jobId, job.id))
        .orderBy(asc(sandboxJobPullRequests.id)),
    ]);
    return {
      sandboxJob: {
        ...serializeSandboxJob(job),
        bot: { id: bot.id, name: bot.name, slug: bot.slug },
      },
      questions: questions.map(serializeJobQuestion),
      messages: messages.map(serializeJobMessage),
      sandboxes: ledger.map(serializeSandbox),
      gitHandouts: handouts.map(serializeGitHandout),
      pullRequests: pulls.map(serializePullRequest),
      canWrite: canWriteBot(bot, tags),
    };
  }
}
