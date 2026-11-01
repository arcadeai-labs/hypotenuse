import { createHash, randomBytes } from "node:crypto";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  lt,
  notInArray,
  type SQL,
  sql,
} from "drizzle-orm";
import { api, config, ErrorType, TypedError } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/sandbox";
import type { Bot } from "../schema/bots";
import { bots } from "../schema/bots";
import type { Conversation } from "../schema/conversations";
import { conversations } from "../schema/conversations";
import { helpRequests } from "../schema/help_requests";
import {
  type SandboxJobMessage,
  type SandboxMessageDelivery,
  type SandboxMessageSource,
  sandboxJobMessages,
} from "../schema/sandbox_job_messages";
import {
  type SandboxAnsweredBy,
  type SandboxJobQuestion,
  sandboxJobQuestions,
} from "../schema/sandbox_job_questions";
import {
  ACTIVE_SANDBOX_JOB_STATUSES,
  type SandboxJob,
  type SandboxJobStatus,
  type SandboxJobUsage,
  sandboxJobs,
  TERMINAL_SANDBOX_JOB_STATUSES,
} from "../schema/sandbox_jobs";
import { canReadBot } from "./BotOps";
import {
  enqueueTick,
  lockConversation,
  pingConversation,
} from "./ConversationOps";
import type { DbHandle, TxHandle } from "./DbOps";
import { enqueueDelivery } from "./OutboxOps";
import {
  effectiveSandboxSettings,
  getOrCreateSettings,
} from "./ProjectSettingsOps";
import { releaseJobSandboxes } from "./SandboxOps";
import { type RelayResult, relayJobEnded } from "./SandboxRelayOps";

/**
 * **Sandbox jobs**: a bot's code work, owned by the conversation that started
 * it. This module holds the job's lifecycle — its token, its claim, its one
 * ending — and the two queues between the job and the people around it:
 * messages in (`sandbox_job_messages`, handed out by the heartbeat) and
 * questions out (`sandbox_job_questions`, collected by polling).
 *
 * | Status | Entered by | Left by |
 * |---|---|---|
 * | `pending` | `sandbox_start` | the dispatch claim; a cancel ends it here |
 * | `provisioning` | `claimPendingJobs` | `sandbox-job:start` launching the supervisor; a failure or a reap finalizes |
 * | `running` | `sandbox-job:start`; a follow-up claimed from `awaiting_input` | `sandbox:complete`; a reap; a cancel acknowledged |
 * | `awaiting_input` | `sandbox:complete` of an interactive job's turn | a follow-up (`running`); the idle sweep (`expired`); a cancel |
 * | terminal | {@link finalizeSandboxJob} only | never |
 *
 * Every ending goes through {@link finalizeSandboxJob}: the first reason
 * wins, the token is revoked, the sandbox destroyed, open questions
 * cancelled, and the parent conversation told — and woken, when it waits on
 * this job. Lock order is the conversation, then the job.
 */

/** A job token's OAuth `clientId` prefix: how a sandbox session is told from a person's. */
export const JOB_TOKEN_CLIENT_PREFIX = "hypotenuse-job:";

/**
 * The `clientId` a job's token carries.
 * @param jobId - The job.
 * @returns `hypotenuse-job:<id>`.
 */
export function jobClientId(jobId: number): string {
  return `${JOB_TOKEN_CLIENT_PREFIX}${jobId}`;
}

/**
 * Whether an OAuth `clientId` belongs to a sandbox job rather than a person's
 * MCP client.
 * @param clientId - The verified token's client id.
 * @returns `true` for a job token.
 */
export function isJobTokenClientId(clientId: string | undefined): boolean {
  return typeof clientId === "string"
    ? clientId.startsWith(JOB_TOKEN_CLIENT_PREFIX)
    : false;
}

/**
 * Hash a job token for storage and lookup.
 * @param token - The plaintext token.
 * @returns Lowercase hex SHA-256.
 */
export function hashJobToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The prefix every job token starts with, so a leaked one is recognizable. */
export const JOB_TOKEN_PREFIX = "hyp_job_";

