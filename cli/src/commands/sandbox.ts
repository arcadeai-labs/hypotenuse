/**
 * `hypotenuse sandbox` — the code work bots handed to a coding agent in an
 * ephemeral sandbox (`sandbox-job:list`, `sandbox-job:view`,
 * `sandbox-job:events`, `sandbox-job:cancel`, `sandbox-job:answer`): each
 * job's status, what the agent reported and asked, its transcript, and a
 * person's two moves on it — stopping it and answering its questions.
 *
 * Out of scope: the `sandbox:*` actions a job's own token calls from inside
 * its sandbox, the `proxy:*` routes it reaches models and MCP through, and the
 * task-only actions that start, dispatch, and reap jobs. None is for a person.
 */
import type { Command } from "commander";
import { resolveBotId } from "../api/resolve";
import {
  emit,
  type Paginated,
  pageFooter,
  pageQuery,
  runCommand,
  when,
  withPaging,
} from "../context";
import { parseNumber, readAllStdin } from "../input";
import { glyph, sandboxJobGlyph, table } from "../output/theme";

/** Every status a sandbox job can be in, as the server names them. */
export const SANDBOX_JOB_STATUSES = [
  "pending",
  "provisioning",
  "running",
  "awaiting_input",
  "succeeded",
  "failed",
  "cancelled",
  "timed_out",
  "expired",
] as const;

/** A sandbox job as the sandbox-job actions answer it. */
export interface SandboxJob {
  id: number;
  botId: number;
  parentConversationId: number;
  title: string;
  task: string;
  status: string;
  provider: string | null;
  interactive: boolean;
  reportedStatus: string | null;
  statusMessage: string | null;
  closingText: string | null;
  artifacts: Record<string, { content: string; updatedAt: number }>;
  cancelRequested: boolean;
  endReason: string | null;
  error: string | null;
  usage: { inputTokens: number; outputTokens: number; requests: number };
  budgetTokens: number | null;
  maxDurationMs: number;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  bot?: { id: number; name: string; slug: string };
}

/** A question a job's coding agent asked. */
interface JobQuestion {
  id: number;
  kind: string;
  question: string;
  options: string[] | null;
  blocking: boolean;
  status: string;
  answer: string | null;
  answeredBy: { kind: string; name?: string | null } | null;
  helpRequestId: number | null;
  expiresAt: number;
  createdAt: number;
}

/** A message sent into a job. */
interface JobMessage {
  id: number;
  source: string;
  delivery: string;
  body: string;
  deliveredAt: number | null;
  createdAt: number;
}

/** `sandbox-job:view`'s answer. */
interface JobView {
  sandboxJob: SandboxJob;
  questions: JobQuestion[];
  messages: JobMessage[];
  sandboxes: {
    id: number;
    provider: string;
    status: string;
    error: string | null;
  }[];
  canWrite: boolean;
}

/** One transcript event. */
interface JobEvent {
  id: number;
  seq: number;
  kind: string;
  toolName: string | null;
  text: string | null;
  occurredAt: number;
}

/**
 * A job's status with its glyph, for a person.
 * @param status - The server's status name.
 * @returns e.g. `✓ succeeded`.
 */
export function jobStatusText(status: string): string {
  const mark = (() => {
    switch (status) {
      case "pending":
      case "provisioning":
        return sandboxJobGlyph("provisioning");
      case "running":
        return sandboxJobGlyph("running");
      case "awaiting_input":
        return glyph("waiting-person");
      case "succeeded":
        return sandboxJobGlyph("complete");
      case "cancelled":
        return glyph("stale");
      default:
        return sandboxJobGlyph("failed");
    }
  })();
  return `${mark} ${status.replace("_", " ")}`;
}

/**
 * A job's token usage, for a person.
 * @param job - The job.
 * @returns e.g. `1200 in / 300 out over 4 requests (budget 50000)`.
 */
export function usageText(
  job: Pick<SandboxJob, "usage" | "budgetTokens">,
): string {
  const u = job.usage;
  const budget = job.budgetTokens ? ` (budget ${job.budgetTokens})` : "";
  return `${u.inputTokens} in / ${u.outputTokens} out over ${u.requests} request${u.requests === 1 ? "" : "s"}${budget}`;
}

/**
 * Render a job for a person: its status, what the agent said, its questions
 * and messages, and its sandboxes.
 * @param v - `sandbox-job:view`'s answer.
 * @returns The text.
 */
