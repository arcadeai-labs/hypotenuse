import { and, eq, isNull, lte, or, sql } from "drizzle-orm";
import { api, config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/platforms";
import { platformAdapter } from "../platforms/registry";
import type {
  NormalizedInbound,
  OpenInstallation,
  PlatformAdapter,
} from "../platforms/types";
import { approvals } from "../schema/approvals";
import {
  type BotInstallation,
  botInstallations,
} from "../schema/bot_installations";
import { type Bot, bots } from "../schema/bots";
import {
  type ChannelBinding,
  channelBindings,
} from "../schema/channel_bindings";
import { type Channel, channels } from "../schema/channels";
import { type Conversation, conversations } from "../schema/conversations";
import { type TriggerEvent, triggerEvents } from "../schema/trigger_events";
import { decideApproval, serializeApproval } from "./ApprovalOps";
import { writeAuditLog } from "./AuditOps";
import {
  autoBinds,
  bindingFor,
  upsertParticipant,
  upsertPlatformChannel,
} from "./ChannelOps";
import { countMessage } from "./ChannelRateOps";
import {
  enqueueTick,
  lockConversation,
  pingConversation,
  receiveMessage,
  requestCancel,
} from "./ConversationOps";
import type { TxHandle } from "./DbOps";
import { openInstallation } from "./InstallationOps";
import { enqueueDelivery } from "./OutboxOps";
import { emitStatus } from "./SurfaceOps";

/**
 * **Processing a trigger event**: what one verified platform delivery means
 * for a bot. Ingress recorded it and answered; this runs after, in one
 * transaction per event that locks the conversation (never the installation,
 * so a token refresh holding the installation row cannot block messages).
 *
 * The rules are applied in order, and each outcome is recorded on the row:
 *
 * | # | Condition | Outcome |
 * |---|---|---|
 * | 1 | `sender.isSelf` or `sender.isBot`, or an edit or delete | `ignored: loop` |
 * | 2 | `kind: lifecycle` (uninstall, channel archived) | mark the installation or the channel; `processed: lifecycle` |
 * | 3 | the channel is externally shared, unless the binding allows it | `ignored: shared-channel` |
 * | 4 | no binding for (bot, channel), and the bot's `autoBind` is off for this kind of channel | `ignored: unbound`; the channel is upserted so a person can bind it |
 * | 5 | no binding, and `autoBind` is on | create an enabled binding with the bot's defaults (`autoBound: true`, recorded on the event); continue |
 * | 6 | the binding is disabled, or the bot is | `ignored: disabled` |
 * | 7 | `kind: message`, not addressed, mode `mentions`, and no conversation for this thread yet | `ignored: not-addressed` |
 * | 8 | `kind: signal` (`stop`, `disengage`) | cancel the conversation; `processed: signal` (`ignored: no-conversation` without one) |
 * | 9 | `kind: interaction`, or a message reading `approve <id>` / `deny <id>` under an in-channel approval policy | resolve the question or approval it targets (`InteractionOps`); `processed: interaction` or `ignored: <why>` |
 * | 10 | the participant's or the channel's rate limit is exceeded | `ignored: rate-limited` |
 * | 11 | otherwise | upsert the participant; find or create the conversation by (bot, channel, thread); insert the inbox row keyed by the message; wake; write the acknowledgement `status` row (priority `ack`) in the same transaction; `processed: message` |
 *
 * Lifecycle comes before the channel rules because an uninstall is about the
 * installation, not a channel: it must apply wherever it was sent from.
 */

/** What processing decided, written on the event. */
export interface ProcessResult {
  status: "processed" | "ignored";
  outcome: string;
  detail: Record<string, unknown>;
  /** Conversations owed a tick after commit. */
  wake: Conversation[];
  /** Conversations whose outbox rows must be delivered after commit. */
  deliver: number[];
  /** Conversations whose transcript page should re-read. */
  ping: { projectId: number; conversationId: number }[];
}

/**
 * Record a verified delivery, `INSERT … ON CONFLICT DO NOTHING`, so a retry
 * is the same row.
 * @param installation - The installation the routing key named.
 * @param externalEventId - The platform's delivery id.
 * @param messageKey - The first message's dedupe key, if any.
 * @param payload - The parsed body.
 * @returns The new row's id, or `null` for a duplicate.
 */
export async function recordTriggerEvent(
  installation: BotInstallation,
  externalEventId: string,
  messageKey: string | null,
  payload: unknown,
): Promise<number | null> {
  const [row] = await api.db.db
    .insert(triggerEvents)
    .values({
      projectId: installation.projectId,
      type: installation.type,
      botInstallationId: installation.id,
      externalEventId,
      messageKey,
      payload,
      checkAfter: new Date(Date.now() + config.platforms.processPendingGraceMs),
    })
    .onConflictDoNothing()
    .returning({ id: triggerEvents.id });
  return row?.id ?? null;
}

/**
 * Enqueue processing for an event after its row committed. An accelerant:
 * `triggers:process-pending` finds anything this loses.
 * @param triggerEventId - The event.
 */
export async function enqueueProcessing(triggerEventId: number): Promise<void> {
  try {
    await api.actions.enqueue(
      "triggers:process-event",
      { triggerEventId },
      "ingress",
    );
  } catch (e) {
    api.logger.warn("could not enqueue trigger processing", {
      triggerEventId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Events processing missed: pending, and past their grace (or their claim).
 * @param limit - The most to return.
 * @returns Their ids, oldest first.
 */
export async function pendingTriggerEventIds(limit: number): Promise<number[]> {
  const rows = await api.db.db
    .select({ id: triggerEvents.id })
    .from(triggerEvents)
    .where(
      and(
        eq(triggerEvents.status, "pending"),
        or(
          isNull(triggerEvents.checkAfter),
          lte(triggerEvents.checkAfter, new Date()),
        ),
      ),
    )
    .orderBy(triggerEvents.id)
    .limit(limit);
  return rows.map((r) => r.id);
}

/**
 * Claim an event for processing: a conditional update that pushes its
 * `checkAfter` out, so the sweep and the job do not both take it.
 * @param id - The event.
 * @param force - Take it even before its grace ends (the event's own job).
 * @returns The event, or `null` if it is not pending or someone has it.
 */
async function claimEvent(
  id: number,
  force: boolean,
): Promise<TriggerEvent | null> {
  const [row] = await api.db.db
    .update(triggerEvents)
    .set({
      attempts: sql`${triggerEvents.attempts} + 1`,
      checkAfter: new Date(Date.now() + 60_000),
    })
    .where(
      and(
        eq(triggerEvents.id, id),
        eq(triggerEvents.status, "pending"),
        force
          ? or(
              isNull(triggerEvents.checkAfter),
              sql`${triggerEvents.attempts} = 0`,
              lte(triggerEvents.checkAfter, new Date()),
            )
          : or(
              isNull(triggerEvents.checkAfter),
              lte(triggerEvents.checkAfter, new Date()),
            ),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * **Process one event.** Claims it, applies the rules in one transaction,
 * records the outcome, and after commit enqueues the ticks and deliveries
 * it owes. A failure is recorded on the row and retried by the sweep a few
 * times, then left `failed`, never retried forever.
 * @param id - The event.
 * @param force - Process now, even inside the sweep's grace.
 * @returns The status and outcome, or `null` when it was not ours to process.
 */
export async function processTriggerEvent(
  id: number,
  force = true,
): Promise<{ status: string; outcome: string | null } | null> {
  const event = await claimEvent(id, force);
  if (!event) return null;
  try {
    const result = await api.db.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(triggerEvents)
        .where(eq(triggerEvents.id, id))
        .for("update");
      if (!locked || locked.status !== "pending") return null;
      const r = await applyRules(tx, locked);
      await tx
        .update(triggerEvents)
        .set({
          status: r.status,
          outcome: r.outcome,
          detail: r.detail,
          error: null,
          processedAt: new Date(),
          checkAfter: null,
        })
        .where(eq(triggerEvents.id, id));
      return r;
    });
    if (!result) return null;
    for (const c of result.wake) await enqueueTick(c);
    if (result.deliver.length > 0) await enqueueDelivery(result.deliver);
    for (const p of result.ping) {
      await pingConversation(p.projectId, p.conversationId);
    }
    return { status: result.status, outcome: result.outcome };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const final = event.attempts >= config.platforms.processAttempts;
    await api.db.db
      .update(triggerEvents)
      .set(
        final
          ? { status: "failed", error: message, processedAt: new Date() }
          : {
              error: message,
              checkAfter: new Date(
                Date.now() + config.platforms.processPendingGraceMs,
              ),
            },
      )
      .where(eq(triggerEvents.id, id));
    api.logger.warn("a trigger event failed to process", {
      triggerEventId: id,
      attempts: event.attempts,
      error: message,
    });
    return { status: final ? "failed" : "pending", outcome: null };
  }
}

/**
 * Apply the rules to every inbound thing an event carries. One event almost
 * always carries one; the event's outcome is the last one's.
 * @param tx - The event's transaction.
 * @param event - The event, locked.
 * @returns What happened.
 */
async function applyRules(
  tx: TxHandle,
  event: TriggerEvent,
): Promise<ProcessResult> {
  const result: ProcessResult = {
    status: "ignored",
    outcome: "empty",
    detail: {},
    wake: [],
    deliver: [],
    ping: [],
  };
  const [row] = await tx
    .select({ installation: botInstallations, bot: bots })
    .from(botInstallations)
    .innerJoin(bots, eq(bots.id, botInstallations.botId))
    .where(eq(botInstallations.id, event.botInstallationId))
    .limit(1);
  if (!row) return { ...result, outcome: "uninstalled" };
  const adapter = platformAdapter(row.installation.type);
  if (!adapter) return { ...result, outcome: "no-adapter" };
  const inst = openInstallation(row.installation);
  for (const inbound of adapter.parseInbound(event.payload, inst)) {
    const one = await applyOne(tx, adapter, inst, row.bot, inbound, result);
    result.status = one.status;
    result.outcome = one.outcome;
    Object.assign(result.detail, one.detail);
  }
  return result;
}

/** One inbound's verdict. */
type Verdict = {
  status: "processed" | "ignored";
  outcome: string;
  detail: Record<string, unknown>;
};

/**
 * Apply the rules table to one inbound thing.
 * @param tx - The event's transaction.
 * @param adapter - The platform.
 * @param inst - The installation.
 * @param bot - Its bot.
 * @param inbound - What arrived.
 * @param acc - Where ticks, deliveries, and pings owed after commit collect.
 * @returns The verdict.
 */
async function applyOne(
  tx: TxHandle,
  adapter: PlatformAdapter,
  inst: OpenInstallation,
  bot: Bot,
  inbound: NormalizedInbound,
  acc: ProcessResult,
): Promise<Verdict> {
  const ignored = (outcome: string, detail: Record<string, unknown> = {}) =>
    ({ status: "ignored", outcome, detail }) as Verdict;
  const installation = inst.installation;

  // 1. Loops: our own bot, any bot, an edit or a delete.
  if (inbound.sender.isSelf || inbound.sender.isBot || inbound.edit) {
    return ignored("loop");
  }

  const ref = adapter.resolveChannel(inbound);

  // 2. Lifecycle: about the installation or the channel, wherever it came from.
  if (inbound.kind === "lifecycle") {
    if (inbound.lifecycle === "uninstall") {
      await tx
        .update(botInstallations)
        .set({ status: "uninstalled" })
        .where(eq(botInstallations.id, installation.id));
    } else {
      const channel = await upsertPlatformChannel(tx, installation, ref);
      await tx
        .update(channels)
        .set({ archived: true })
        .where(eq(channels.id, channel.id));
    }
    return {
      status: "processed",
      outcome: "lifecycle",
      detail: { lifecycle: inbound.lifecycle },
    };
  }

  const channel = await upsertPlatformChannel(tx, installation, ref);
  let binding = await bindingFor(tx, bot.id, channel.id);
  const detail: Record<string, unknown> = { channelId: channel.id };

  // 3. Externally shared channels, unless the binding opts in.
  if (channel.isShared && !binding?.allowShared) {
    return ignored("shared-channel", detail);
  }

  // 4–5. No binding: bind by the bot's default for this kind, or stop.
  if (!binding) {
    if (!autoBinds(bot, ref)) return ignored("unbound", detail);
    const [created] = await tx
      .insert(channelBindings)
      .values({
        projectId: bot.projectId,
        botId: bot.id,
        channelId: channel.id,
        mode: ref.isDm ? "dm" : "mentions",
        enabled: true,
        autoBound: true,
      })
      .onConflictDoNothing()
      .returning();
    binding = created ?? (await bindingFor(tx, bot.id, channel.id));
    detail.autoBound = true;
    detail.bindingId = binding?.id;
  }
  if (!binding) return ignored("unbound", detail);

  // 6. Disabled.
  if (!binding.enabled || !bot.enabled || channel.archived) {
    return ignored("disabled", detail);
  }

  const existing = await findConversation(
    tx,
    bot.id,
    channel.id,
    inbound.conversationKey,
  );
  if (existing) detail.conversationId = existing.id;

  // 7. Not addressed, in a mentions-only channel, outside the bot's threads.
  if (
    inbound.kind === "message" &&
    !inbound.addressed &&
    binding.mode === "mentions" &&
    !existing
  ) {
    return ignored("not-addressed", detail);
  }

  // 8. Signals.
  if (inbound.kind === "signal") {
    if (!existing) return ignored("no-conversation", detail);
    const locked = await lockConversation(tx, existing.id);
    if (!locked) return ignored("no-conversation", detail);
    const cancelled = await requestCancel(tx, locked.conversation);
    if (cancelled.kind === "requested") acc.wake.push(cancelled.conversation);
    acc.ping.push({ projectId: bot.projectId, conversationId: existing.id });
    return {
      status: "processed",
      outcome: "signal",
      detail: { ...detail, signal: inbound.signal, cancel: cancelled.kind },
    };
  }

  // 9. Interactions, and in-channel approval replies.
  const typedApproval =
    inbound.kind === "message" ? parseApprovalReply(inbound.text) : null;
  if (
    inbound.kind === "interaction" ||
    (typedApproval && binding.approvalPolicy !== "dashboard")
  ) {
    const interaction = inbound.interaction ?? typedApproval;
    if (!interaction) return ignored("malformed-interaction", detail);
    return applyInteraction(tx, {
      inst,
      bot,
      channel,
      binding,
      conversation: existing,
      inbound,
      interaction,
      detail,
      acc,
    });
  }

  // 10. Rate limits.
  const participantKey = `${installation.type}:${installation.externalWorkspaceId}:${inbound.sender.externalUserId}`;
  const rate = await countMessage(bot, channel.id, participantKey);
  if (rate.limited) {
    return ignored("rate-limited", {
      ...detail,
      scope: rate.scope,
      noticeOwed: rate.firstNotice && adapter.capabilities.ephemeral,
    });
  }

  // 11. A message: into the conversation's inbox.
  const participant = await upsertParticipant(tx, installation, inbound.sender);
  const conversation =
    existing ??
    (await createConversation(tx, bot, channel, inbound.conversationKey));
  const locked = await lockConversation(tx, conversation.id);
  if (!locked) throw new Error("The conversation vanished while processing");
  const received = await receiveMessage(tx, locked.conversation, {
    text: inbound.text ?? "",
    delivery: existing ? binding.defaultDelivery : "queue",
    deliveryKey: inbound.messageKey,
    source: "participant",
    participantId: participant.id,
  });
  if (received.woke) acc.wake.push(received.conversation);
  if (!received.duplicate) {
    const ack = await emitStatus(tx, received.conversation, "Thinking…", "ack");
    if (ack) acc.deliver.push(conversation.id);
  }
  acc.ping.push({ projectId: bot.projectId, conversationId: conversation.id });
  return {
    status: "processed",
    outcome: received.duplicate ? "duplicate" : "message",
    detail: {
      ...detail,
      conversationId: conversation.id,
      participantId: participant.id,
      inboxId: received.inbox.id,
    },
  };
}

/**
 * A bot's conversation for a thread in a channel.
 * @param tx - A transaction.
 * @param botId - The bot.
 * @param channelId - The channel.
 * @param key - The thread, session, or issue.
 * @returns The conversation, or `undefined`.
 */
async function findConversation(
  tx: TxHandle,
  botId: number,
  channelId: number,
  key: string,
): Promise<Conversation | undefined> {
  const [row] = await tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.botId, botId),
        eq(conversations.channelId, channelId),
        eq(conversations.externalConversationKey, key),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Create a bot's conversation for a thread: `INSERT … ON CONFLICT DO
 * NOTHING`, then read, because `FOR UPDATE` on a row that does not exist
 * locks nothing.
 * @param tx - A transaction.
 * @param bot - The bot.
 * @param channel - The channel.
 * @param key - The thread, session, or issue.
 * @returns The conversation.
 */
async function createConversation(
  tx: TxHandle,
  bot: Bot,
  channel: Channel,
  key: string,
): Promise<Conversation> {
  await tx
    .insert(conversations)
    .values({
      projectId: bot.projectId,
      botId: bot.id,
      channelId: channel.id,
      externalConversationKey: key,
      title: null,
      state: "hibernating",
    })
    .onConflictDoNothing();
  const found = await findConversation(tx, bot.id, channel.id, key);
  if (!found) throw new Error("The conversation could not be created");
  return found;
}

/**
 * Read `approve 41` / `deny 41` as an approval decision.
 * @param text - A message's text.
 * @returns The interaction, or `null`.
 */
export function parseApprovalReply(
  text: string | undefined,
): NormalizedInbound["interaction"] | null {
  const m = /^\s*(approve|deny)\s+#?(\d+)\s*$/i.exec(text ?? "");
  if (!m) return null;
  return { kind: "approval", targetId: m[2], value: m[1].toLowerCase() };
}

/** Everything an interaction is resolved with. */
interface InteractionInput {
  inst: OpenInstallation;
  bot: Bot;
  channel: Channel;
  binding: ChannelBinding;
  conversation: Conversation | undefined;
  inbound: NormalizedInbound;
  interaction: NonNullable<NormalizedInbound["interaction"]>;
  detail: Record<string, unknown>;
  acc: ProcessResult;
}

/**
 * **Resolve an interaction**: a button or a reply that answers a question or
 * decides an approval, routed back to the conversation waiting on it.
 *
 * | Interaction | Allowed when | Then |
 * |---|---|---|
 * | `answer` | the conversation waits on the question it targets | delivered as a message with the option's text, `source: interaction`; `processed: interaction` |
 * | `answer` | anything else | `ignored: stale-interaction` |
 * | `approval` | the binding's policy is `participants`, or `listed` and the sender is listed; the approval is pending, in this conversation | `ApprovalOps.decide` as the participant, audited as `actorType: participant`; `processed: interaction` |
 * | `approval` | policy `dashboard` | `ignored: approval-policy` |
 * | `approval` | `listed` and the sender is not listed | `ignored: approval-not-listed` |
 * | `approval` | not pending, or another conversation's | `ignored: stale-interaction` |
 * @param tx - The event's transaction.
 * @param i - The interaction and its context.
 * @returns The verdict.
 */
async function applyInteraction(
  tx: TxHandle,
  i: InteractionInput,
): Promise<Verdict> {
  const detail: Record<string, unknown> = {
    ...i.detail,
    interaction: i.interaction,
  };
  const ignored = (outcome: string) =>
    ({ status: "ignored", outcome, detail }) as Verdict;
  if (!i.conversation) return ignored("stale-interaction");
  const participant = await upsertParticipant(
    tx,
    i.inst.installation,
    i.inbound.sender,
  );
  detail.participantId = participant.id;
  const locked = await lockConversation(tx, i.conversation.id);
  if (!locked) return ignored("stale-interaction");
  const conversation = locked.conversation;

  if (i.interaction.kind === "answer") {
    const waiting = conversation.waitingOn;
    if (
      conversation.state !== "waiting" ||
      waiting?.kind !== "answer" ||
      String(waiting.questionEntryId) !== i.interaction.targetId
    ) {
      return ignored("stale-interaction");
    }
    const received = await receiveMessage(tx, conversation, {
      text: i.interaction.value,
      delivery: "queue",
      deliveryKey: i.inbound.messageKey,
      source: "participant",
      participantId: participant.id,
      metadata: { source: "interaction", targetId: i.interaction.targetId },
    });
    if (received.woke) i.acc.wake.push(received.conversation);
    i.acc.ping.push({
      projectId: conversation.projectId,
      conversationId: conversation.id,
    });
    return { status: "processed", outcome: "interaction", detail };
  }

  // An approval decision.
  const policy = i.binding.approvalPolicy;
  if (policy === "dashboard") return ignored("approval-policy");
  if (
    policy === "listed" &&
    !i.binding.approverExternalIds.includes(i.inbound.sender.externalUserId)
  ) {
    return ignored("approval-not-listed");
  }
  const approvalId = Number(i.interaction.targetId);
  const [approval] = Number.isInteger(approvalId)
    ? await tx
        .select()
        .from(approvals)
        .where(eq(approvals.id, approvalId))
        .limit(1)
    : [];
  if (
    !approval ||
    approval.conversationId !== conversation.id ||
    approval.status !== "pending" ||
    approval.expiresAt.getTime() <= Date.now()
  ) {
    return ignored("stale-interaction");
  }
  const approve = /^(approve|approved|yes|allow)$/i.test(i.interaction.value);
  const decided = await decideApproval(tx, approval.id, {
    approve,
    userId: null,
    participantId: participant.id,
    via: i.inst.installation.type as "webhook",
  });
  await writeAuditLog(tx, {
    actorType: "participant",
    participantId: participant.id,
    projectId: conversation.projectId,
    action: "approval:decide",
    targetType: "approval",
    targetPath: `${i.bot.slug}: ${approval.server}/${approval.tool}`,
    metadata: {
      approvalId: approval.id,
      decision: approve ? "approve" : "deny",
      via: i.inst.installation.type,
      policy,
      participant: participant.displayName,
      externalUserId: participant.externalUserId,
    },
    before: { approval: serializeApproval(decided.before) },
    after: { approval: serializeApproval(decided.approval) },
  });
  if (decided.woke) i.acc.wake.push(decided.woke);
  i.acc.ping.push({
    projectId: conversation.projectId,
    conversationId: conversation.id,
  });
  return {
    status: "processed",
    outcome: "interaction",
    detail: { ...detail, approvalId: approval.id, decision: approve },
  };
}

/**
 * Shape an event for any answer.
 * @param e - The row.
 * @returns The serialized event.
 */
export function serializeTriggerEvent(e: TriggerEvent) {
  return {
    id: e.id,
    projectId: e.projectId,
    type: e.type,
    botInstallationId: e.botInstallationId,
    externalEventId: e.externalEventId,
    messageKey: e.messageKey,
    status: e.status,
    outcome: e.outcome,
    detail: e.detail,
    error: e.error,
    attempts: e.attempts,
    receivedAt: e.receivedAt.getTime(),
    processedAt: e.processedAt?.getTime() ?? null,
  };
}
