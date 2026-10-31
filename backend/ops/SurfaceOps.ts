import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { api } from "keryx";
import { platformAdapter, surfaceAdapter } from "../platforms/registry";
import { isEphemeral } from "../platforms/surface";
import {
  isRefusal,
  type OutboxDraft,
  type SurfaceContext,
} from "../platforms/types";
import type { Approval } from "../schema/approvals";
import {
  type BotInstallation,
  botInstallations,
} from "../schema/bot_installations";
import { channelBindings } from "../schema/channel_bindings";
import { type Channel, channels } from "../schema/channels";
import { conversationEntries } from "../schema/conversation_entries";
import type { Conversation } from "../schema/conversations";
import {
  type OutboxMessage,
  type OutboxPriority,
  type OutboxTarget,
  outboxMessages,
  type SurfaceKind,
} from "../schema/outbox_messages";
import type { Outbound } from "../tools/types";
import type { DbHandle } from "./DbOps";

/**
 * **The interactive surface**: turns what a tick does — it started, it is
 * running a tool, the model is writing, it asked, it needs an approval, it
 * answered — into outbox rows, shaped by the conversation's surface adapter
 * and its capabilities. No caller asks which platform it is on.
 *
 * | Kind | Written by | Supersedes |
 * |---|---|---|
 * | `status` | a turn's start ("Thinking…"), a slow tool ("Searching memory…"), a wait for approval, an escalation | the older undelivered `status` |
 * | `stream` | the model's text, coalesced every 250 ms | the older undelivered `stream` |
 * | `plan` | each step of the turn | the turn's older undelivered `plan` |
 * | `message` | `reply_and_wait`, `complete`, `fail`, a failed turn | every undelivered ephemeral row |
 * | `question` | `ask_question` | every undelivered ephemeral row |
 * | `approval` | the gate parking a call | — |
 *
 * **Nothing follows a question**: while a conversation waits on an answer,
 * every row is dropped at enqueue unless it is the answer's acknowledgement.
 * Linear derives a session's state from its last activity, and anything
 * after an elicitation breaks it; the rule holds everywhere.
 */

/** A row to write, before the adapter shapes it. */
export interface SurfaceDraft {
  kind: SurfaceKind;
  payload: Record<string, unknown>;
  /** The transcript entry it came from; the newest entry when omitted. */
  seq?: number;
  priority?: OutboxPriority;
  /** Write even while the conversation waits on an answer. */
  acknowledgesAnswer?: boolean;
}

/**
 * Where a conversation's rows go: its channel, its adapter's context, and the
 * outbox target.
 * @param db - A database handle.
 * @param conversation - The conversation.
 * @returns The context and target, or `null` for a channel with no surface.
 */
export async function surfaceContext(
  db: DbHandle,
  conversation: Conversation,
): Promise<{ ctx: SurfaceContext; target: OutboxTarget } | null> {
  const [channel] = await db
    .select()
    .from(channels)
    .where(eq(channels.id, conversation.channelId))
    .limit(1);
  if (!channel) return null;
  let installation: BotInstallation | null = null;
  let target: OutboxTarget;
  if (channel.type === "api") {
    target = { type: "api-callback", url: conversation.callbackUrl ?? "" };
  } else if (channel.type === "web") {
    target = { type: "web" };
  } else {
    const adapter = platformAdapter(channel.type);
    if (!adapter) return null;
    installation = await installationFor(db, conversation.botId, channel);
    target = (adapter.target?.(
      channel,
      conversation.externalConversationKey,
    ) ?? {
      type: "platform",
      platform: channel.type,
      channelExternalId: channel.externalId,
      conversationKey: conversation.externalConversationKey,
    }) as OutboxTarget;
  }
  return { ctx: { conversation, channel, installation }, target };
}

/**
 * The installation a bot speaks through in a platform channel: its own app
 * in the channel's workspace.
 * @param db - A database handle.
 * @param botId - The bot.
 * @param channel - The platform channel.
 * @returns The installation, or `null` if the bot has none there.
 */
export async function installationFor(
  db: DbHandle,
  botId: number,
  channel: Channel,
): Promise<BotInstallation | null> {
  const workspace = channel.externalId.split("/")[0];
  const [row] = await db
    .select()
    .from(botInstallations)
    .where(
      and(
        eq(botInstallations.botId, botId),
        eq(botInstallations.type, channel.type),
        eq(botInstallations.externalWorkspaceId, workspace),
      ),
    )
    .limit(1);
  return row ?? null;
}

/** The supersession key of a kind, per conversation. */
function supersedesKeyOf(kind: SurfaceKind, conversation: Conversation) {
  if (kind === "plan") return `plan:${conversation.epoch}`;
  if (kind === "status" || kind === "stream") return kind;
  return null;
}

/**
 * **Write one surface row**, in the caller's transaction (or with no lock, for
 * an ephemeral row written mid-step). Refused at enqueue when the adapter
 * says the row is malformed: the throw points at its writer.
 * @param db - A transaction, or the shared handle.
 * @param conversation - The conversation, as the writer last read it.
 * @param draft - The row.
 * @returns The row written, or `null` when this surface has no use for it.
 * @throws {Error} When the adapter refuses the row.
 */
