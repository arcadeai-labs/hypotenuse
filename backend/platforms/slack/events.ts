import type { ChannelRef, NormalizedInbound, OpenInstallation } from "../types";

/**
 * **Slack's deliveries, read** — the Events API's `event_callback` envelopes
 * and interactivity's `block_actions` payloads, as the inbound things every
 * rule in `TriggerEventOps` reads. Each row of the table is one function;
 * anything else is read as nothing, and its event's outcome is `empty`.
 *
 * | Delivery | Condition | Becomes |
 * |---|---|---|
 * | `app_mention` | — | a message, addressed |
 * | `message` (`channels`, `groups`, `im`, `mpim`) | no `subtype`, or `file_share` / `thread_broadcast` | a message; addressed in a DM or when it mentions the bot |
 * | `message` | `subtype: message_changed` / `message_deleted` | an edit (ignored: history is the inbox) |
 * | `message` | from a bot (`bot_id`, `subtype: bot_message`) | a bot's message (ignored: the bot never hears a bot) |
 * | `message` | any other `subtype` (joins, topics, pins) | nothing |
 * | `member_joined_channel` | the joiner is the bot | `channel_joined` |
 * | `channel_left`, `group_left` | — | `channel_left` |
 * | `app_uninstalled` | — | `uninstall` |
 * | `tokens_revoked` | the bot's token is among them | `uninstall` |
 * | `agent_session_stopped` | — | the `stop` signal |
 * | `app_home_opened`, anything else | — | nothing |
 * | `block_actions` | `action_id` `q:<question>:<option>` | an answer |
 * | `block_actions` | `action_id` `a:<approval>:approve\|deny` | an approval decision |
 * | `block_actions` | anything else | nothing |
 *
 * A channel is externally shared (Slack Connect) when the envelope says
 * `is_ext_shared_channel`; the rules refuse it unless its binding opts in.
 * A thread is `thread_ts`, or the `ts` of the message that starts one, so a
 * top-level message — in a channel or a DM — starts its own conversation.
 */

/** The fields of a Slack event this module reads. */
interface SlackEvent {
  type?: string;
  subtype?: string;
  channel?: string;
  channel_type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  event_ts?: string;
  message?: { ts?: string; thread_ts?: string };
  previous_message?: { ts?: string };
  tokens?: { bot?: string[]; oauth?: string[] };
  session?: { channel_id?: string; thread_ts?: string };
}

/** An `event_callback` envelope. */
interface SlackEnvelope {
  type: "event_callback";
  team_id?: string;
  event_id?: string;
  is_ext_shared_channel?: boolean;
  event?: SlackEvent;
}

/** A `block_actions` interactivity payload. */
interface SlackBlockActions {
  type: "block_actions";
  trigger_id?: string;
  team?: { id?: string };
  user?: { id?: string; name?: string; username?: string };
  channel?: { id?: string; name?: string };
  container?: { channel_id?: string; message_ts?: string; thread_ts?: string };
  message?: { ts?: string; thread_ts?: string };
  actions?: {
    action_id?: string;
    action_ts?: string;
    value?: string;
    selected_option?: { value?: string };
  }[];
}

/**
 * The channel an event happened in.
 * @param id - Slack's channel id.
 * @param channelType - The event's `channel_type`, when it has one.
 * @param shared - Whether the envelope says it is externally shared.
 * @returns The channel reference.
 */
function channelRef(
  id: string,
  channelType: string | undefined,
  shared: boolean,
): ChannelRef {
  // `C…` public (or a private channel made after 2021), `G…` private or a
  // group DM, `D…` a DM — when the event carries no `channel_type`.
  const isDm = channelType === "im" || (!channelType && id.startsWith("D"));
  const isPrivate =
    isDm ||
    channelType === "group" ||
    channelType === "mpim" ||
    (!channelType && id.startsWith("G"));
  return { externalId: id, name: id, isPrivate, isShared: shared, isDm };
}

/**
 * The sender of an event.
 * @param e - The event.
 * @param inst - The installation.
 * @returns The sender.
 */