/**
 * A fresh job token: 32 random bytes.
 * @returns The token and its hash.
 */
export function generateJobToken(): { token: string; tokenHash: string } {
  const token = `${JOB_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, tokenHash: hashJobToken(token) };
}

/**
 * The Redis key holding the plaintext of a job's token, so a revocation can
 * find the OAuth record to delete.
 * @param jobId - The job.
 * @returns The key.
 */
function tokenPointerKey(jobId: number): string {
  return `sandbox:job-token:${jobId}`;
}

/**
 * Register a job token with Keryx's OAuth verifier, so the sandbox's MCP
 * client is admitted to `/mcp`. Its `userId` is `0`: a job is no person, so
 * Keryx opens its MCP session with no `userId`, every session-gated human
 * action answers 401, and the session split refuses the rest. The TTL is the
 * job's ceiling plus a grace, so a token cannot outlive its job even if every
 * revocation fails.
 * @param jobId - The job.
 * @param token - The plaintext token.
 * @param ttlMs - How long it stays valid.
 */
export async function registerJobToken(
  jobId: number,
  token: string,
  ttlMs: number,
): Promise<void> {
  const ttlSeconds = Math.max(1, Math.ceil(ttlMs / 1000));
  await api.redis.redis.set(
    `oauth:token:${token}`,
    JSON.stringify({
      userId: 0,
      clientId: jobClientId(jobId),
      scopes: ["mcp"],
    }),
    "EX",
    ttlSeconds,
  );
  await api.redis.redis.set(tokenPointerKey(jobId), token, "EX", ttlSeconds);
}

/**
 * Revoke a job's token. Idempotent.
 * @param jobId - The job.
 */
export async function revokeJobToken(jobId: number): Promise<void> {
  const pointer = tokenPointerKey(jobId);
  const token = await api.redis.redis.get(pointer);
  if (token) await api.redis.redis.del(`oauth:token:${token}`);
  await api.redis.redis.del(pointer);
}

/**
 * The live job a presented token acts for. A token whose job has ended is
 * refused here even if Redis has not expired it yet.
 * @param token - The plaintext token.
 * @returns The job, or `null`.
 */
export async function resolveJobByToken(
  token: string,
): Promise<SandboxJob | null> {
  if (!token.startsWith(JOB_TOKEN_PREFIX)) return null;
  const [job] = await api.db.db
    .select()
    .from(sandboxJobs)
    .where(
      and(
        eq(sandboxJobs.tokenHash, hashJobToken(token)),
        inArray(sandboxJobs.status, ACTIVE_SANDBOX_JOB_STATUSES),
      ),
    )
    .limit(1);
  return job ?? null;
}

/**
 * Whether a status is terminal.
 * @param status - A job status.
 * @returns `true` when the job has ended.
 */
export function isTerminalJobStatus(status: SandboxJobStatus): boolean {
  return TERMINAL_SANDBOX_JOB_STATUSES.includes(status);
}

/** What a bot asked for when it started a job. */
export interface JobDraft {
  title: string;
  task: string;
  interactive: boolean;
  repository?: Record<string, unknown> | null;
  intentEntryId?: number | null;
  triggeredByParticipantId?: number | null;
  triggeredByUserId?: number | null;
}

/**
 * Write a `pending` job for a conversation, with the limits in effect now.
 * @param db - A database handle.
 * @param conversation - The parent conversation.
 * @param bot - Its bot.
 * @param draft - What it asked for.
 * @returns The job.
 */
export async function createSandboxJob(
  db: DbHandle,
  conversation: Conversation,
  bot: Bot,
  draft: JobDraft,
): Promise<SandboxJob> {
  const settings = effectiveSandboxSettings(
    await getOrCreateSettings(db, conversation.projectId),
  );
  const [job] = await db
    .insert(sandboxJobs)
    .values({
      projectId: conversation.projectId,
      botId: bot.id,
      parentConversationId: conversation.id,
      intentEntryId: draft.intentEntryId ?? null,
      triggeredByParticipantId: draft.triggeredByParticipantId ?? null,
      triggeredByUserId: draft.triggeredByUserId ?? null,
      title: draft.title,
      task: draft.task,
      repository: draft.repository ?? null,
      interactive: draft.interactive,
      status: "pending",
      provider: settings.provider,
      maxDurationMs: settings.maxDurationMs,
      idleTimeoutMs: config.sandbox.idleTimeoutMs,
      budgetTokens: bot.sandboxJobTokenBudget,
    })
    .returning();
  return job;
}

/**
 * The job a sandbox tool call started, if any — so a replayed call finds its
 * job instead of starting a second.
 * @param db - A database handle.
 * @param intentEntryId - The `sandbox_start` intent.
 * @returns The job, or `undefined`.
 */
export async function jobForIntent(
  db: DbHandle,
  intentEntryId: number,
): Promise<SandboxJob | undefined> {
  const [job] = await db
    .select()
    .from(sandboxJobs)
    .where(eq(sandboxJobs.intentEntryId, intentEntryId))
    .limit(1);
  return job;
}

/**
 * Read a job.
 * @param db - A database handle.
 * @param jobId - The job.
 * @returns The job, or `undefined`.
 */
export async function loadJob(
  db: DbHandle,
  jobId: number,
): Promise<SandboxJob | undefined> {
  const [job] = await db
    .select()
    .from(sandboxJobs)
    .where(eq(sandboxJobs.id, jobId))
    .limit(1);
  return job;
}

/**
 * Lock a job row `FOR UPDATE`. Callers that also lock its conversation lock
 * that first.
 * @param tx - An open transaction.
 * @param jobId - The job.
 * @returns The locked job, or `undefined`.
 */
export async function lockJob(
  tx: TxHandle,
  jobId: number,
): Promise<SandboxJob | undefined> {
  const [job] = await tx
    .select()
    .from(sandboxJobs)
    .where(eq(sandboxJobs.id, jobId))
    .for("update");
  return job;
}

/**
 * The 404 a job the caller may not read, or that is elsewhere, answers.
 * @returns The error.
 */
export function jobNotFound(): TypedError {
  return new TypedError({
    message: "Sandbox job not found in this project",
    type: ErrorType.CONNECTION_ACTION_NOT_FOUND,
  });
}

/**
 * Load a job whose bot the caller may read.
 * @param db - A database handle.
 * @param projectId - The project.
 * @param jobId - The job.
 * @param callerTags - The caller's tags.
 * @returns The job and its bot.
 * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
 */
export async function loadReadableJob(
  db: DbHandle,
  projectId: number,
  jobId: number,
  callerTags: Parameters<typeof canReadBot>[1],
): Promise<{ job: SandboxJob; bot: Bot }> {
  const [row] = await db
    .select({ job: sandboxJobs, bot: bots })
    .from(sandboxJobs)
    .innerJoin(bots, eq(bots.id, sandboxJobs.botId))
    .where(and(eq(sandboxJobs.id, jobId), eq(sandboxJobs.projectId, projectId)))
    .limit(1);
  if (!row || !canReadBot(row.bot, callerTags)) throw jobNotFound();
  return row;
}

/**
 * **Claim** due `pending` jobs for one project without exceeding its
 * concurrency, nor any bot's. `FOR UPDATE SKIP LOCKED` keeps two claimers off
 * the same row; a transaction-scoped advisory lock per project serializes the
 * count with the claim, because under `READ COMMITTED` two claimers that each
 * counted three free slots would otherwise claim six.
 * @param projectId - The project.
 * @returns The claimed jobs, now `provisioning`.
 */
export async function claimPendingJobs(
  projectId: number,
): Promise<SandboxJob[]> {
  return api.db.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('sandbox-dispatch'), ${projectId})`,
    );
    const settings = effectiveSandboxSettings(
      await getOrCreateSettings(tx, projectId),
    );
    const inFlight = await tx
      .select({ botId: sandboxJobs.botId, n: count() })
      .from(sandboxJobs)
      .where(
        and(
          eq(sandboxJobs.projectId, projectId),
          inArray(sandboxJobs.status, ACTIVE_SANDBOX_JOB_STATUSES),
        ),
      )
      .groupBy(sandboxJobs.botId);
    const perBot = new Map(inFlight.map((r) => [r.botId, r.n]));
    let free = settings.concurrency - inFlight.reduce((sum, r) => sum + r.n, 0);
    if (free <= 0) return [];
    // Bots already at their own cap are left out here, not after the
    // limit, so one busy bot's backlog cannot hide everyone else's jobs.
    const capped = inFlight
      .filter((r) => r.n >= config.sandbox.perBotConcurrency)
      .map((r) => r.botId);
    const pending = await tx
      .select()
      .from(sandboxJobs)
      .where(
        and(
          eq(sandboxJobs.projectId, projectId),
          eq(sandboxJobs.status, "pending"),
          eq(sandboxJobs.cancelRequested, false),
          capped.length > 0 ? notInArray(sandboxJobs.botId, capped) : undefined,
        ),
      )
      .orderBy(asc(sandboxJobs.id))
      .limit(50)
      .for("update", { skipLocked: true });
    const claimed: SandboxJob[] = [];
    for (const job of pending) {
      if (free <= 0) break;
      const running = perBot.get(job.botId) ?? 0;
      if (running >= config.sandbox.perBotConcurrency) continue;
      const [row] = await tx
        .update(sandboxJobs)
        .set({ status: "provisioning", startedAt: new Date() })
        .where(eq(sandboxJobs.id, job.id))
        .returning();
      claimed.push(row);
      perBot.set(job.botId, running + 1);
      free--;
    }
    return claimed;
  });
}

