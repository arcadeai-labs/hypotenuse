import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  APICallError,
  type LanguageModelUsage,
  stepCountIs,
  streamText,
  type ToolSet,
  tool,
} from "ai";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";
import { api, config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/agents";
import type {} from "../config/platforms";
import { surfaceAdapter } from "../platforms/registry";
import { approvals } from "../schema/approvals";
import type { Bot } from "../schema/bots";
import { channels } from "../schema/channels";
import { conversationEntries } from "../schema/conversation_entries";
import { conversationInbox } from "../schema/conversation_inbox";
import {
  type Conversation,
  conversations,
  type WaitingOn,
} from "../schema/conversations";
import { outboxMessages } from "../schema/outbox_messages";
import { availableTools, getTool } from "../tools/registry";
import {
  isSuspension,
  isToolErrorEnvelope,
  type Outbound,
  type Suspension,
  type ToolContext,
  type ToolDefinition,
  ToolError,
  type Transition,
  toolErrorEnvelope,
} from "../tools/types";
import {
  type ApprovalDraft,
  consumeApproval,
  type GateOutcome,
  insertApprovals,
  markExecuting,
} from "./ApprovalOps";
import { compactionPending, maybeEnqueueCompaction } from "./CompactionOps";
import { enqueueConsolidation, owesConsolidation } from "./ConsolidationOps";
import {
  enqueueTick,
  finalizeCancel,
  interruptedResult,
  lockConversation,
  openIntents,
  pingConversation,
  statusChange,
} from "./ConversationOps";
import { budgetExceeded, recordStepCost, reportedCostUsd } from "./CostOps";
import type { TxHandle } from "./DbOps";
import { languageModel, type ResolvedLanguageModel } from "./ModelOps";
import { HostRefused } from "./NetworkGuardOps";
import { enqueueDelivery } from "./OutboxOps";
import {
  type AssembledPrompt,
  assemblePrompt,
  diffSections,
  loadPromptInputs,
  type SectionRef,
} from "./PromptOps";
import { expandInvocation } from "./SkillOps";
import {
  emitApprovals,
  emitOutbound,
  emitPlan,
  emitStatus,
  emitStream,
} from "./SurfaceOps";
import {
  appendEntries,
  type EntryDraft,
  hydrate,
  liveEntries,
  scrubToolOutput,
} from "./TranscriptOps";

/**
 * **The tick**: one short-lived unit of the agent loop. It claims a
 * conversation's lease, recovers anything an earlier tick left half done,
 * delivers the inbox, takes model steps, records every intent before its tool
 * runs, and ends by releasing the lease — parked, rested, ended, or owed
 * another tick. Nothing lives in memory between ticks: every decision is
 * re-read from Postgres.
 *
 * | After a step | Then |
 * |---|---|
 * | a terminal tool ran | apply its transition; release, or start the next turn if messages are pending |
 * | non-terminal tools ran | the next step, in this tick |
 * | only text, not yet nudged this turn | a nudge the model sees, then one more step |
 * | only text again | the turn fails |
 * | `maxStepsPerTick` steps or `tickBudgetMs` used | yield: owe a tick, release, enqueue it |
 * | the turn used `bots.maxStepsPerTurn` steps | the turn fails, saying how many |
 * | a gated call waits for a person | the other calls' results written, then park on `approval` |
 * | a program (`run_code`) paused on gated calls | the same: park on every approval of its batch |
 */

/** This tick lost its lease: another tick owns the conversation now. */
export class LeaseLost extends Error {}

/** Someone cancelled the conversation while this tick held it. */
export class CancelRequested extends Error {}

/** The nudge a model gets once per turn when it stops without a terminal tool. */
export const NUDGE_TEXT =
  "End your turn with `reply_and_wait`, `complete`, `fail`, or `wait_for`. To send the text above, call `reply_and_wait` with it.";

/** Why a turn fails when the model goes quiet twice. */
export const QUIET_FAILURE = "The model stopped without ending its turn.";

/** What one tick did, for its log line and for tests. */
export interface TickResult {
  claimed: boolean;
  steps: number;
  /** How the tick ended. */
  ended:
    | "not-claimed"
    | "released"
    | "yielded"
    | "cancelled"
    | "lease-lost"
    | "waiting-for-compaction";
}

/**
 * Everything one tick knows about itself, threaded through its phases.
 */
interface TickState {
  owner: string;
  conversationId: number;
  projectId: number;
  controller: AbortController;
  steps: number;
  startedAt: number;
  outbox: number[];
  /** The newest step's prompt hash, to write a `context_update` on change. */
  lastPromptHash: string | null;
  /** The sections of the newest step's prompt, to diff the next one against. */
  lastSections: SectionRef[] | null;
}

/**
 * Run one tick for a conversation.
 * @param conversationId - The conversation.
 * @returns What happened.
 */
export async function runTick(conversationId: number): Promise<TickResult> {
  const owner = `${hostname()}:${process.pid}:${randomUUID()}`;
  const claimed = await claim(conversationId, owner);
  if (!claimed) return { claimed: false, steps: 0, ended: "not-claimed" };

  const state: TickState = {
    owner,
    conversationId,
    projectId: claimed.projectId,
    controller: new AbortController(),
    steps: 0,
    startedAt: Date.now(),
    outbox: [],
    lastPromptHash: null,
    lastSections: null,
  };
  const heartbeat = startHeartbeat(state);
  await pingConversation(state.projectId, conversationId);
  try {
    const ended = await loop(state);
    return { claimed: true, steps: state.steps, ended };
  } catch (error) {
    if (error instanceof LeaseLost || isAbortFrom(state, LeaseLost)) {
      return { claimed: true, steps: state.steps, ended: "lease-lost" };
    }
    if (
      error instanceof CancelRequested ||
      isAbortFrom(state, CancelRequested)
    ) {
      await cancelNow(state);
      return { claimed: true, steps: state.steps, ended: "cancelled" };
    }
    // Anything unexpected: give the lease back and owe a tick, so the reaper
    // does not wait a whole lease to retry, and log what happened.
    api.logger.error("agent:tick failed unexpectedly", {
      conversationId,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    await releaseOwing(state).catch(() => {});
    throw error;
  } finally {
    clearInterval(heartbeat);
    if (state.outbox.length > 0) await enqueueDelivery([conversationId]);
    await pingConversation(state.projectId, conversationId);
    await consolidateIfOwed(conversationId);
  }
}

/**
 * When a tick leaves its conversation at rest with enough new entries,
 * enqueue its consolidation into channel memory. An accelerant only:
 * `memory:consolidate-due` finds one this misses.
 * @param conversationId - The conversation.
 */
async function consolidateIfOwed(conversationId: number): Promise<void> {
  try {
    const [row] = await api.db.db
      .select({
        state: conversations.state,
        lastSeq: conversations.lastSeq,
        memoryConsolidatedSeq: conversations.memoryConsolidatedSeq,
      })
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    if (row && owesConsolidation(row)) {
      await enqueueConsolidation(conversationId);
    }
  } catch (e) {
    api.logger.warn("could not check whether a consolidation is owed", {
      conversationId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * **Claim**: one conditional `UPDATE` that takes the lease only if the
 * conversation is `working` and no live lease holds it. A duplicate job costs
 * this one query.
 * @param conversationId - The conversation.
 * @param owner - This tick's lease owner.
 * @returns The claimed row, or `null`.
 */
export async function claim(
  conversationId: number,
  owner: string,
): Promise<Conversation | null> {
  const [row] = await api.db.db
    .update(conversations)
    .set({
      leaseOwner: owner,
      leaseExpiresAt: sql`now() + make_interval(secs => ${config.agents.leaseMs / 1000})`,
      wakeRequestedAt: null,
    })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.state, "working"),
        sql`(${conversations.leaseExpiresAt} is null or ${conversations.leaseExpiresAt} < now())`,
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Re-check the lease and the cancel flag on a timer while a model call or a
 * tool runs, extending the lease as it goes. Losing the lease or seeing a
 * cancel aborts the tick's signal, which aborts the model stream.
 * @param state - The tick.
 * @returns The interval handle.
 */
function startHeartbeat(state: TickState): ReturnType<typeof setInterval> {
  let busy = false;
  let lastExtend = Date.now();
  return setInterval(async () => {
    if (busy || state.controller.signal.aborted) return;
    busy = true;
    try {
      const extend = Date.now() - lastExtend > config.agents.leaseMs / 3;
      const rows = extend
        ? await api.db.db
            .update(conversations)
            .set({
              leaseExpiresAt: sql`now() + make_interval(secs => ${config.agents.leaseMs / 1000})`,
            })
            .where(
              and(
                eq(conversations.id, state.conversationId),
                eq(conversations.leaseOwner, state.owner),
              ),
            )
            .returning({ cancel: conversations.cancelRequestedAt })
        : await api.db.db
            .select({ cancel: conversations.cancelRequestedAt })
            .from(conversations)
            .where(
              and(
                eq(conversations.id, state.conversationId),
                eq(conversations.leaseOwner, state.owner),
              ),
            );
      if (extend) lastExtend = Date.now();
      if (rows.length === 0) state.controller.abort(new LeaseLost());
      else if (rows[0].cancel) state.controller.abort(new CancelRequested());
    } catch {
      // A failed check is retried on the next beat; the lease outlasts many.
    } finally {
      busy = false;
    }
  }, config.agents.heartbeatMs);
}

/**
 * Whether the tick's signal was aborted with an error of a class.
 * @param state - The tick.
 * @param kind - The class.
 * @returns `true` if so.
 */
function isAbortFrom(
  state: TickState,
  kind: typeof LeaseLost | typeof CancelRequested,
): boolean {
  return (
    state.controller.signal.aborted &&
    state.controller.signal.reason instanceof kind
  );
}

/**
 * Throw if the tick was told to stop.
 * @param state - The tick.
 */
function throwIfStopped(state: TickState): void {
  if (state.controller.signal.aborted) throw state.controller.signal.reason;
}

/**
 * Run a write as the lease holder: lock the conversation (bot first), re-check
 * that this tick still owns it — **the real guard** — and extend the lease on
 * commit. A cancel seen here stops the tick before it writes.
 * @param state - The tick.
 * @param fn - The writes.
 * @param options.ignoreCancel - Write even if a cancel is pending (the cancel itself).
 * @returns What `fn` returns.
 * @throws {LeaseLost} When another tick owns the conversation.
 * @throws {CancelRequested} When a cancel is pending.
 */
async function asHolder<T>(
  state: TickState,
  fn: (tx: TxHandle, conversation: Conversation, bot: Bot) => Promise<T>,
  options: { ignoreCancel?: boolean } = {},
): Promise<T> {
  return api.db.db.transaction(async (tx) => {
    const locked = await lockConversation(tx, state.conversationId);
    if (!locked || locked.conversation.leaseOwner !== state.owner) {
      throw new LeaseLost();
    }
    if (!options.ignoreCancel && locked.conversation.cancelRequestedAt) {
      throw new CancelRequested();
    }
    const result = await fn(tx, locked.conversation, locked.bot);
    await tx
      .update(conversations)
      .set({
        leaseExpiresAt: sql`now() + make_interval(secs => ${config.agents.leaseMs / 1000})`,
      })
      .where(
        and(
          eq(conversations.id, state.conversationId),
          eq(conversations.leaseOwner, state.owner),
        ),
      );
    return result;
  });
}

/**
 * The step loop.
 * @param state - The tick.
 * @returns How it ended.
 */
async function loop(state: TickState): Promise<TickResult["ended"]> {
  if ((await recover(state)) === "released") return "released";

  // A bot whose hard budget is spent takes no step.
  const over = await asHolder(state, async (tx, conversation, bot) => {
    const exceeded = await budgetExceeded(tx, bot);
    if (!exceeded) return false;
    await failTurn(
      tx,
      state,
      conversation,
      `This bot has spent its monthly budget ($${exceeded.spent.toFixed(2)} of $${exceeded.budget.toFixed(2)}). An admin can raise it on the bot's page.`,
    );
    return true;
  });
  if (over) return "released";

  for (;;) {
    throwIfStopped(state);

    if (
      state.steps >= config.agents.maxStepsPerTick ||
      Date.now() - state.startedAt >= config.agents.tickBudgetMs
    ) {
      await releaseOwing(state);
      return "yielded";
    }

    const prepared = await asHolder(state, async (tx, conversation, bot) => {
      const startingTurn = conversation.turnBoundary;
      await deliverInbox(tx, conversation);
      const [fresh] = await tx
        .select()
        .from(conversations)
        .where(eq(conversations.id, conversation.id));
      if (fresh.stepsThisTurn >= bot.maxStepsPerTurn) {
        await failTurn(
          tx,
          state,
          fresh,
          `The turn took ${fresh.stepsThisTurn} model steps without ending, the most this bot allows (${bot.maxStepsPerTurn}). Ask again, more narrowly, or raise the bot's step limit.`,
        );
        return null;
      }
      if (startingTurn) {
        const row = await emitStatus(tx, fresh, "Thinking…");
        if (row) state.outbox.push(row.id);
      }
      return { conversation: fresh, bot };
    });
    if (!prepared) return "released";

    // Wait for a compaction only when the window is nearly full.
    if (await mustWaitForCompaction(prepared.conversation)) {
      await releaseOwing(state, config.agents.compactWaitMs);
      return "waiting-for-compaction";
    }

    const outcome = await step(state, prepared.conversation, prepared.bot);
    if (outcome === "released") return "released";
  }
}

/**
 * **Recover**: settle every intent an earlier lease left without a result.
 * A `safe` tool runs again; an `unsafe` one is reported as interrupted and
 * the model decides (it is never silently re-run).
 * @param state - The tick.
 * @returns `released` when a recovered terminal call ended the turn.
 */
async function recover(state: TickState): Promise<"continue" | "released"> {
  const open = await openIntents(api.db.db, state.conversationId);
  if (open.length === 0) return "continue";
  const rerun: typeof open = [];
  const gated: typeof open = [];
  const resumable: typeof open = [];
  await asHolder(state, async (tx, conversation) => {
    const drafts: EntryDraft[] = [];
    for (const intent of open) {
      const tool = intent.toolName ? getTool(intent.toolName) : undefined;
      if (tool?.resume) {
        resumable.push(intent);
      } else if (tool?.gate) {
        gated.push(intent);
      } else if (tool && tool.replay === "safe" && intent.replay === "safe") {
        rerun.push(intent);
      } else {
        drafts.push(interruptedResult(intent));
      }
    }
    await appendEntries(tx, conversation.id, conversation.epoch, drafts);
  });
  // A gated call that a person decided runs now, or is refused; one still
  // waiting parks the conversation again. Nothing before it is replayed.
  const parked: Parked[] = [];
  for (const intent of gated) {
    const def = getTool(String(intent.toolName)) as ToolDefinition;
    const outcome = await decideGate(state, def, intent);
    const waiting = await settleGated(state, def, intent, outcome, true);
    if (waiting) parked.push(waiting);
  }
  // A call that paused partway (a program waiting on approvals) decides
  // itself whether it goes on, waits again, or was interrupted.
  for (const intent of resumable) {
    const def = getTool(String(intent.toolName)) as ToolDefinition;
    const input = (intent.content as { input?: unknown }).input;
    const { conversation, bot } = await readConversation(state);
    const output = await invoke(
      def,
      input,
      toolContext(state, conversation, bot, intent),
      "resume",
    );
    throwIfStopped(state);
    if (isSuspension(output)) {
      parked.push({ intent, suspension: output });
      continue;
    }
    await asHolder(state, (tx, conv) =>
      appendEntries(tx, conv.id, conv.epoch, [resultDraft(intent, output)]),
    );
  }
  // As in `runCalls`: a step's terminal call runs after its other calls, so
  // a transition never parks the conversation with a call still open.
  const isTerminal = (i: (typeof rerun)[number]) =>
    Boolean(getTool(String(i.toolName))?.terminal);
  rerun.sort((a, b) => Number(isTerminal(a)) - Number(isTerminal(b)));
  for (const intent of rerun) {
    const tool = getTool(String(intent.toolName)) as ToolDefinition;
    const input = (intent.content as { input?: unknown }).input;
    const { conversation, bot } = await readConversation(state);
    const output = await invoke(
      tool,
      input,
      toolContext(state, conversation, bot, intent),
    );
    const next = await asHolder(state, async (tx, conv, b) => {
      const draft = resultDraft(intent, output);
      const [entry] = await appendEntries(tx, conv.id, conv.epoch, [draft]);
      // A recovered terminal call still makes its transition.
      if (!tool.terminal || isToolErrorEnvelope(output)) return "continue";
      const transition = tool.terminal(
        output as never,
        input as never,
        toolContext(state, conv, b, intent),
      );
      return applyTransition(tx, state, conv, transition, entry.seq);
    });
    if (next === "released") return "released";
  }
  if (parked.length > 0) {
    await parkForApprovals(state, parked);
    return "released";
  }
  return "continue";
}

/** Stands for "write an interrupted result" in {@link settleGated}. */
const INTERRUPTED = Symbol("interrupted");

/**
 * A call waiting for people: a gated call's approval on record or one to
 * write, or a paused program's {@link Suspension} with its whole batch.
 */
interface Parked {
  intent: Awaited<ReturnType<typeof openIntents>>[number];
  approvalId?: number;
  draft?: ApprovalDraft;
  suspension?: Suspension;
}

/**
 * Ask a gated tool what to do with a call. A tool's own refusal (no such
 * server, its info not read) becomes the call's error result; input that does
 * not validate is left to {@link invoke} to report.
 * @param state - The tick.
 * @param def - The tool.
 * @param intent - The call's intent.
 * @returns The gate's outcome.
 */
async function decideGate(
  state: TickState,
  def: ToolDefinition,
  intent: Awaited<ReturnType<typeof openIntents>>[number],
): Promise<GateOutcome> {
  const input = (intent.content as { input?: unknown }).input;
  const parsed = def.inputSchema.safeParse(input ?? {});
  if (!parsed.success || !def.gate) return { kind: "run" };
  const { conversation, bot } = await readConversation(state);
  const ctx = toolContext(state, conversation, bot, intent);
  try {
    return await def.gate(parsed.data, ctx);
  } catch (error) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    if (error instanceof ToolError)
      return { kind: "refuse", output: error.envelope() };
    return {
      kind: "refuse",
      output: toolErrorEnvelope(
        "tool_failed",
        `${def.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        "Try again if it may have been transient; otherwise tell the person what failed.",
      ),
    };
  }
}

/**
 * Apply a gate's outcome to one call.
 *
 * | Outcome | First run | Recovery |
 * |---|---|---|
 * | `run` | run it, write its result | interrupted: it may have run before the worker stopped |
 * | `run-approved` | mark executing (committed), run, write the result and consume the approval in one transaction | the same |
 * | `refuse` | write the refusal | the same |
 * | `interrupted` | — | interrupted; the approval consumed |
 * | `park` | returned, to park the step | the same |
 * @param state - The tick.
 * @param def - The tool.
 * @param intent - The call's intent.
 * @param outcome - What the gate decided.
 * @param recovering - Whether an earlier lease left this call open.
 * @returns The call, when it waits for a person; otherwise `null`.
 */
async function settleGated(
  state: TickState,
  def: ToolDefinition,
  intent: Awaited<ReturnType<typeof openIntents>>[number],
  outcome: GateOutcome,
  recovering: boolean,
): Promise<Parked | null> {
  const input = (intent.content as { input?: unknown }).input;
  const write = (output: unknown, approvalId?: number) =>
    asHolder(state, async (tx, conv) => {
      await appendEntries(tx, conv.id, conv.epoch, [
        output === INTERRUPTED
          ? interruptedResult(intent)
          : resultDraft(intent, output),
      ]);
      if (approvalId !== undefined) await consumeApproval(tx, approvalId);
    });
  switch (outcome.kind) {
    case "park":
      return "approvalId" in outcome
        ? { intent, approvalId: outcome.approvalId }
        : { intent, draft: outcome.draft };
    case "refuse":
      await write(outcome.output);
      return null;
    case "interrupted":
      await write(INTERRUPTED, outcome.approvalId);
      return null;
    case "run": {
      if (recovering) {
        await write(INTERRUPTED);
        return null;
      }
      const { conversation, bot } = await readConversation(state);
      const output = await invoke(
        def,
        input,
        toolContext(state, conversation, bot, intent),
      );
      throwIfStopped(state);
      await write(output);
      return null;
    }
    case "run-approved": {
      // The intent before the effect: committed before anything is sent.
      const mine = await asHolder(state, (tx) =>
        markExecuting(tx, outcome.approvalId),
      );
      if (!mine) {
        await write(INTERRUPTED, outcome.approvalId);
        return null;
      }
      const { conversation, bot } = await readConversation(state);
      const output = await invoke(
        def,
        input,
        toolContext(state, conversation, bot, intent),
      );
      throwIfStopped(state);
      await write(output, outcome.approvalId);
      return null;
    }
  }
}

/**
 * **Park for approvals**: write the approvals a step's gated calls need, queue
 * their notifications, and move the conversation to `waiting` on them — one
 * transaction. The step's other calls already have their results.
 * @param state - The tick.
 * @param parked - The calls waiting for a person.
 */
async function parkForApprovals(
  state: TickState,
  parked: Parked[],
): Promise<void> {
  await asHolder(state, async (tx, conversation, bot) => {
    const fresh = await insertApprovals(tx, conversation, bot, [
      ...parked
        .filter((p) => p.draft)
        .map((p) => ({ draft: p.draft as ApprovalDraft, intent: p.intent })),
      ...parked.flatMap((p) =>
        (p.suspension?.drafts ?? []).map((draft) => ({
          draft,
          intent: p.intent,
        })),
      ),
    ]);
    for (const p of parked) await p.suspension?.onPark?.(tx);
    if (fresh.length > 0) {
      const rows = await tx
        .select()
        .from(approvals)
        .where(inArray(approvals.id, fresh))
        .orderBy(asc(approvals.id));
      const written = await emitApprovals(tx, conversation, rows);
      state.outbox.push(...written.map((r) => r.id));
    }
    const approvalIds = [
      ...parked.flatMap((p) => (p.approvalId ? [p.approvalId] : [])),
      ...parked.flatMap((p) => p.suspension?.approvalIds ?? []),
      ...fresh,
    ];
    await park(tx, state, conversation, { kind: "approval", approvalIds });
  });
}

/**
 * The conversation and bot, read without a lock.
 * @param state - The tick.
 * @returns Both rows.
 */
async function readConversation(
  state: TickState,
): Promise<{ conversation: Conversation; bot: Bot }> {
  return api.db.db.transaction(async (tx) => {
    const locked = await lockConversation(tx, state.conversationId);
    if (!locked || locked.conversation.leaseOwner !== state.owner) {
      throw new LeaseLost();
    }
    return locked;
  });
}

/**
 * **Deliver the inbox**: claim undelivered rows and append each as a user
 * message; a person's `/<skill> args…` carries its expansion, which the model
 * reads in place of the text, and a `context_update` shows it beside the message.
 * At a turn boundary (a new turn, or a resumed wait) every pending
 * row is delivered; between the steps of a running turn only `steer` rows are.
 * @param tx - The holder's transaction.
 * @param conversation - The conversation, locked.
 */
async function deliverInbox(
  tx: TxHandle,
  conversation: Conversation,
): Promise<void> {
  const all = conversation.turnBoundary;
  const rows = await tx
    .select()
    .from(conversationInbox)
    .where(
      and(
        eq(conversationInbox.conversationId, conversation.id),
        isNull(conversationInbox.deliveredAt),
        all ? undefined : eq(conversationInbox.delivery, "steer"),
      ),
    )
    .orderBy(asc(conversationInbox.id))
    .for("update", { skipLocked: true });
  if (rows.length > 0) {
    const drafts: EntryDraft[] = [];
    for (const row of rows) {
      const fromPerson = row.source === "user" || row.source === "participant";
      const skill = fromPerson
        ? await expandInvocation(tx, conversation.botId, row.text)
        : null;
      drafts.push({
        kind: "message",
        role: "user",
        content: {
          text: row.text,
          source: row.source,
          delivery: row.delivery,
          inboxId: row.id,
          ...(skill ? { skill } : {}),
        },
        userId: row.userId,
        participantId: row.participantId,
      });
      // The transcript keeps the message as sent; the expansion the model
      // reads in its place is shown beside it.
      if (skill) drafts.push({ kind: "context_update", content: { skill } });
    }
    await appendEntries(tx, conversation.id, conversation.epoch, drafts);
    await tx
      .update(conversationInbox)
      .set({ deliveredAt: new Date() })
      .where(
        sql`${conversationInbox.id} in (${sql.join(
          rows.map((r) => sql`${r.id}`),
          sql`, `,
        )})`,
      );
  }
  if (all) {
    await tx
      .update(conversations)
      .set({ turnBoundary: false })
      .where(eq(conversations.id, conversation.id));
  }
}

/**
 * Whether this tick must wait for a compaction before its next step: the
 * newest prompt left less than the reserve of the window, and a compaction
 * that would shrink it is queued or running. Asks for one if none is.
 * @param conversation - The conversation.
 * @returns `true` to yield and come back.
 */
async function mustWaitForCompaction(
  conversation: Conversation,
): Promise<boolean> {
  const used = conversation.lastInputTokens;
  if (used === null) return false;
  const left = config.agents.contextWindowTokens - used;
  if (left >= config.agents.compactReserveTokens) return false;
  if (await compactionPending(conversation.id)) return true;
  return maybeEnqueueCompaction(conversation.id);
}

/** A tool call the model made in a step. */
interface StepCall {
  toolCallId: string;
  toolName: string;
  input: unknown;
}

/** What one model call returned. */
interface ModelAnswer {
  text: string;
  reasoning: { text: string; providerMetadata?: unknown }[];
  calls: StepCall[];
  usage: LanguageModelUsage;
  providerMetadata: unknown;
  durationMs: number;
}

/**
 * **One step**: assemble the prompt, call the model once, persist what it
 * said and the intent of every call it made, then run the calls.
 * @param state - The tick.
 * @param conversation - The conversation, as just read under the lock.
 * @param bot - Its bot.
 * @returns `continue` for another step, `released` when the lease is given up.
 */
async function step(
  state: TickState,
  conversation: Conversation,
  bot: Bot,
): Promise<"continue" | "released"> {
  const [channel] = await api.db.db
    .select()
    .from(channels)
    .where(eq(channels.id, conversation.channelId));
  const tools = await availableTools({ bot, conversation });
  const assembled = assemblePrompt(
    await loadPromptInputs(api.db.db, bot, {
      channel,
      conversation,
      mcp: tools.some((t) => t.name === "mcp_exec"),
    }),
  );
  const prompt = assembled.system;
  const hash = assembled.hash;

  let model: ResolvedLanguageModel;
  try {
    model = await languageModel(bot.projectId, bot.modelAlias);
  } catch (error) {
    await asHolder(state, (tx, conv) =>
      failTurn(
        tx,
        state,
        conv,
        error instanceof Error ? error.message : String(error),
      ),
    );
    return "released";
  }

  const { compaction, entries } = await liveEntries(api.db.db, conversation.id);
  const messages = hydrate(compaction, entries, model.provider);
  if (state.lastPromptHash === null) {
    const last = await lastContext(conversation.id);
    state.lastPromptHash = last.hash;
    state.lastSections = last.sections;
  }

  const streaming = Boolean(
    channel && surfaceAdapter(channel.type)?.capabilities.streaming,
  );
  const answer = await callModel(
    state,
    model,
    prompt,
    messages,
    tools,
    streaming ? conversation : null,
  );
  if (typeof answer === "string") {
    await asHolder(state, (tx, conv) => failTurn(tx, state, conv, answer));
    return "released";
  }

  const stepId = randomUUID();
  state.steps++;
  const persisted = await asHolder(state, async (tx, conv) => {
    const drafts: EntryDraft[] = [];
    if (hash !== state.lastPromptHash) {
      drafts.push({
        kind: "context_update",
        stepId,
        promptHash: hash,
        content: contextUpdateContent(
          assembled,
          state.lastPromptHash,
          state.lastSections ?? [],
        ),
      });
    }
    for (const r of answer.reasoning) {
      drafts.push({
        kind: "thinking",
        role: "assistant",
        stepId,
        content: {
          text: r.text,
          provider: model.provider,
          ...(r.providerMetadata
            ? { providerOptions: r.providerMetadata }
            : {}),
        },
      });
    }
    drafts.push({
      kind: "message",
      role: "assistant",
      stepId,
      promptHash: hash,
      inputTokens: answer.usage.inputTokens ?? null,
      outputTokens: answer.usage.outputTokens ?? null,
      durationMs: answer.durationMs,
      content: {
        text: answer.text,
        model: model.modelId,
        alias: bot.modelAlias,
      },
    });
    for (const call of answer.calls) {
      const def = getTool(call.toolName);
      drafts.push({
        kind: "tool_call_intent",
        role: "assistant",
        stepId,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        replay: def?.replay ?? "unsafe",
        content: { input: call.input ?? {} },
      });
    }
    const written = await appendEntries(tx, conv.id, conv.epoch, drafts);
    await recordStepCost(
      tx,
      {
        conversation: conv,
        stepId,
        modelConnectionId: model.connectionId,
        provider: model.provider,
        model: model.modelId,
      },
      answer.usage,
      reportedCostUsd(answer.providerMetadata),
    );
    const [updated] = await tx
      .update(conversations)
      .set({
        stepsThisTurn: sql`${conversations.stepsThisTurn} + 1`,
        lastInputTokens: answer.usage.inputTokens ?? conv.lastInputTokens,
      })
      .where(eq(conversations.id, conv.id))
      .returning();
    // The committed message replaces the step's partial text.
    await tx
      .update(outboxMessages)
      .set({ status: "superseded" })
      .where(
        and(
          eq(outboxMessages.conversationId, conv.id),
          eq(outboxMessages.kind, "stream"),
          sql`${outboxMessages.status} in ('pending', 'failed')`,
        ),
      );
    const plan = await emitPlan(tx, updated);
    if (plan) state.outbox.push(plan.id);
    return {
      conversation: updated,
      intents: written.filter((e) => e.kind === "tool_call_intent"),
    };
  });
  state.lastPromptHash = hash;
  state.lastSections = assembled.sections;

  const usedTokens = answer.usage.inputTokens;
  if (
    usedTokens !== undefined &&
    usedTokens >
      config.agents.contextWindowTokens - config.agents.compactBackgroundTokens
  ) {
    await maybeEnqueueCompaction(conversation.id);
  }
  await pingConversation(state.projectId, conversation.id);

  if (persisted.intents.length === 0) {
    return nudgeOrFail(state);
  }
  return runCalls(state, persisted.intents);
}

/**
 * The prompt hash of the newest step, and the sections of the newest
 * recorded prompt, from the transcript.
 * @param conversationId - The conversation.
 * @returns The hash (`null` before the first step) and the sections.
 */
async function lastContext(
  conversationId: number,
): Promise<{ hash: string | null; sections: SectionRef[] }> {
  const [row] = await api.db.db
    .select({ hash: conversationEntries.promptHash })
    .from(conversationEntries)
    .where(
      and(
        eq(conversationEntries.conversationId, conversationId),
        isNotNull(conversationEntries.promptHash),
      ),
    )
    .orderBy(desc(conversationEntries.seq))
    .limit(1);
  const [update] = await api.db.db
    .select({ content: conversationEntries.content })
    .from(conversationEntries)
    .where(
      and(
        eq(conversationEntries.conversationId, conversationId),
        eq(conversationEntries.kind, "context_update"),
        isNotNull(conversationEntries.promptHash),
      ),
    )
    .orderBy(desc(conversationEntries.seq))
    .limit(1);
  const sections = (update?.content as { sections?: SectionRef[] } | undefined)
    ?.sections;
  return { hash: row?.hash ?? null, sections: sections ?? [] };
}

/**
 * What a `context_update` records: the prompt sent, the parts it was built
 * from (each section by id and version, everything else verbatim, so the
 * prompt can be rebuilt and its hash checked), and how its sections differ
 * from the previous step's.
 * @param assembled - The new prompt.
 * @param previousPromptHash - The previous step's hash.
 * @param previousSections - The previous prompt's sections.
 * @returns The entry's content.
 */
export function contextUpdateContent(
  assembled: AssembledPrompt,
  previousPromptHash: string | null,
  previousSections: SectionRef[],
) {
  return {
    prompt: assembled.system,
    previousPromptHash,
    parts: assembled.parts,
    sections: assembled.sections,
    ...diffSections(previousSections, assembled.sections),
    dropped: assembled.dropped,
    estimatedTokens: assembled.estimatedTokens,
    budgetTokens: assembled.budgetTokens,
  };
}

/**
 * Call the model for one step, streaming. Tools are offered with no
 * `execute`, so the SDK stops at the model's calls and the tick runs them
 * itself — after recording their intents. A transient failure (429, 5xx, a
 * dropped stream) is retried; nothing was stored for the lost attempt, and
 * its cost is lost with it.
 * @param state - The tick.
 * @param model - The resolved model.
 * @param prompt - The system prompt.
 * @param messages - The hydrated messages.
 * @param tools - The tools offered.
 * @param streamTo - The conversation to write `stream` rows for, when its
 *   surface shows partial text; `null` otherwise.
 * @returns The answer, or a sentence saying why the turn must fail.
 */
async function callModel(
  state: TickState,
  model: ResolvedLanguageModel,
  prompt: string,
  messages: ReturnType<typeof hydrate>,
  tools: ToolDefinition[],
  streamTo: Conversation | null,
): Promise<ModelAnswer | string> {
  const toolSet: ToolSet = {};
  for (const t of tools) {
    toolSet[t.name] = tool({
      description: t.description,
      inputSchema: t.inputSchema as never,
    });
  }
  const attempts = Math.max(1, config.agents.modelAttempts);
  let lastError: unknown;
  // Stream rows are written in order, off the model's hot path.
  let streamed = false;
  let writes: Promise<unknown> = Promise.resolve();
  const writeStream = (text: string) => {
    if (!streamTo) return;
    streamed = true;
    writes = writes.then(async () => {
      const row = await emitStream(streamTo, text);
      if (row) state.outbox.push(row.id);
    });
  };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    throwIfStopped(state);
    const started = Date.now();
    // A dropped attempt's partial text is replaced by the retry's.
    if (attempt > 1 && streamed) writeStream("");
    try {
      const result = streamText({
        model: model.model,
        instructions: prompt,
        messages,
        tools: toolSet,
        stopWhen: stepCountIs(1),
        maxRetries: 0,
        abortSignal: state.controller.signal,
        // The error arrives as a stream part, handled below; the SDK's default
        // would also print it.
        onError: () => {},
        ...(model.options.maxOutputTokens
          ? { maxOutputTokens: model.options.maxOutputTokens }
          : {}),
        ...(model.options.temperature !== undefined
          ? { temperature: model.options.temperature }
          : {}),
        ...(model.options.providerOptions
          ? { providerOptions: model.options.providerOptions as never }
          : {}),
      });
      let lastPing = 0;
      let soFar = "";
      let written = "";
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error;
        if (part.type === "abort") throwIfStopped(state);
        if (part.type === "text-delta") {
          soFar += part.text;
          if (Date.now() - lastPing > config.platforms.streamCoalesceMs) {
            // The stream sink: the text so far in a `stream` row, then a
            // content-free ping. The stored entry is the reply.
            lastPing = Date.now();
            written = soFar;
            writeStream(soFar);
            void writes.then(() =>
              pingConversation(state.projectId, state.conversationId),
            );
          }
        }
      }
      if (soFar && soFar !== written) writeStream(soFar);
      await writes;
      throwIfStopped(state);
      const [text, reasoning, toolCalls, usage, providerMetadata] =
        await Promise.all([
          result.text,
          result.reasoning,
          result.toolCalls,
          result.usage,
          result.providerMetadata,
        ]);
      return {
        text,
        reasoning: reasoning
          .filter((r) => r.type === "reasoning" && r.text)
          .map((r) => ({
            text: (r as { text: string }).text,
            providerMetadata: (r as { providerMetadata?: unknown })
              .providerMetadata,
          })),
        calls: toolCalls.map((c) => ({
          toolCallId: c.toolCallId,
          toolName: c.toolName,
          input: c.input,
        })),
        usage,
        providerMetadata,
        durationMs: Date.now() - started,
      };
    } catch (error) {
      throwIfStopped(state);
      lastError = error;
      if (!isRetryableModelError(error)) {
        return `The model refused the request: ${modelErrorMessage(error)}`;
      }
      if (attempt < attempts) {
        await sleep(
          config.agents.modelRetryBaseMs * 2 ** (attempt - 1),
          state.controller.signal,
        );
      }
    }
  }
  return `The model could not be reached after ${attempts} attempts: ${modelErrorMessage(lastError)}`;
}

/**
 * Whether a model failure is worth another attempt.
 * @param error - What the call threw.
 * @returns `true` for 408, 409, 429, 5xx, a stream cut short, and failures
 *   with no HTTP answer.
 */
function isRetryableModelError(error: unknown): boolean {
  // A host the SSRF guard refused stays refused.
  for (let e: unknown = error; e; e = (e as { cause?: unknown }).cause) {
    if (e instanceof HostRefused) return false;
  }
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    // No status, or a 2xx whose body broke off mid-stream: nothing was refused.
    if (status === undefined || status < 300) return true;
    return status === 408 || status === 409 || status === 429 || status >= 500;
  }
  const status = (error as { statusCode?: unknown })?.statusCode;
  if (typeof status === "number") return status === 429 || status >= 500;
  return true;
}

/**
 * A model failure as one sentence.
 * @param error - What the call threw.
 * @returns The message, at most 500 characters.
 */
function modelErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 500);
}

/**
 * Sleep, waking early if the signal aborts.
 * @param ms - How long.
 * @param signal - The tick's signal.
 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * A step with no tool call: nudge once per turn, then fail the turn.
 * @param state - The tick.
 * @returns What the loop does next.
 */
async function nudgeOrFail(state: TickState): Promise<"continue" | "released"> {
  return asHolder(state, async (tx, conversation) => {
    if (!conversation.nudgedThisTurn) {
      await appendEntries(tx, conversation.id, conversation.epoch, [
        statusChange("working", "working", "nudge", {
          text: NUDGE_TEXT,
          visibleToModel: true,
        }),
      ]);
      await tx
        .update(conversations)
        .set({ nudgedThisTurn: true })
        .where(eq(conversations.id, conversation.id));
      return "continue" as const;
    }
    await failTurn(tx, state, conversation, QUIET_FAILURE);
    return "released" as const;
  });
}

/**
 * **Run the calls** of a step, each result written the moment it settles.
 * Parallel-safe calls run together, the rest in order, and the step's one
 * terminal call last; a second terminal call in the same step is refused.
 * A gated call (`mcp_exec`) asks its gate first, and a program (`run_code`)
 * may pause on gated calls of its own; when any call waits for a person, the
 * step's terminal call is not run and the conversation parks on the
 * approvals.
 * @param state - The tick.
 * @param intents - The step's intent entries.
 * @returns What the loop does next.
 */
async function runCalls(
  state: TickState,
  intents: Awaited<ReturnType<typeof openIntents>>,
): Promise<"continue" | "released"> {
  const parallel: typeof intents = [];
  const serial: typeof intents = [];
  let terminal: (typeof intents)[number] | null = null;
  const refused: typeof intents = [];
  for (const intent of intents) {
    const def = getTool(String(intent.toolName));
    if (def?.terminal) {
      if (terminal) refused.push(intent);
      else terminal = intent;
    } else if (def?.parallelSafe && !def.gate) parallel.push(intent);
    else serial.push(intent);
  }

  if (refused.length > 0) {
    await asHolder(state, (tx, conv) =>
      appendEntries(
        tx,
        conv.id,
        conv.epoch,
        refused.map((intent) =>
          resultDraft(
            intent,
            toolErrorEnvelope(
              "not_run",
              "Only one turn-ending tool may be called per step, so this call was not run.",
              "Call one turn-ending tool, after any other tools you need.",
            ),
          ),
        ),
      ),
    );
  }

  const parked: Parked[] = [];
  const runOne = async (intent: (typeof intents)[number]) => {
    throwIfStopped(state);
    const def = getTool(String(intent.toolName));
    if (def?.gate) {
      const outcome = await decideGate(state, def, intent);
      const waiting = await settleGated(state, def, intent, outcome, false);
      if (waiting) parked.push(waiting);
      return;
    }
    const input = (intent.content as { input?: unknown }).input;
    const { conversation, bot } = await readConversation(state);
    if (conversation.cancelRequestedAt) throw new CancelRequested();
    const label = def ? toolStatus(def.name, input) : null;
    if (label) {
      const row = await emitStatus(api.db.db, conversation, label);
      if (row) state.outbox.push(row.id);
    }
    const output = def
      ? await invoke(def, input, toolContext(state, conversation, bot, intent))
      : toolErrorEnvelope(
          "unknown_tool",
          `There is no tool named "${intent.toolName}".`,
          "Call one of the tools you were offered.",
        );
    throwIfStopped(state);
    if (isSuspension(output)) {
      parked.push({ intent, suspension: output });
      return;
    }
    await asHolder(state, (tx, conv) =>
      appendEntries(tx, conv.id, conv.epoch, [resultDraft(intent, output)]),
    );
  };

  await Promise.all(parallel.map(runOne));
  for (const intent of serial) await runOne(intent);

  if (parked.length > 0) {
    // A step whose calls wait for a person does not end its turn: the model
    // sees every result, approved or refused, before it decides how to.
    const waitingTerminal = terminal;
    if (waitingTerminal) {
      await asHolder(state, (tx, conv) =>
        appendEntries(tx, conv.id, conv.epoch, [
          resultDraft(
            waitingTerminal,
            toolErrorEnvelope(
              "not_run",
              "A tool call in this step is waiting for a person's approval, so this turn-ending call was not run.",
              "When the approval is decided you will see its result; end your turn then.",
            ),
          ),
        ]),
      );
    }
    await parkForApprovals(state, parked);
    return "released";
  }

  if (!terminal) return "continue";

  throwIfStopped(state);
  const def = getTool(String(terminal.toolName)) as ToolDefinition;
  const input = (terminal.content as { input?: unknown }).input;
  const { conversation, bot } = await readConversation(state);
  if (conversation.cancelRequestedAt) throw new CancelRequested();
  const ctx = toolContext(state, conversation, bot, terminal);
  const output = await invoke(def, input, ctx);
  const finalIntent = terminal;
  return asHolder(state, async (tx, conv) => {
    const [entry] = await appendEntries(tx, conv.id, conv.epoch, [
      resultDraft(finalIntent, output),
    ]);
    if (isToolErrorEnvelope(output) || !def.terminal) return "continue";
    const transition = def.terminal(output as never, input as never, ctx);
    return applyTransition(tx, state, conv, transition, entry.seq);
  });
}

/**
 * The context a tool call runs with.
 * @param state - The tick.
 * @param conversation - The conversation.
 * @param bot - Its bot.
 * @param intent - The call's intent entry.
 * @returns The context.
 */
function toolContext(
  state: TickState,
  conversation: Conversation,
  bot: Bot,
  intent: { id: number; toolCallId: string | null },
): ToolContext {
  const toolCallId = String(intent.toolCallId);
  return {
    conversation,
    bot,
    toolCallId,
    intentEntryId: intent.id,
    idempotencyKey: `hyp-${conversation.id}-${toolCallId}`,
    signal: state.controller.signal,
    db: api.db.db,
  };
}

/**
 * Validate and run one call. **Never throws** for the tool's own failures:
 * they come back as an error envelope the model reads. Only a stop of the
 * tick (cancel, lost lease) propagates.
 * @param def - The tool.
 * @param input - What the model sent.
 * @param ctx - Where it runs.
 * @param hook - `run` for a call's first run; `resume` when recovery goes on with a paused one.
 * @returns The output, an error envelope, or a {@link Suspension}.
 */
async function invoke(
  def: ToolDefinition,
  input: unknown,
  ctx: ToolContext,
  hook: "run" | "resume" = "run",
): Promise<unknown> {
  const parsed = def.inputSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return toolErrorEnvelope(
      "invalid_input",
      `The input to ${def.name} is not valid: ${parsed.error.issues
        .map((i) => `${i.path.join(".") || "input"}: ${i.message}`)
        .join("; ")}`,
      `Call ${def.name} again with input that matches its schema.`,
    );
  }
  try {
    if (hook === "resume" && def.resume) {
      return await def.resume(parsed.data, ctx);
    }
    return await def.run(parsed.data, ctx);
  } catch (error) {
    if (ctx.signal.aborted) throw ctx.signal.reason;
    if (error instanceof ToolError) return error.envelope();
    return toolErrorEnvelope(
      "tool_failed",
      `${def.name} failed: ${error instanceof Error ? error.message : String(error)}`,
      "Try again if it may have been transient; otherwise tell the person what failed.",
    );
  }
}

/**
 * The `tool_result` draft for a call, its output scrubbed of credentials.
 * @param intent - The call's intent.
 * @param output - What the tool returned, or an error envelope.
 * @returns The draft.
 */
function resultDraft(
  intent: {
    stepId: string | null;
    toolCallId: string | null;
    toolName: string | null;
  },
  output: unknown,
): EntryDraft {
  return {
    kind: "tool_result",
    role: "tool",
    stepId: intent.stepId,
    toolCallId: intent.toolCallId,
    toolName: intent.toolName,
    content: { output: scrubToolOutput(output) },
  };
}

/**
 * Apply a terminal tool's transition, in the transaction that wrote its
 * result: post its outbound message, move the state, and either release the
 * lease or — when messages are already waiting — start the next turn in this
 * tick.
 * @param tx - The holder's transaction.
 * @param state - The tick.
 * @param conversation - The conversation, locked.
 * @param transition - Where to go.
 * @param seq - The result entry's seq, which the outbound message cites.
 * @returns What the loop does next.
 */
async function applyTransition(
  tx: TxHandle,
  state: TickState,
  conversation: Conversation,
  transition: Transition,
  seq: number,
): Promise<"continue" | "released"> {
  if (transition.to === "working") return "continue";
  if (transition.outbound) {
    await post(tx, state, conversation, seq, transition.outbound);
  }
  const pending = await pendingInbox(tx, conversation.id);

  if (transition.to === "waiting") {
    // An answer already waiting satisfies the question at once.
    if (transition.waitingOn.kind === "answer" && pending) {
      await appendEntries(tx, conversation.id, conversation.epoch, [
        statusChange("working", "working", "answered"),
      ]);
      await tx
        .update(conversations)
        .set({ turnBoundary: true })
        .where(eq(conversations.id, conversation.id));
      return "continue";
    }
    await park(tx, state, conversation, transition.waitingOn);
    return "released";
  }

  const outcome = transition.to === "ended" ? transition.outcome : undefined;
  await appendEntries(tx, conversation.id, conversation.epoch, [
    statusChange("working", transition.to, transition.outbound.kind, {
      outcome,
    }),
  ]);
  if (pending) {
    await startNextTurn(tx, conversation, transition.to);
    return "continue";
  }
  await tx
    .update(conversations)
    .set({
      state: transition.to,
      outcome: outcome ?? null,
      waitingOn: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      wakeRequestedAt: null,
      cancelRequestedAt: null,
      turnBoundary: true,
    })
    .where(eq(conversations.id, conversation.id));
  return "released";
}

/**
 * Whether the conversation has inbox rows not yet in the transcript.
 * @param tx - A transaction.
 * @param conversationId - The conversation.
 * @returns `true` if any.
 */
async function pendingInbox(
  tx: TxHandle,
  conversationId: number,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: conversationInbox.id })
    .from(conversationInbox)
    .where(
      and(
        eq(conversationInbox.conversationId, conversationId),
        isNull(conversationInbox.deliveredAt),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/**
 * Begin the next turn in this tick, because messages arrived while the last
 * one ran: epoch + 1, the turn's counters reset, every pending row delivered.
 * @param tx - The holder's transaction.
 * @param conversation - The conversation, locked.
 * @param from - The state the last turn ended in.
 */
async function startNextTurn(
  tx: TxHandle,
  conversation: Conversation,
  from: "hibernating" | "ended",
): Promise<void> {
  await appendEntries(tx, conversation.id, conversation.epoch + 1, [
    statusChange(from, "working", "message"),
  ]);
  await tx
    .update(conversations)
    .set({
      epoch: conversation.epoch + 1,
      outcome: null,
      stepsThisTurn: 0,
      nudgedThisTurn: false,
      turnBoundary: true,
    })
    .where(eq(conversations.id, conversation.id));
}

/**
 * Park the conversation on a typed wait and release the lease.
 * @param tx - The holder's transaction.
 * @param state - The tick.
 * @param conversation - The conversation, locked.
 * @param waitingOn - What it waits on.
 */
async function park(
  tx: TxHandle,
  state: TickState,
  conversation: Conversation,
  waitingOn: WaitingOn,
): Promise<void> {
  await appendEntries(tx, conversation.id, conversation.epoch, [
    statusChange("working", "waiting", waitingOn.kind),
  ]);
  await tx
    .update(conversations)
    .set({
      state: "waiting",
      waitingOn,
      leaseOwner: null,
      leaseExpiresAt: null,
      wakeRequestedAt: null,
    })
    .where(
      and(
        eq(conversations.id, conversation.id),
        eq(conversations.leaseOwner, state.owner),
      ),
    );
}

/**
 * Write an outbound message to the outbox, to be delivered after commit.
 * @param tx - The holder's transaction.
 * @param state - The tick.
 * @param conversation - The conversation.
 * @param seq - The entry it came from.
 * @param outbound - What to send.
 */
async function post(
  tx: TxHandle,
  state: TickState,
  conversation: Conversation,
  seq: number,
  outbound: Outbound,
): Promise<void> {
  const row = await emitOutbound(tx, conversation, seq, outbound);
  if (row) state.outbox.push(row.id);
}

/**
 * **Fail the turn**: say why, end the conversation as `failed`, post the
 * reason to the channel, and release the lease. A failure the system decided
 * does not start another turn for pending messages; the next message does.
 * @param tx - The holder's transaction.
 * @param state - The tick.
 * @param conversation - The conversation, locked.
 * @param reason - A sentence the person can act on.
 */
async function failTurn(
  tx: TxHandle,
  state: TickState,
  conversation: Conversation,
  reason: string,
): Promise<void> {
  const open = await openIntents(tx, conversation.id);
  const written = await appendEntries(tx, conversation.id, conversation.epoch, [
    ...open.map((intent) => interruptedResult(intent)),
    statusChange("working", "ended", "turn_failed", {
      outcome: "failed",
      text: reason,
    }),
  ]);
  const entry = written[written.length - 1];
  await post(tx, state, conversation, entry.seq, {
    kind: "error",
    text: reason,
  });
  await tx
    .update(conversations)
    .set({
      state: "ended",
      outcome: "failed",
      waitingOn: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      wakeRequestedAt: null,
      turnBoundary: true,
    })
    .where(eq(conversations.id, conversation.id));
}

/**
 * **Yield**: owe a tick, release the lease, and enqueue the next tick after
 * commit. Nothing about the turn changes; the worker goes to other work.
 * @param state - The tick.
 * @param delayMs - How long the next tick waits.
 */
async function releaseOwing(state: TickState, delayMs = 0): Promise<void> {
  const [row] = await api.db.db
    .update(conversations)
    .set({
      wakeRequestedAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
    })
    .where(
      and(
        eq(conversations.id, state.conversationId),
        eq(conversations.leaseOwner, state.owner),
      ),
    )
    .returning();
  if (row) await enqueueTick(row, delayMs);
}

/**
 * Finalize a cancel this tick saw, if it still holds the lease.
 * @param state - The tick.
 */
async function cancelNow(state: TickState): Promise<void> {
  try {
    await asHolder(
      state,
      (tx, conversation) => finalizeCancel(tx, conversation),
      {
        ignoreCancel: true,
      },
    );
  } catch (error) {
    if (!(error instanceof LeaseLost)) throw error;
  }
}

/**
 * The status line a tool call shows while it runs, for the tools slow
 * enough to be worth one; `null` for the rest.
 * @param name - The tool.
 * @param input - Its input.
 * @returns The line, or `null`.
 */
export function toolStatus(name: string, input: unknown): string | null {
  const i = (input ?? {}) as Record<string, unknown>;
  if (name.startsWith("memory_")) return "Searching memory…";
  if (name === "search_history") return "Reading the history…";
  if (name === "mcp_search" || name === "mcp_list_tools" || name === "mcp_info")
    return "Looking for tools…";
  if (name === "mcp_exec") {
    return typeof i.server === "string" && typeof i.tool === "string"
      ? `Running ${i.server}/${i.tool}…`
      : "Running a tool…";
  }
  if (name === "run_code") return "Running code…";
  if (name === "escalate_to_human") return "Asking a person on the team…";
  return null;
}