function senderOf(e: SlackEvent, inst: OpenInstallation) {
  const id = e.user ?? e.bot_id ?? "unknown";
  return {
    externalUserId: id,
    displayName: id,
    isBot: Boolean(e.bot_id) || e.subtype === "bot_message",
    isSelf:
      inst.installation.externalBotUserId !== null &&
      e.user === inst.installation.externalBotUserId,
  };
}

/** A lifecycle or signal inbound, which needs no sender or thread. */
function bare(
  kind: "lifecycle" | "signal",
  team: string,
  channel: ChannelRef,
  key: string,
  extra: Partial<NormalizedInbound>,
): NormalizedInbound {
  return {
    kind,
    messageKey: `${team}:${key}`,
    channel,
    conversationKey: extra.conversationKey ?? "",
    sender: {
      externalUserId: "slack",
      displayName: "Slack",
      isBot: false,
      isSelf: false,
    },
    addressed: false,
    ackDeadlineMs: 3_000,
    ...extra,
  };
}

/**
 * Read a `message` or `app_mention` event.
 * @param env - The envelope.
 * @param e - The event.
 * @param inst - The installation.
 * @returns The message, or nothing.
 */
function readMessage(
  env: SlackEnvelope,
  e: SlackEvent,
  inst: OpenInstallation,
): NormalizedInbound[] {
  const team = env.team_id ?? inst.installation.externalWorkspaceId;
  if (!e.channel) return [];
  const edit =
    e.subtype === "message_changed" || e.subtype === "message_deleted";
  const plain =
    !e.subtype ||
    e.subtype === "file_share" ||
    e.subtype === "thread_broadcast" ||
    e.subtype === "bot_message";
  if (!edit && !plain) return [];
  const ts = edit
    ? (e.message?.ts ?? e.previous_message?.ts ?? e.event_ts ?? "")
    : (e.ts ?? "");
  const thread = edit ? (e.message?.thread_ts ?? ts) : (e.thread_ts ?? ts);
  const channel = channelRef(
    e.channel,
    e.channel_type,
    env.is_ext_shared_channel === true,
  );
  const self = inst.installation.externalBotUserId;
  const mentions = Boolean(self && e.text?.includes(`<@${self}>`));
  return [
    {
      kind: "message",
      // The message, not the event: `app_mention` and `message.channels`
      // carry the same message, and the inbox keeps one.
      messageKey: edit
        ? `${team}:${e.channel}:${ts}:edit:${e.event_ts ?? ""}`
        : `${team}:${e.channel}:${ts}`,
      channel,
      conversationKey: thread,
      sender: senderOf(e, inst),
      addressed: e.type === "app_mention" || channel.isDm || mentions,
      edit,
      text: stripSelfMention(e.text ?? "", self),
      ackDeadlineMs: 3_000,
    },
  ];
}

/**
 * Remove the bot's own mention from a message's text: it is how the person
 * addressed the bot, not part of what they said.
 * @param text - The text.
 * @param self - The bot's user id.
 * @returns The text without it.
 */
function stripSelfMention(text: string, self: string | null): string {
  if (!self) return text;
  return text.split(`<@${self}>`).join("").replace(/\s+/g, " ").trim();
}

/**
 * Read an `event_callback` envelope.
 * @param env - The envelope.
 * @param inst - The installation.
 * @returns What it says.
 */
function readEnvelope(
  env: SlackEnvelope,
  inst: OpenInstallation,
): NormalizedInbound[] {
  const e = env.event ?? {};
  const team = env.team_id ?? inst.installation.externalWorkspaceId;
  const shared = env.is_ext_shared_channel === true;
  const self = inst.installation.externalBotUserId;
  switch (e.type) {
    case "app_mention":
    case "message":
      return readMessage(env, e, inst);
    case "member_joined_channel":
      if (!e.channel || !self || e.user !== self) return [];
      return [
        bare(
          "lifecycle",
          team,
          channelRef(e.channel, e.channel_type, shared),
          `joined:${e.channel}:${env.event_id}`,
          { lifecycle: "channel_joined" },
        ),
      ];
    case "channel_left":
    case "group_left":
      if (!e.channel) return [];
      return [
        bare(
          "lifecycle",
          team,
          channelRef(
            e.channel,
            e.type === "group_left" ? "group" : undefined,
            shared,
          ),
          `left:${e.channel}:${env.event_id}`,
          { lifecycle: "channel_left" },
        ),
      ];
    case "app_uninstalled":
      return [uninstall(team, env)];
    case "tokens_revoked":
      if (self && !(e.tokens?.bot ?? []).includes(self)) return [];
      return [uninstall(team, env)];
    case "agent_session_stopped": {
      const channel = e.channel ?? e.session?.channel_id;
      const thread = e.thread_ts ?? e.session?.thread_ts;
      if (!channel || !thread) return [];
      return [
        bare(
          "signal",
          team,
          channelRef(channel, e.channel_type, shared),
          `stop:${channel}:${thread}:${env.event_id}`,
          { signal: "stop", conversationKey: thread },
        ),
      ];
    }
    default:
      return [];
  }
}