/**
 * Claim what is due and enqueue each claimed job's `sandbox-job:start`.
 * Called by the dispatch clock for every project, and right after a job is
 * written for its own project, so a job does not wait for the clock.
 * @param projectId - One project, or every project with pending jobs.
 * @returns The jobs claimed.
 */
export async function dispatchPendingJobs(
  projectId?: number,
): Promise<number[]> {
  const projects =
    projectId !== undefined
      ? [projectId]
      : (
          await api.db.db
            .selectDistinct({ projectId: sandboxJobs.projectId })
            .from(sandboxJobs)
            .where(eq(sandboxJobs.status, "pending"))
        ).map((r) => r.projectId);
  const claimed: number[] = [];
  for (const id of projects) {
    for (const job of await claimPendingJobs(id)) {
      claimed.push(job.id);
      await api.actions.enqueue(
        "sandbox-job:start",
        { jobId: job.id },
        "sandboxes",
      );
    }
  }
  return claimed;
}

/** How a job ended, for {@link finalizeSandboxJob}. */
export interface JobEnding {
  status: (typeof TERMINAL_SANDBOX_JOB_STATUSES)[number];
  /** Which path or sweep ended it, e.g. `complete`, `dead_supervisor`. */
  reason: string;
  error?: string | null;
  closingText?: string | null;
  exitCode?: number | null;
  cliUsage?: Record<string, unknown> | null;
  cliSessionId?: string | null;
}