export async function emit(
  db: DbHandle,
  conversation: Conversation,
  draft: SurfaceDraft,
): Promise<OutboxMessage | null> {
  if (
    conversation.state === "waiting" &&
    conversation.waitingOn?.kind === "answer" &&
    !draft.acknowledgesAnswer
  ) {
    return null;
  }
  const found = await surfaceContext(db, conversation);
  if (!found) return null;
  const adapter = surfaceAdapter(found.ctx.channel.type);
  if (!adapter) return null;
  const seq = draft.seq ?? conversation.lastSeq;
  const shaped = adapter.validateOutbound(
    {
      kind: draft.kind,
      payload: { ...draft.payload, entrySeq: seq },
      priority: draft.priority ?? "normal",
      supersedesKey: supersedesKeyOf(draft.kind, conversation),
    } satisfies OutboxDraft,
    found.ctx,
  );
  if (shaped === null) return null;
  if (isRefusal(shaped)) {
    throw new Error(
      `The ${found.ctx.channel.type} surface refused a ${draft.kind} row: ${shaped.reason}`,
    );
  }
  // A final row makes every undelivered progress row stale; an ephemeral
  // row makes the older one of its key stale.
  const stale = isEphemeral(shaped.kind)
    ? shaped.supersedesKey
      ? [eq(outboxMessages.supersedesKey, shaped.supersedesKey)]
      : []
    : shaped.kind === "approval"
      ? []
      : [inArray(outboxMessages.kind, ["status", "stream", "plan"])];
  if (stale.length > 0) {
    await db
      .update(outboxMessages)
      .set({ status: "superseded" })
      .where(
        and(
          eq(outboxMessages.conversationId, conversation.id),
          inArray(outboxMessages.status, ["pending", "failed"]),
          ...stale,
        ),
      );
  }
  const now = new Date();
  const [row] = await db
    .insert(outboxMessages)
    .values({
      projectId: conversation.projectId,
      conversationId: conversation.id,
      seq,
      kind: shaped.kind,
      payload: shaped.payload,
      target: found.target,
      botInstallationId: found.ctx.installation?.id ?? null,
      priority: shaped.priority,
      supersedesKey: shaped.supersedesKey,
      ...(adapter.settlesAtEnqueue ? { status: "sent", sentAt: now } : {}),
    })
    .returning();
  return row;
}

/**
 * Write a terminal tool's message (or a failed turn's error) to the surface.
 * @param db - The holder's transaction.
 * @param conversation - The conversation.
 * @param seq - The entry it came from.
 * @param outbound - What to send.
 * @returns The row, or `null`.
 */
export async function emitOutbound(
  db: DbHandle,
  conversation: Conversation,
  seq: number,
  outbound: Outbound,
): Promise<OutboxMessage | null> {
  if (outbound.kind === "question") {
    return emit(db, conversation, {
      kind: "question",
      seq,
      payload: {
        text: outbound.text,
        ...(outbound.options ? { options: outbound.options } : {}),
        ...(outbound.questionEntryId
          ? { questionEntryId: outbound.questionEntryId }
          : {}),
      },
    });
  }
  return emit(db, conversation, {
    kind: "message",
    seq,
    payload: { messageKind: outbound.kind, text: outbound.text },
  });
}

/**
 * Write a status line. **Never throws**: a status is progress, and a failure
 * to show it must not fail the work.
 * @param db - A database handle.
 * @param conversation - The conversation.
 * @param text - The line.
 * @param priority - `ack` for the acknowledgement of a message.
 * @returns The row, or `null`.
 */
