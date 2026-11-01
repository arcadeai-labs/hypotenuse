import { api } from "keryx";
import { z } from "zod";
import { approvalForIntent, outcomeOfApproval } from "../ops/ApprovalOps";
import { callKey } from "../ops/ApprovalPatternOps";
import { GITHUB_HOST, parseRepositoryName } from "../ops/GitAccessOps";
import {
  botRepositoryAccess,
  type JobRepository,
} from "../ops/GitCredentialOps";
import { githubWebOrigin } from "../ops/GitHubAppOps";
import {
  effectiveSandboxSettings,
  getOrCreateSettings,
} from "../ops/ProjectSettingsOps";
import {
  createSandboxJob,
  dispatchPendingJobs,
  jobForIntent,
} from "../ops/SandboxJobOps";
import { jobModels } from "../ops/SandboxProvisionOps";
import { emitStatus } from "../ops/SurfaceOps";
import { assertSandboxProviderAllowed } from "../sandbox/registry";
import { latestRequester } from "./sandbox-shared";
import { type ToolContext, type ToolDefinition, ToolError } from "./types";

const input = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .describe("A short name for the work, shown to the people waiting"),
  task: z
    .string()
    .trim()
    .min(1)
    .max(20_000)
    .describe(
      "Everything the coding agent needs, in full: it sees none of this conversation. What to do, why, what you already know, what a good result looks like",
    ),
  interactive: z
    .boolean()
    .optional()
    .describe(
      "true: the agent waits for your next instruction after each turn (send it with sandbox_message); false (the default): it works once and ends",
    ),
  repository: z
    .string()
    .trim()
    .max(300)
    .optional()
    .describe(
      "A GitHub repository this bot was granted, as owner/name: it is cloned into the sandbox before the agent starts",
    ),
  mode: z
    .enum(["write", "read"])
    .optional()
    .describe(
      'With a repository: "write" (the default) to change it — push a branch, open a pull request — or "read" for questions about the code: no push, a shorter limit, and no approval',
    ),
  ref: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .optional()
    .describe(
      "With a repository: the branch, tag, or commit to check out (a pull request's branch to address its review); the default branch when unset",
    ),
});

const output = z.object({
  jobId: z.number(),
  status: z.string(),
  note: z.string(),
});

/** The approval's server and tool for a sandbox job. */
const SERVER = "sandbox";
const TOOL = "start";

/** The longest a read-only job may run: it answers a question, nothing more. */
export const READ_JOB_MAX_DURATION_MS = 15 * 60 * 1000;

/**
 * The repository a call asks for, checked against the bot's grants: the bot
 * must hold one, and `write` mode needs a grant that allows a push. Checked
 * before an approval is asked for and again before the job is written, so a
 * person is never asked to approve a job that cannot clone.
 * @param args - The call's input.
 * @param ctx - The call's context.
 * @returns The repository to store on the job, or `null` for a job without one.
 * @throws {ToolError} When the call names no repository it may use.
 */
export async function requestedRepository(
  args: z.infer<typeof input>,
  ctx: Pick<ToolContext, "db" | "bot" | "conversation">,
): Promise<JobRepository | null> {
  if (!args.repository) {
    if (args.mode || args.ref) {
      throw new ToolError(
        "invalid_input",
        "mode and ref apply only to a job started with a repository.",
        "Pass repository as owner/name, or leave mode and ref out.",
      );
    }
    return null;
  }
  const parsed = parseRepositoryName(args.repository, githubWebOrigin());
  if (!parsed) {
    throw new ToolError(
      "invalid_input",
      `"${args.repository}" is not a repository.`,
      "Name it as owner/name, e.g. acme/api.",
    );
  }
  const name = `${parsed.owner}/${parsed.repo}`;
  const mode = args.mode ?? "write";
  const access = await botRepositoryAccess(
    ctx.db,
    ctx.conversation.projectId,
    ctx.bot.id,
    { host: GITHUB_HOST, owner: parsed.owner, repo: parsed.repo },
  );
  if (access === "none") {
    throw new ToolError(
      "repository_not_granted",
      `This bot has no access to ${name}.`,
      `Tell the person; a project admin can grant ${name} to this bot under Repositories.`,
    );
  }
  if (mode === "write" && access !== "write") {
    throw new ToolError(
      "repository_read_only",
      `This bot may read ${name} but not push to it.`,
      `Start the job with mode "read" to look at the code, or tell the person; a project admin can allow pushes to ${name} under Repositories.`,
    );
  }
  return {
    host: GITHUB_HOST,
    owner: parsed.owner,
    name: parsed.repo,
    ref: args.ref ?? null,
    mode,
  };
}

/**
 * `sandbox_start` — hand real work (a filesystem, a shell, hours) to a coding
 * agent in an ephemeral sandbox. The job belongs to this conversation, carries
 * this bot's authority, and reports back here; its result arrives as a
 * message when it ends. Starting is not waiting: `sandbox_wait` (terminal)
 * parks the conversation on the job. They are two tools because a gated
 * call is never a turn-ending one — the tick runs a step's terminal call
 * after the others, ungated.
 *
 * Gated by the bot's `sandboxPolicy`: `approve` (the default) waits for a
 * person's approval of each job, the same gate as an MCP tool outside its
 * allowlist; `allow` runs it. A job on a repository in `mode: "read"` runs
 * without approval under `approve` (it can push nothing, and is capped at
 * {@link READ_JOB_MAX_DURATION_MS}); `off` refuses it like any other. The
 * repository must be granted to the bot — at push for `write` — which is
 * checked before an approval is asked for. Not replayed after a crash: a
 * replayed intent finds the job it started instead of starting a second.
 */