/** What {@link finalizeSandboxJob} did. */
export interface FinalizeResult {
  job: SandboxJob;
  /** The job had already ended; nothing changed. */
  alreadyFinal: boolean;
}

/**
 * **The one funnel that ends a job.** Stamps a terminal status idempotently
 * (the first reason wins), cancels its open questions, tells the parent
 * conversation — waking it when it waits on this job — and then, after
 * commit, revokes the token and destroys the sandbox. Every ending goes
 * through here: completion, failure, cancel, every reap.
 * @param jobId - The job.
 * @param ending - How it ended.
 * @returns The job, and whether it had already ended.
 */
export async function finalizeSandboxJob(
  jobId: number,
  ending: JobEnding,
): Promise<FinalizeResult> {
  let relay: RelayResult | null = null;
  const result = await api.db.db.transaction(async (tx) => {
    const ref = await loadJob(tx, jobId);
    if (!ref) throw jobNotFound();
    const locked = await lockConversation(tx, ref.parentConversationId);
    const job = await lockJob(tx, jobId);
    if (!job) throw jobNotFound();
    if (isTerminalJobStatus(job.status)) {
      return { job, alreadyFinal: true };
    }
    const [ended] = await tx
      .update(sandboxJobs)
      .set({
        status: ending.status,
        endReason: ending.reason,
        error: ending.error ?? job.error,
        closingText: ending.closingText ?? job.closingText,
        exitCode: ending.exitCode ?? job.exitCode,
        cliUsage: ending.cliUsage ?? job.cliUsage,
        cliSessionId: ending.cliSessionId ?? job.cliSessionId,
        endedAt: new Date(),
        awaitingInputSince: null,
      })
      .where(eq(sandboxJobs.id, jobId))
      .returning();
    const closed = await tx
      .update(sandboxJobQuestions)
      .set({ status: "cancelled", answeredAt: new Date() })
      .where(
        and(
          eq(sandboxJobQuestions.jobId, jobId),
          eq(sandboxJobQuestions.status, "pending"),
        ),
      )
      .returning({ helpRequestId: sandboxJobQuestions.helpRequestId });
    // A question that went to the team takes its Help request with it, so
    // nobody answers one that can no longer reach anyone.
    const helpIds = closed
      .map((q) => q.helpRequestId)
      .filter((id): id is number => id !== null);
    if (helpIds.length > 0) {
      await tx
        .update(helpRequests)
        .set({ status: "cancelled", answeredAt: new Date() })
        .where(
          and(
            inArray(helpRequests.id, helpIds),
            eq(helpRequests.status, "pending"),
          ),
        );
    }
    if (locked) relay = await relayJobEnded(tx, locked.conversation, ended);
    return { job: ended, alreadyFinal: false };
  });
  if (!result.alreadyFinal) {
    await revokeJobToken(jobId);
    await releaseJobSandboxes(jobId);
    await afterRelay(result.job, relay);
  }
  return result;
}