export async function emitStatus(
  db: DbHandle,
  conversation: Conversation,
  text: string,
  priority: OutboxPriority = "normal",
): Promise<OutboxMessage | null> {
  try {
    return await emit(db, conversation, {
      kind: "status",
      payload: { text },
      priority,
      acknowledgesAnswer: priority === "ack",
    });
  } catch (e) {
    api.logger.warn("could not write a status row", {
      conversationId: conversation.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Write the model's text so far, coalesced by the caller. **Never throws.**
 * @param conversation - The conversation.
 * @param text - Everything the model has written in this step.
 * @returns The row, or `null`.
 */
export async function emitStream(
  conversation: Conversation,
  text: string,
): Promise<OutboxMessage | null> {
  try {
    return await emit(api.db.db, conversation, {
      kind: "stream",
      payload: { text },
      priority: "bulk",
    });
  } catch (e) {
    api.logger.warn("could not write a stream row", {
      conversationId: conversation.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/** One step of a turn's plan. */
export interface PlanStep {
  seq: number;
  tool: string;
  state: "running" | "done" | "error";
}

/**
 * The current turn's tool steps, from the transcript.
 * @param db - A database handle.
 * @param conversation - The conversation.
 * @returns One step per call this turn, oldest first.
 */
export async function turnPlan(
  db: DbHandle,
  conversation: Conversation,
): Promise<PlanStep[]> {
  const rows = await db
    .select({
      seq: conversationEntries.seq,
      kind: conversationEntries.kind,
      stepId: conversationEntries.stepId,
      toolCallId: conversationEntries.toolCallId,
      toolName: conversationEntries.toolName,
      isError: sql<boolean>`coalesce((${conversationEntries.content}->'output'->>'is_error')::boolean, false)`,
    })
    .from(conversationEntries)
    .where(
      and(
        eq(conversationEntries.conversationId, conversation.id),
        eq(conversationEntries.epoch, conversation.epoch),
        inArray(conversationEntries.kind, ["tool_call_intent", "tool_result"]),
      ),
    )
    .orderBy(asc(conversationEntries.seq));
  const steps = new Map<string, PlanStep>();
  for (const r of rows) {
    const key = `${r.stepId}:${r.toolCallId}`;
    if (r.kind === "tool_call_intent") {
      steps.set(key, {
        seq: r.seq,
        tool: String(r.toolName),
        state: "running",
      });
    } else {
      const s = steps.get(key);
      if (s) s.state = r.isError ? "error" : "done";
    }
  }
  return [...steps.values()];
}

/**
 * Write the turn's plan. **Never throws.**
 * @param db - The holder's transaction.
 * @param conversation - The conversation.
 * @returns The row, or `null`.
 */
export async function emitPlan(
  db: DbHandle,
  conversation: Conversation,
): Promise<OutboxMessage | null> {
  try {
    const steps = await turnPlan(db, conversation);
    if (steps.length === 0) return null;
    return await emit(db, conversation, {
      kind: "plan",
      payload: { steps },
      priority: "bulk",
    });
  } catch (e) {
    api.logger.warn("could not write a plan row", {
      conversationId: conversation.id,
      error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

/**
 * Write the approval requests a step parked on, after the status that says
 * why it waits.
 * @param db - The holder's transaction.
 * @param conversation - The conversation.
 * @param rows - The approvals just written.
 * @returns The rows written.
 */
export async function emitApprovals(
  db: DbHandle,
  conversation: Conversation,
  rows: Approval[],
): Promise<OutboxMessage[]> {
  if (rows.length === 0) return [];
  const [binding] = await db
    .select({ policy: channelBindings.approvalPolicy })
    .from(channelBindings)
    .where(
      and(
        eq(channelBindings.botId, conversation.botId),
        eq(channelBindings.channelId, conversation.channelId),
      ),
    )
    .limit(1);
  // The dashboard chat decides in its card, under approval:decide's gate.
  const inChannel = Boolean(binding && binding.policy !== "dashboard");
  const names = rows.map((r) => `${r.server}/${r.tool}`).join(", ");
  const out: OutboxMessage[] = [];
  const status = await emitStatus(
    db,
    conversation,
    `Waiting for approval to run ${names}`,
  );
  if (status) out.push(status);
  for (const r of rows) {
    const row = await emit(db, conversation, {
      kind: "approval",
      payload: {
        approvalId: r.id,
        server: r.server,
        tool: r.tool,
        name: `${r.server}/${r.tool}`,
        args: r.args,
        inChannel,
        actions: inChannel ? ["approve", "deny"] : [],
      },
    });
    if (row) out.push(row);
  }
  return out;
}

/** The kinds that end what the live surface shows. */
const FINAL_KINDS = ["message", "question"];

/**
 * **The live read**: the newest status, stream, and plan rows still current
 * for a conversation. Nothing is current once it rests or ends; a row older
 * than the newest final message is stale; a `stream` row is current only
 * while no transcript entry has been written since it began (so a step's
 * committed message, or a retry's first row, replaces it).
 * @param db - A database handle.
 * @param conversation - The conversation.
 * @returns The current row of each ephemeral kind, or `null`.
 */
export async function liveSurface(db: DbHandle, conversation: Conversation) {
  const none = { status: null, stream: null, plan: null } as Record<
    "status" | "stream" | "plan",
    { id: number; text?: string; steps?: PlanStep[]; at: number } | null
  >;
  if (conversation.state === "hibernating" || conversation.state === "ended") {
    return none;
  }
  const [final] = await db
    .select({ id: outboxMessages.id })
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.conversationId, conversation.id),
        inArray(outboxMessages.kind, FINAL_KINDS),
      ),
    )
    .orderBy(desc(outboxMessages.id))
    .limit(1);
  const rows = await db
    .selectDistinctOn([outboxMessages.kind])
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.conversationId, conversation.id),
        inArray(outboxMessages.kind, ["status", "stream", "plan"]),
        sql`${outboxMessages.status} <> 'superseded'`,
        final ? gt(outboxMessages.id, final.id) : undefined,
      ),
    )
    .orderBy(outboxMessages.kind, desc(outboxMessages.id));
  const out = { ...none };
  for (const r of rows) {
    if (r.kind === "stream" && r.seq !== conversation.lastSeq) continue;
    const p = r.payload as { text?: string; steps?: PlanStep[] };
    out[r.kind as "status" | "stream" | "plan"] = {
      id: r.id,
      ...(p.text !== undefined ? { text: p.text } : {}),
      ...(p.steps ? { steps: p.steps } : {}),
      at: r.createdAt.getTime(),
    };
  }
  return out;
}