export function sandboxJobDetail(v: JobView): string {
  const j = v.sandboxJob;
  const lines = [
    `sandbox job ${j.id} — ${j.title}`,
    `status        ${jobStatusText(j.status)}${j.cancelRequested && !j.endedAt ? " (stopping)" : ""}${j.endReason ? ` — ${j.endReason}` : ""}`,
    `bot           ${j.bot ? `${j.bot.name} (${j.bot.slug})` : j.botId}`,
    `conversation  ${j.parentConversationId}`,
    `provider      ${j.provider ?? "-"}`,
    `usage         ${usageText(j)}`,
    `started       ${when(j.startedAt ?? j.createdAt)}`,
    `ended         ${when(j.endedAt)}`,
  ];
  if (j.reportedStatus || j.statusMessage) {
    lines.push(
      `reported      ${[j.reportedStatus, j.statusMessage].filter(Boolean).join(": ")}`,
    );
  }
  if (j.error) lines.push(`error         ${j.error}`);
  lines.push("", "task", ...j.task.split("\n").map((l) => `  ${l}`));
  if (j.closingText) {
    lines.push(
      "",
      "closing",
      ...j.closingText.split("\n").map((l) => `  ${l}`),
    );
  }
  const artifacts = Object.keys(j.artifacts ?? {});
  if (artifacts.length > 0) {
    lines.push("", `artifacts     ${artifacts.join(", ")}`);
  }
  if (v.questions.length > 0) {
    lines.push("", "questions");
    for (const q of v.questions) {
      const to = q.kind === "team" ? " (to the team)" : "";
      lines.push(`  ${q.id}. [${q.status}]${to} ${q.question}`);
      if (q.options?.length)
        lines.push(`     options: ${q.options.join(" | ")}`);
      if (q.answer !== null) {
        const by = q.answeredBy?.name ?? q.answeredBy?.kind ?? "";
        lines.push(`     answer${by ? ` (${by})` : ""}: ${q.answer}`);
      } else if (q.status === "pending") {
        lines.push(
          q.helpRequestId
            ? `     answer it in the help inbox: hypotenuse help-request answer ${q.helpRequestId}`
            : `     hypotenuse sandbox answer ${j.id} ${q.id} "<answer>"`,
        );
      }
    }
  }
  if (v.messages.length > 0) {
    lines.push("", "messages");
    for (const m of v.messages) {
      lines.push(
        `  ${when(m.createdAt)} ${m.source} (${m.deliveredAt ? "delivered" : m.delivery}): ${m.body}`,
      );
    }
  }
  if (v.sandboxes.length > 0) {
    lines.push("", "sandboxes");
    for (const s of v.sandboxes) {
      lines.push(
        `  ${s.id} ${s.provider} — ${s.status}${s.error ? `: ${s.error}` : ""}`,
      );
    }
  }
  lines.push(
    "",
    `you can       ${v.canWrite ? "read, answer, and cancel it" : "read it"}`,
  );
  return lines.join("\n");
}

/**
 * One transcript event as a line.
 * @param e - The event.
 * @returns The line.
 */
export function eventLine(e: JobEvent): string {
  const tool = e.toolName ? ` ${e.toolName}` : "";
  const text = e.text ? ` ${e.text.replace(/\s+/g, " ").trim()}` : "";
  return `${String(e.seq).padStart(4)}  ${when(e.occurredAt)}  ${e.kind}${tool}${text}`;
}

/**
 * Register `sandbox list|view|events|cancel|answer`.
 * @param program - The root program.
 */