/**
 * What every relay owes after its transaction commits: the tick it woke, the
 * outbox rows it wrote, and the transcript page's ping.
 * @param job - The job.
 * @param relay - What the relay did, if it ran.
 */
export async function afterRelay(
  job: Pick<SandboxJob, "projectId" | "parentConversationId">,
  relay: RelayResult | null,
): Promise<void> {
  if (!relay) return;
  if (relay.woke) await enqueueTick(relay.woke);
  if (relay.outboxWritten) await enqueueDelivery([job.parentConversationId]);
  await pingConversation(job.projectId, job.parentConversationId);
}

/**
 * Ask a job to stop. A `pending` job ends here (nothing is running); a live
 * one is flagged, and its supervisor stops the CLI at its next heartbeat
 * (exit 143 is `cancelled`, not `failed`). The cancel sweep forces a job
 * whose supervisor never acknowledges.
 * @param jobId - The job.
 * @param reason - Why, e.g. `bot`, `person`, `conversation_cancelled`.
 * @returns The job after the request.
 */
export async function requestJobCancel(
  jobId: number,
  reason: string,
): Promise<SandboxJob> {
  const job = await api.db.db.transaction(async (tx) => {
    const ref = await loadJob(tx, jobId);
    if (!ref) throw jobNotFound();
    await lockConversation(tx, ref.parentConversationId);
    const row = await lockJob(tx, jobId);
    if (!row) throw jobNotFound();
    if (isTerminalJobStatus(row.status) || row.cancelRequested) return row;
    const [flagged] = await tx
      .update(sandboxJobs)
      .set({
        cancelRequested: true,
        cancelRequestedAt: new Date(),
        endReason: reason,
      })
      .where(eq(sandboxJobs.id, jobId))
      .returning();
    return flagged;
  });
  if (job.status === "pending") {
    return (await finalizeSandboxJob(jobId, { status: "cancelled", reason }))
      .job;
  }
  return job;
}

/**
 * Flag every live job of a conversation for cancellation: a person stopped
 * the conversation, so the work it started stops too.
 * @param conversationId - The conversation.
 * @param reason - Why.
 * @returns The jobs asked to stop.
 */