/**
 * An uninstall, which belongs to no channel.
 * @param team - The workspace.
 * @param env - The envelope.
 * @returns The lifecycle inbound.
 */
function uninstall(team: string, env: SlackEnvelope): NormalizedInbound {
  return bare(
    "lifecycle",
    team,
    channelRef("workspace", undefined, false),
    `uninstall:${env.event_id}`,
    { lifecycle: "uninstall" },
  );
}

/**
 * Read a `block_actions` payload: a button or a menu on one of our messages.
 * @param p - The payload.
 * @param inst - The installation.
 * @returns The interaction, or nothing.
 */
function readBlockActions(
  p: SlackBlockActions,
  inst: OpenInstallation,
): NormalizedInbound[] {
  const action = p.actions?.[0];
  const channelId = p.channel?.id ?? p.container?.channel_id;
  const messageTs = p.message?.ts ?? p.container?.message_ts;
  if (!action?.action_id || !channelId || !messageTs || !p.user?.id) return [];
  const team = p.team?.id ?? inst.installation.externalWorkspaceId;
  const [kind, targetId, choice] = action.action_id.split(":");
  let interaction: NormalizedInbound["interaction"];
  if (kind === "q" && targetId) {
    const value = action.value ?? action.selected_option?.value;
    if (!value) return [];
    interaction = { kind: "answer", targetId, value };
  } else if (
    kind === "a" &&
    targetId &&
    (choice === "approve" || choice === "deny")
  ) {
    interaction = { kind: "approval", targetId, value: choice };
  } else {
    return [];
  }
  return [
    {
      kind: "interaction",
      messageKey: `${team}:${channelId}:${messageTs}:${action.action_id}:${action.action_ts ?? p.trigger_id ?? ""}`,
      channel: channelRef(channelId, undefined, false),
      conversationKey:
        p.message?.thread_ts ?? p.container?.thread_ts ?? messageTs,
      sender: {
        externalUserId: p.user.id,
        displayName: p.user.name ?? p.user.username ?? p.user.id,
        isBot: false,
        isSelf: false,
      },
      addressed: true,
      interaction,
      ackDeadlineMs: 3_000,
    },
  ];
}

/**
 * **Read a Slack delivery.**
 * @param body - The decoded body: an envelope, or an interactivity payload.
 * @param inst - The installation.
 * @returns What it says, often nothing.
 */
export function parseSlackDelivery(
  body: unknown,
  inst: OpenInstallation,
): NormalizedInbound[] {
  const b = (body ?? {}) as { type?: string };
  if (b.type === "event_callback") {
    return readEnvelope(body as SlackEnvelope, inst);
  }
  if (b.type === "block_actions") {
    return readBlockActions(body as SlackBlockActions, inst);
  }
  return [];
}

/**
 * The id a retry of a delivery repeats: the event's `event_id`, or for an
 * interaction its `trigger_id`.
 * @param body - The decoded body.
 * @returns The id.
 */
export function slackEventId(body: unknown): string {
  const b = (body ?? {}) as {
    type?: string;
    event_id?: string;
    trigger_id?: string;
    actions?: { action_ts?: string }[];
  };
  if (b.type === "event_callback" && b.event_id) return b.event_id;
  if (b.type === "block_actions" && b.trigger_id)
    return `action:${b.trigger_id}`;
  return `unknown:${Bun.hash(JSON.stringify(body ?? null))}`;
}