export function registerSandboxCommands(program: Command): void {
  const sandbox = program
    .command("sandbox")
    .description(
      "Code work bots handed to sandbox jobs: list, view, events, cancel, answer",
    );

  withPaging(
    sandbox
      .command("list")
      .description(
        "List the project's sandbox jobs, newest first (bots you can read)",
      )
      .option("--bot <bot>", "only this bot's jobs (id or slug)")
      .option("--conversation <id>", "only jobs this conversation started")
      .option(
        "--status <status>",
        `only jobs in this status: ${SANDBOX_JOB_STATUSES.join(", ")}`,
      ),
  ).action(async function (this: Command) {
    await runCommand(this, async (ctx) => {
      const o = this.opts() as {
        bot?: string;
        conversation?: string;
        status?: string;
      };
      if (
        o.status &&
        !(SANDBOX_JOB_STATUSES as readonly string[]).includes(o.status)
      ) {
        throw new Error(
          `--status takes one of ${SANDBOX_JOB_STATUSES.join(", ")}; got "${o.status}".`,
        );
      }
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const botId = o.bot
        ? await resolveBotId(client, projectId, o.bot)
        : undefined;
      const result = await client.request<Paginated<"sandboxJobs", SandboxJob>>(
        "GET",
        `/project/${projectId}/sandbox-jobs`,
        {
          query: {
            botId,
            conversationId: o.conversation
              ? parseNumber(o.conversation, "--conversation")
              : undefined,
            status: o.status,
            ...pageQuery(this),
          },
        },
      );
      emit(
        ctx,
        result,
        () =>
          table(
            result.sandboxJobs.map((j) => ({
              id: j.id,
              status: jobStatusText(j.status),
              bot: j.bot?.slug ?? j.botId,
              title: j.title,
              conversation: j.parentConversationId,
              tokens: j.usage.inputTokens + j.usage.outputTokens,
              created: when(j.createdAt),
            })),
            [
              { key: "id" },
              { key: "status" },
              { key: "bot" },
              { key: "title", maxWidth: 50 },
              { key: "conversation" },
              { key: "tokens" },
              { key: "created" },
            ],
          ) + pageFooter(result.pagination),
      );
    });
  });

  sandbox
    .command("view")
    .description(
      "Show a job: its status, task, closing text, questions, messages, and sandboxes",
    )
    .argument("<jobId>", "the sandbox job")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const jobId = parseNumber(raw, "<jobId>");
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const result = await client.request<JobView>(
          "GET",
          `/project/${projectId}/sandbox-job/${jobId}`,
        );
        emit(ctx, result, () => sandboxJobDetail(result));
      });
    });

  withPaging(
    sandbox
      .command("events")
      .description(
        "Print a job's transcript — what the coding agent said and ran — oldest first",
      )
      .argument("<jobId>", "the sandbox job")
      .option("--after <seq>", "only events after this sequence number"),
  ).action(async function (this: Command, raw: string) {
    await runCommand(this, async (ctx) => {
      const jobId = parseNumber(raw, "<jobId>");
      const o = this.opts() as { after?: string };
      const client = ctx.signedInClient();
      const projectId = await ctx.projectId();
      const result = await client.request<Paginated<"events", JobEvent>>(
        "GET",
        `/project/${projectId}/sandbox-job/${jobId}/events`,
        {
          query: {
            afterSeq:
              o.after !== undefined
                ? parseNumber(o.after, "--after")
                : undefined,
            ...pageQuery(this),
          },
        },
      );
      emit(ctx, result, () =>
        result.events.length === 0
          ? "No events yet."
          : result.events.map(eventLine).join("\n") +
            pageFooter(result.pagination),
      );
    });
  });

  sandbox
    .command("cancel")
    .description(
      "Stop a job: a pending one ends now, a running one within a heartbeat (write access to the bot)",
    )
    .argument("<jobId>", "the sandbox job")
    .action(async function (this: Command, raw: string) {
      await runCommand(this, async (ctx) => {
        const jobId = parseNumber(raw, "<jobId>");
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const result = await client.request<{ sandboxJob: SandboxJob }>(
          "POST",
          `/project/${projectId}/sandbox-job/${jobId}/cancel`,
        );
        emit(ctx, result, () =>
          result.sandboxJob.status === "pending"
            ? `Cancelled sandbox job ${jobId}; it had not started.`
            : `Stopping sandbox job ${jobId}; its conversation is told when it ends.`,
        );
      });
    });

  sandbox
    .command("answer")
    .description(
      "Answer a question a job's coding agent asked (write access to the bot)",
    )
    .argument("<jobId>", "the sandbox job")
    .argument("<questionId>", "the question, from `sandbox view`")
    .argument("<answer>", "your answer, or - to read it from standard input")
    .action(async function (
      this: Command,
      rawJob: string,
      rawQuestion: string,
      text: string,
    ) {
      await runCommand(this, async (ctx) => {
        const jobId = parseNumber(rawJob, "<jobId>");
        const questionId = parseNumber(rawQuestion, "<questionId>");
        const answer = text === "-" ? await readAllStdin() : text;
        const client = ctx.signedInClient();
        const projectId = await ctx.projectId();
        const result = await client.request<{ question: JobQuestion }>(
          "POST",
          `/project/${projectId}/sandbox-job/${jobId}/question/${questionId}`,
          { body: { answer } },
        );
        emit(
          ctx,
          result,
          () =>
            `Answered question ${questionId} of sandbox job ${jobId}; the agent reads it the next time it checks.`,
        );
      });
    });
}