export async function cancelConversationJobs(
  conversationId: number,
  reason = "conversation_cancelled",
): Promise<number[]> {
  const live = await api.db.db
    .select({ id: sandboxJobs.id })
    .from(sandboxJobs)
    .where(
      and(
        eq(sandboxJobs.parentConversationId, conversationId),
        inArray(sandboxJobs.status, [
          "pending",
          ...ACTIVE_SANDBOX_JOB_STATUSES,
        ]),
      ),
    );
  for (const { id } of live) await requestJobCancel(id, reason);
  return live.map((r) => r.id);
}

/**
 * Record that the job is doing something — the stall sweep's clock. A
 * question being waited on counts: the agent is waiting on a person, not
 * stalled.
 * @param db - A database handle.
 * @param jobId - The job.
 */
export async function touchJobActivity(
  db: DbHandle,
  jobId: number,
): Promise<void> {
  await db
    .update(sandboxJobs)
    .set({ lastActivityAt: new Date() })
    .where(eq(sandboxJobs.id, jobId));
}

/**
 * Queue a message for a job. A repeated `deliveryKey` is one row.
 * @param db - A database handle.
 * @param job - The job.
 * @param message - The text, who sent it, how it is delivered, and its key.
 * @returns The row.
 */
export async function queueJobMessage(
  db: DbHandle,
  job: SandboxJob,
  message: {
    body: string;
    source: SandboxMessageSource;
    delivery: SandboxMessageDelivery;
    deliveryKey: string;
  },
): Promise<SandboxJobMessage> {
  const [row] = await db
    .insert(sandboxJobMessages)
    .values({ jobId: job.id, ...message })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [existing] = await db
    .select()
    .from(sandboxJobMessages)
    .where(eq(sandboxJobMessages.deliveryKey, message.deliveryKey))
    .limit(1);
  return existing;
}

/**
 * Hand the oldest undelivered message to a heartbeat, stamping it delivered
 * in the same statement: a claimed message is never handed out twice.
 * @param jobId - The job.
 * @param delivery - Only this delivery mode, or either.
 * @returns The message, or `null`.
 */
export async function claimNextJobMessage(
  jobId: number,
  delivery?: SandboxMessageDelivery,
): Promise<SandboxJobMessage | null> {
  const filters: SQL[] = [
    eq(sandboxJobMessages.jobId, jobId),
    isNull(sandboxJobMessages.deliveredAt),
  ];
  if (delivery) filters.push(eq(sandboxJobMessages.delivery, delivery));
  const result = await api.db.db.execute<{ id: number }>(sql`
    update ${sandboxJobMessages} set delivered_at = now()
    where id = (
      select id from ${sandboxJobMessages}
      where ${and(...filters)}
      order by id
      limit 1
      for update skip locked
    )
    returning id`);
  const id = result.rows[0]?.id;
  if (!id) return null;
  const [row] = await api.db.db
    .select()
    .from(sandboxJobMessages)
    .where(eq(sandboxJobMessages.id, id));
  return row ?? null;
}

/** A job asked something after it had ended. */
export class JobEnded extends Error {
  /** @param status - How it ended. */
  constructor(public status: string) {
    super(`This job has already ended (${status.replace("_", " ")}).`);
  }
}

/** A job asked more questions than its cap allows. */
export class QuestionCapReached extends Error {
  /** @param cap - The cap. */
  constructor(public cap: number) {
    super(`This job has already asked ${cap} questions.`);
  }
}

/**
 * Write a question, counting the job's questions under its row lock so the
 * cap holds against concurrent asks.
 * @param tx - An open transaction (the conversation already locked, if the caller relays).
 * @param jobId - The job.
 * @param draft - The question.
 * @returns The question.
 * @throws {QuestionCapReached} At the cap.
 */