export const sandboxStart: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "sandbox_start",
  description:
    'Hand work that needs a real machine — reading or changing a repository, running tests or scripts, anything that takes a filesystem, a shell, or a long time — to a coding agent in a fresh sandbox. Write the task in full: the agent sees nothing of this conversation. With repository (owner/name, one this bot was granted) the sandbox starts with it cloned: mode "write" (the default) lets the agent push a branch under the bot\'s branch prefix and open a pull request, whose link comes back here; mode "read" is for questions about the code — no push, a shorter limit, and no approval; ref checks out a branch, tag, or commit (a pull request\'s branch, to address its review). It reports progress here, may ask you questions (answer with sandbox_message), and its result arrives as a message when it ends. Then end your turn with sandbox_wait to wait for it. A job may need a person\'s approval first.',
  inputSchema: input,
  outputSchema: output,
  replay: "unsafe",
  parallelSafe: false,
  available: (ctx) => ctx.bot.sandboxPolicy !== "off",
  gate: async (args, ctx) => {
    const repository = await requestedRepository(args, ctx);
    if (ctx.bot.sandboxPolicy === "allow") return { kind: "run" };
    // A read-only job changes nothing anywhere: it runs without approval.
    if (repository?.mode === "read") return { kind: "run" };
    const key = callKey(SERVER, TOOL, args);
    const existing = await approvalForIntent(ctx.db, ctx.intentEntryId);
    if (existing) return outcomeOfApproval(ctx.db, existing, key);
    return {
      kind: "park",
      draft: {
        callKey: key,
        server: SERVER,
        tool: TOOL,
        args,
        reason: "sandbox-job",
      },
    };
  },
  run: async (args, ctx) => {
    if (ctx.bot.sandboxPolicy === "off") {
      throw new ToolError(
        "sandbox_off",
        "This bot may not start sandbox jobs.",
        "Tell the person; a project member can turn sandboxes on for this bot.",
      );
    }
    const repository = await requestedRepository(args, ctx);
    if (ctx.bot.sandboxPolicy === "approve" && repository?.mode !== "read") {
      const approval = await approvalForIntent(ctx.db, ctx.intentEntryId);
      // Defense in depth: the tick runs this only after the gate said so.
      if (
        !approval ||
        approval.status !== "approved" ||
        !approval.executingAt ||
        approval.callKey !== callKey(SERVER, TOOL, args)
      ) {
        throw new ToolError(
          "approval_required",
          "A sandbox job needs a person's approval, and this call has none.",
          "Call sandbox_start again; it will wait for an approval.",
        );
      }
    }
    const existing = await jobForIntent(ctx.db, ctx.intentEntryId);
    if (existing) {
      return {
        jobId: existing.id,
        status: existing.status,
        note: "This call had already started the job.",
      };
    }
    const settings = effectiveSandboxSettings(
      await getOrCreateSettings(ctx.db, ctx.conversation.projectId),
    );
    try {
      assertSandboxProviderAllowed(settings.provider);
    } catch (e) {
      throw new ToolError(
        "sandbox_unavailable",
        e instanceof Error ? e.message : String(e),
        "Tell the person sandboxes are not set up here; a project admin picks a provider under Settings → Sandboxes.",
      );
    }
    if (!(await jobModels(ctx.db, ctx.bot))) {
      throw new ToolError(
        "sandbox_unavailable",
        `The coding agent speaks the Anthropic API, and your "${ctx.bot.modelAlias}" model is not on an Anthropic connection.`,
        "Tell the person; a project admin can point the model at an Anthropic connection under Settings → Models.",
      );
    }
    const requester = await latestRequester(ctx);
    const job = await createSandboxJob(api.db.db, ctx.conversation, ctx.bot, {
      title: args.title,
      task: args.task,
      interactive: args.interactive === true,
      repository: repository ? { ...repository } : null,
      maxDurationMs:
        repository?.mode === "read" ? READ_JOB_MAX_DURATION_MS : null,
      intentEntryId: ctx.intentEntryId,
      triggeredByParticipantId: requester.participantId,
      triggeredByUserId: requester.userId,
    });
    await emitStatus(
      api.db.db,
      ctx.conversation,
      `Working in a sandbox: ${args.title}`,
      "normal",
      { sandboxJobId: job.id },
    );
    try {
      await dispatchPendingJobs(job.projectId);
    } catch (e) {
      api.logger.warn("could not dispatch a sandbox job at once", {
        jobId: job.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return {
      jobId: job.id,
      status: job.status,
      note: `Sandbox job ${job.id} started. To wait for it, end your turn with sandbox_wait; or tell the people here and end your turn with reply_and_wait. Either way its result arrives as a message when it ends.`,
    };
  },
};
