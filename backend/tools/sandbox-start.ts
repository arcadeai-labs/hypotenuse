import { api } from "keryx";
import { z } from "zod";
import { approvalForIntent, outcomeOfApproval } from "../ops/ApprovalOps";
import { callKey } from "../ops/ApprovalPatternOps";
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
import { type ToolDefinition, ToolError } from "./types";

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
});

const output = z.object({
  jobId: z.number(),
  status: z.string(),
  note: z.string(),
});

/** The approval's server and tool for a sandbox job. */
const SERVER = "sandbox";
const TOOL = "start";

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
 * allowlist; `allow` runs it. Not replayed after a crash: a replayed intent
 * finds the job it started instead of starting a second.
 */
export const sandboxStart: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "sandbox_start",
  description:
    "Hand work that needs a real machine — reading or changing a repository, running tests or scripts, anything that takes a filesystem, a shell, or a long time — to a coding agent in a fresh sandbox. Write the task in full: the agent sees nothing of this conversation. It reports progress here, may ask you questions (answer with sandbox_message), and its result arrives as a message when it ends. Then end your turn with sandbox_wait to wait for it. A job may need a person's approval first.",
  inputSchema: input,
  outputSchema: output,
  replay: "unsafe",
  parallelSafe: false,
  available: (ctx) => ctx.bot.sandboxPolicy !== "off",
  gate: async (args, ctx) => {
    if (ctx.bot.sandboxPolicy === "allow") return { kind: "run" };
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
    if (ctx.bot.sandboxPolicy === "approve") {
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