export async function insertJobQuestion(
  tx: TxHandle,
  jobId: number,
  draft: Pick<
    SandboxJobQuestion,
    "kind" | "question" | "options" | "blocking" | "urgency"
  >,
): Promise<SandboxJobQuestion> {
  const job = await lockJob(tx, jobId);
  if (!job) throw jobNotFound();
  // The middleware's "live" was a snapshot; the lock is the guard.
  if (isTerminalJobStatus(job.status)) throw new JobEnded(job.status);
  const [{ n }] = await tx
    .select({ n: count() })
    .from(sandboxJobQuestions)
    .where(eq(sandboxJobQuestions.jobId, jobId));
  if (n >= config.sandbox.questionCap) {
    throw new QuestionCapReached(config.sandbox.questionCap);
  }
  const [row] = await tx
    .insert(sandboxJobQuestions)
    .values({
      jobId,
      ...draft,
      expiresAt: new Date(Date.now() + config.sandbox.questionTimeoutMs),
    })
    .returning();
  await touchJobActivity(tx, jobId);
  return row;
}

/**
 * Answer a pending question.
 * @param db - A database handle.
 * @param questionId - The question.
 * @param answer - The answer.
 * @param by - Who answered.
 * @returns The answered question, or `null` if it was no longer pending.
 */
export async function answerJobQuestion(
  db: DbHandle,
  questionId: number,
  answer: string,
  by: SandboxAnsweredBy,
): Promise<SandboxJobQuestion | null> {
  const [row] = await db
    .update(sandboxJobQuestions)
    .set({
      status: "answered",
      answer,
      answeredBy: by,
      answeredAt: new Date(),
    })
    .where(
      and(
        eq(sandboxJobQuestions.id, questionId),
        eq(sandboxJobQuestions.status, "pending"),
      ),
    )
    .returning();
  if (row) await touchJobActivity(db, row.jobId);
  return row ?? null;
}

/**
 * Read a job's question.
 * @param db - A database handle.
 * @param jobId - The job.
 * @param questionId - The question.
 * @returns The question, or `undefined` if the job has no such question.
 */
export async function loadJobQuestion(
  db: DbHandle,
  jobId: number,
  questionId: number,
): Promise<SandboxJobQuestion | undefined> {
  const [row] = await db
    .select()
    .from(sandboxJobQuestions)
    .where(
      and(
        eq(sandboxJobQuestions.id, questionId),
        eq(sandboxJobQuestions.jobId, jobId),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Expire every pending question past its time.
 * @returns How many expired.
 */
export async function expireDueQuestions(): Promise<number> {
  const rows = await api.db.db
    .update(sandboxJobQuestions)
    .set({ status: "expired", answeredAt: new Date() })
    .where(
      and(
        eq(sandboxJobQuestions.status, "pending"),
        lt(sandboxJobQuestions.expiresAt, sql`now()`),
      ),
    )
    .returning({ id: sandboxJobQuestions.id });
  return rows.length;
}

/**
 * Add one proxied request's usage to a job's measured usage, atomically.
 * @param jobId - The job.
 * @param usage - The request's input and output tokens.
 * @returns The job's usage after the add.
 */
export async function addJobUsage(
  jobId: number,
  usage: { inputTokens: number; outputTokens: number },
): Promise<SandboxJobUsage> {
  const [row] = await api.db.db
    .update(sandboxJobs)
    .set({
      usage: sql`jsonb_build_object(
        'inputTokens', coalesce((${sandboxJobs.usage}->>'inputTokens')::int, 0) + ${usage.inputTokens},
        'outputTokens', coalesce((${sandboxJobs.usage}->>'outputTokens')::int, 0) + ${usage.outputTokens},
        'requests', coalesce((${sandboxJobs.usage}->>'requests')::int, 0) + 1
      )`,
    })
    .where(eq(sandboxJobs.id, jobId))
    .returning({ usage: sandboxJobs.usage });
  return row?.usage ?? { inputTokens: 0, outputTokens: 0, requests: 0 };
}

/**
 * Whether a job has used up its token budget.
 * @param job - The job.
 * @param usage - Its usage, if fresher than the row's.
 * @returns `true` when it is at or over its budget.
 */
export function overBudget(
  job: Pick<SandboxJob, "budgetTokens" | "usage">,
  usage: SandboxJobUsage = job.usage,
): boolean {
  if (job.budgetTokens === null) return false;
  return usage.inputTokens + usage.outputTokens >= job.budgetTokens;
}

/**
 * The conversation a job belongs to.
 * @param db - A database handle.
 * @param job - The job.
 * @returns The conversation, or `undefined` if it was deleted.
 */
export async function parentOf(
  db: DbHandle,
  job: Pick<SandboxJob, "parentConversationId">,
): Promise<Conversation | undefined> {
  const [row] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, job.parentConversationId))
    .limit(1);
  return row;
}

/**
 * Shape a job for any answer. No field carries the token or its hash.
 * @param j - The row.
 * @returns The serialized job.
 */
export function serializeSandboxJob(j: SandboxJob) {
  return {
    id: j.id,
    projectId: j.projectId,
    botId: j.botId,
    parentConversationId: j.parentConversationId,
    triggeredByParticipantId: j.triggeredByParticipantId,
    triggeredByUserId: j.triggeredByUserId,
    title: j.title,
    task: j.task,
    briefing: j.briefing,
    repository: j.repository,
    interactive: j.interactive,
    status: j.status,
    provider: j.provider,
    reportedStatus: j.reportedStatus,
    statusMessage: j.statusMessage,
    closingText: j.closingText,
    artifacts: j.artifacts,
    cancelRequested: j.cancelRequested,
    exitCode: j.exitCode,
    endReason: j.endReason,
    error: j.error,
    usage: j.usage,
    cliUsage: j.cliUsage,
    budgetTokens: j.budgetTokens,
    maxDurationMs: j.maxDurationMs,
    idleTimeoutMs: j.idleTimeoutMs,
    lastHeartbeatAt: j.lastHeartbeatAt?.getTime() ?? null,
    lastActivityAt: j.lastActivityAt?.getTime() ?? null,
    startedAt: j.startedAt?.getTime() ?? null,
    endedAt: j.endedAt?.getTime() ?? null,
    createdAt: j.createdAt.getTime(),
    updatedAt: j.updatedAt.getTime(),
  };
}

/**
 * Shape a question for any answer.
 * @param q - The row.
 * @returns The serialized question.
 */
export function serializeJobQuestion(q: SandboxJobQuestion) {
  return {
    id: q.id,
    jobId: q.jobId,
    kind: q.kind,
    question: q.question,
    options: q.options,
    blocking: q.blocking,
    urgency: q.urgency,
    status: q.status,
    answer: q.answer,
    answeredBy: q.answeredBy,
    helpRequestId: q.helpRequestId,
    expiresAt: q.expiresAt.getTime(),
    createdAt: q.createdAt.getTime(),
    answeredAt: q.answeredAt?.getTime() ?? null,
  };
}

/**
 * Shape a queued message for any answer.
 * @param m - The row.
 * @returns The serialized message.
 */
export function serializeJobMessage(m: SandboxJobMessage) {
  return {
    id: m.id,
    jobId: m.jobId,
    source: m.source,
    delivery: m.delivery,
    body: m.body,
    deliveredAt: m.deliveredAt?.getTime() ?? null,
    createdAt: m.createdAt.getTime(),
  };
}

/** What any job token looks like. */
const JOB_TOKEN_PATTERN = /hyp_job_[A-Za-z0-9_-]+/g;

/**
 * Remove every job token from what a sandbox sends — its events, status,
 * questions, artifacts, closing text — before it is stored or relayed. An
 * agent that runs `env` prints its own token; stored, a project reader could
 * use it with the bot's authority while the job lives.
 * @param value - A string, or anything JSON-shaped holding strings.
 * @returns The same shape with each token replaced.
 */
export function redactJobTokens<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(JOB_TOKEN_PATTERN, "hyp_job_[redacted]") as T;
  }
  if (Array.isArray(value)) return value.map(redactJobTokens) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactJobTokens(v)]),
    ) as T;
  }
  return value;
}
