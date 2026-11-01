import { createHash } from "node:crypto";
import { config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/platforms";
import { pylonHtmlToText } from "../../ops/PylonMarkdownOps";
import type {
  PylonAccount,
  PylonIssue,
  PylonMessage,
} from "../../ops/PylonOps";
import type { ChannelRef, NormalizedInbound, OpenInstallation } from "../types";

/**
 * **Pylon's deliveries, read.** Pylon has no fixed webhook events: a webhook
 * is an action ("Send webhook") of a **Trigger** a Pylon admin builds, and its
 * body is a template they write, with every value a string
 * (https://docs.usepylon.com/pylon-docs/developer/webhooks). Hypotenuse asks
 * for four Triggers, each sending the same small body with its own `event`
 * (see {@link PYLON_TRIGGERS}): ids only, because a value Pylon pastes into a
 * JSON string is not escaped for one, and an issue title or a message with a
 * double quote would break the body. Everything else — the issue, its
 * account, the message — is read from Pylon's API before processing
 * (`hydrate`), outside the transaction, and stored on the event.
 *
 * | `event` (Trigger kickoff) | Condition | Becomes |
 * |---|---|---|
 * | `issue_created` ("New issue created") | `triggers.autoTriage` on, and the issue is in a listened team and tag | a message, addressed, from the requester (untrusted): the issue's title and body; the account is the channel |
 * | `issue_created` | otherwise | `noted: auto-triage-off` / `not-listened` |
 * | `issue_assigned` ("Issue assigned") | assigned to the bot, `triggers.assignment` on | a message, addressed: "assigned to you", the issue's title and body; the conversation remembers it was assigned (`assignedIssueId`) |
 * | `issue_assigned` | assigned to anyone else | `disengage` the conversations the bot was assigned on this issue |
 * | `issue_message` ("Issue has a new message") | written by the bot's own token, or another bot's of this project | a message from itself or a bot (`ignored: loop`) |
 * | `issue_message` | an internal note that mentions the bot by name (`triggers.mention`), or reads `approve <id>` / `deny <id>` | a message, addressed, from the teammate, the mention cut out: answers a question, decides an approval |
 * | `issue_message` | any other internal note | `noted: note-not-addressed` |
 * | `issue_message` | a customer's message | a message, not addressed, untrusted: continues a conversation the bot already has on the issue |
 * | `issue_message` | a teammate's customer-facing reply | `noted: teammate-reply` |
 * | `issue_status_changed` ("Issue status changed") | the issue is `closed` | `disengage` the issue's conversations |
 * | `issue_status_changed` | otherwise | `noted: status-<state>` |
 * | anything else, or an issue Pylon no longer has | — | `noted: ignored-<event>` / `issue-not-found` |
 *
 * **Channels.** An issue's channel — its memory boundary — is its account,
 * the customer company (`account:<id>`), with the account's domains in its
 * details; an issue with no account is in the installation's `unassigned`
 * channel. **Conversations** are issues (`issue:<id>`).
 */

/** The webhook body a Trigger sends, as Hypotenuse asks for it. */
export interface PylonWebhookBody {
  event?: string;
  issue_id?: string;
  status?: string;
  assignee_id?: string;
  message_id?: string;
  /** What `hydrate` read, stored on the event before processing. */
  hydrated?: PylonHydrated;
}

/** What `hydrate` read from Pylon for one delivery. */
export interface PylonHydrated {
  issue?: PylonIssue | null;
  account?: PylonAccount | null;
  message?: PylonMessage | null;
  /** Every Pylon user id one of this project's bots posts as. */
  botUserIds?: string[];
  /** The issue no longer exists (or the token cannot see it). */
  missing?: boolean;
}

/** One Trigger an admin creates in Pylon, and the body its webhook sends. */
export interface PylonTrigger {
  event: string;
  /** The Trigger's kickoff, as Pylon names it. */
  kickoff: string;
  /** The webhook body template to paste. */
  body: string;
}

/**
 * The webhook body template for one event.
 * @param event - The event name Hypotenuse reads.
 * @returns The JSON template, with Pylon's `{{ … }}` variables.
 */
function template(event: string): string {
  return JSON.stringify(
    {
      event,
      issue_id: "{{ issue.id }}",
      status: "{{ issue.status }}",
      assignee_id: "{{ issue.assignee.id }}",
      message_id: "{{ issue.last_message.id }}",
    },
    null,
    2,
  );
}

/** The four Triggers a bot's Pylon webhook is fed by. */
export const PYLON_TRIGGERS: PylonTrigger[] = [
  { event: "issue_created", kickoff: "New issue created" },
  { event: "issue_message", kickoff: "Issue has a new message" },
  { event: "issue_assigned", kickoff: "Issue assigned" },
  { event: "issue_status_changed", kickoff: "Issue status changed" },
].map((t) => ({ ...t, body: template(t.event) }));

/** The events Hypotenuse reads. */
export const PYLON_EVENTS = PYLON_TRIGGERS.map((t) => t.event);

/** The installation's triggers, as configured. */
interface Triggers {
  autoTriage: boolean;
  mention: boolean;
  assignment: boolean;
}

/**
 * An installation's triggers, defaults filled in (every one on).
 * @param inst - The installation.
 * @returns The triggers.
 */
function triggersOf(inst: OpenInstallation): Triggers {
  const t = (inst.installation.config.triggers ?? {}) as Partial<Triggers>;
  return {
    autoTriage: t.autoTriage !== false,
    mention: t.mention !== false,
    assignment: t.assignment !== false,
  };
}

/**
 * Whether an issue is in what the bot listens to: a listed team (any, when
 * none is listed) and a listed tag (any, when none is listed).
 * @param inst - The installation.
 * @param issue - The issue.
 * @returns `true` when it is.
 */
export function listensTo(inst: OpenInstallation, issue: PylonIssue): boolean {
  const listen = (inst.installation.config.listen ?? {}) as {
    teamIds?: string[];
    tags?: string[];
  };
  const teams = listen.teamIds ?? [];
  const tags = listen.tags ?? [];
  if (teams.length > 0 && !teams.includes(issue.team?.id ?? "")) return false;
  if (tags.length > 0 && !(issue.tags ?? []).some((t) => tags.includes(t))) {
    return false;
  }
  return true;
}

/**
 * The channel an issue belongs to: its account, or `unassigned`.
 * @param issue - The issue.
 * @param account - Its account, as read.
 * @returns The channel reference.
 */
export function issueChannel(
  issue: PylonIssue | null | undefined,
  account: PylonAccount | null | undefined,
): ChannelRef {
  const id = account?.id ?? issue?.account?.id;
  if (!id) {
    return {
      externalId: "unassigned",
      name: "Issues with no account",
      isPrivate: false,
      isShared: false,
      isDm: false,
      details: { domains: [] },
    };
  }
  const domains = [
    ...new Set(
      [
        ...(account?.domains ?? []),
        account?.primary_domain,
        account?.domain,
      ].filter((d): d is string => typeof d === "string" && d !== ""),
    ),
  ];
  return {
    externalId: `account:${id}`,
    name: account?.name ?? `Account ${id.slice(0, 8)}`,
    isPrivate: false,
    isShared: false,
    isDm: false,
    details: { accountId: id, domains },
  };
}

/** The Pylon "user" every non-message inbound is attributed to. */
const PYLON = {
  externalUserId: "pylon",
  displayName: "Pylon",
  isBot: false,
  isSelf: false,
};

/** Pylon waits up to 20 seconds for an answer. */
const ACK_DEADLINE_MS = 20_000;

/**
 * A lifecycle inbound.
 * @param key - The dedupe key.
 * @param extra - The lifecycle and its fields.
 * @returns The inbound.
 */
function lifecycle(
  key: string,
  extra: Partial<NormalizedInbound>,
): NormalizedInbound {
  return {
    kind: "lifecycle",
    messageKey: key,
    channel: issueChannel(null, null),
    conversationKey: "",
    sender: PYLON,
    addressed: false,
    ackDeadlineMs: ACK_DEADLINE_MS,
    ...extra,
  };
}

/**
 * A decided outcome that changes nothing.
 * @param key - The dedupe key.
 * @param note - The outcome.
 * @returns The inbound.
 */
function noted(key: string, note: string): NormalizedInbound {
  return lifecycle(key, { lifecycle: "noted", note });
}

/**
 * Escape a string for a regular expression.
 * @param s - The string.
 * @returns It, escaped.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The names a teammate mentions the bot by: its token identity's name.
 * @param inst - The installation.
 * @returns The names, longest first.
 */
function selfNames(inst: OpenInstallation): string[] {
  const name = String(inst.installation.config.selfName ?? "").trim();
  if (name.length < 2) return [];
  return [...new Set([name, name.replace(/\s+/g, "")])].sort(
    (a, b) => b.length - a.length,
  );
}

/**
 * Find and cut a mention of the bot out of a note.
 * @param text - The note, as text.
 * @param names - The bot's names.
 * @returns Whether it mentioned the bot, and the text without the mention.
 */
export function cutMention(
  text: string,
  names: string[],
): { mentioned: boolean; text: string } {
  let mentioned = false;
  let out = text;
  for (const name of names) {
    const re = new RegExp(
      `(^|[^\\w@])@?${escapeRegExp(name)}(?!\\w)[,:]?`,
      "gi",
    );
    out = out.replace(re, (_, lead: string) => {
      mentioned = true;
      return lead;
    });
  }
  return { mentioned, text: out.replace(/[ \t]{2,}/g, " ").trim() };
}

/**
 * The first message of an issue's conversation.
 * @param head - What happened ("A new Pylon issue", "Assigned to you").
 * @param issue - The issue.
 * @param account - Its account.
 * @returns The text.
 */
function openingText(
  head: string,
  issue: PylonIssue,
  account: PylonAccount | null | undefined,
): string {
  const title = `${head}: #${issue.number ?? "?"} ${issue.title ?? ""}`.trim();
  const lines = [issue.link ? `${title} (${issue.link})` : title];
  if (account?.name) lines.push(`Customer: ${account.name}`);
  if (issue.requester?.email) lines.push(`Requester: ${issue.requester.email}`);
  const body = pylonHtmlToText(issue.body_html);
  return body ? `${lines.join("\n")}\n\n${body}` : lines.join("\n");
}

/**
 * **Read a Pylon delivery**, once `hydrate` has read what it points at.
 * Before that (at ingress) it reads nothing.
 * @param body - The parsed body, with `hydrated`.
 * @param inst - The installation.
 * @returns What it says.
 */
export function parsePylonDelivery(
  body: unknown,
  inst: OpenInstallation,
): NormalizedInbound[] {
  const b = (body ?? {}) as PylonWebhookBody;
  const h = b.hydrated;
  if (!h) return [];
  const event = String(b.event ?? "unknown");
  const issueId = String(b.issue_id ?? "");
  const key = `issue:${issueId}:${event}`;
  if (!PYLON_EVENTS.includes(event)) return [noted(key, `ignored-${event}`)];
  if (!issueId || h.missing || !h.issue) return [noted(key, "issue-not-found")];
  const issue = h.issue;
  const channel = issueChannel(issue, h.account);
  const conversationKey = `issue:${issue.id}`;
  const details = {
    issueId: issue.id,
    number: issue.number ?? null,
    link: issue.link ?? null,
    accountId: issue.account?.id ?? null,
  };
  const self = inst.installation.externalBotUserId;
  const triggers = triggersOf(inst);

  switch (event) {
    case "issue_created": {
      if (!triggers.autoTriage) return [noted(key, "auto-triage-off")];
      if (!listensTo(inst, issue)) return [noted(key, "not-listened")];
      const requester = issue.requester;
      return [
        {
          kind: "message",
          // The first message's id, so its "new message" delivery is the same message.
          messageKey: b.message_id ? `message:${b.message_id}` : key,
          channel,
          conversationKey,
          sender: {
            externalUserId: requester ? `contact:${requester.id}` : "pylon",
            displayName: requester?.email ?? "Customer",
            isBot: false,
            isSelf: false,
          },
          addressed: true,
          untrusted: true,
          text: openingText("A new Pylon issue", issue, h.account),
          conversationDetails: details,
          ackDeadlineMs: ACK_DEADLINE_MS,
        },
      ];
    }
    case "issue_assigned": {
      const assignee = issue.assignee?.id ?? null;
      if (!self || assignee !== self) {
        return [
          lifecycle(`${key}:${assignee ?? "nobody"}`, {
            lifecycle: "disengage",
            disengage: { key: "assignedIssueId", values: [issue.id] },
          }),
        ];
      }
      if (!triggers.assignment) return [noted(key, "assignment-off")];
      return [
        {
          kind: "message",
          messageKey: `${key}:${self}`,
          channel,
          conversationKey,
          sender: PYLON,
          addressed: true,
          text: openingText("Assigned to you in Pylon", issue, h.account),
          conversationDetails: { ...details, assignedIssueId: issue.id },
          ackDeadlineMs: ACK_DEADLINE_MS,
        },
      ];
    }
    case "issue_status_changed": {
      if (issue.state === "closed") {
        return [
          lifecycle(`${key}:closed`, {
            lifecycle: "disengage",
            disengage: { key: "issueId", values: [issue.id] },
          }),
        ];
      }
      return [
        noted(`${key}:${issue.state}`, `status-${issue.state ?? "unknown"}`),
      ];
    }
    default: {
      const m = h.message;
      if (!m) return [noted(key, "message-not-found")];
      const messageKey = `message:${m.id}`;
      const userId = m.author?.user?.id ?? null;
      const contactId = m.author?.contact?.id ?? null;
      const sender = {
        externalUserId: userId
          ? `user:${userId}`
          : contactId
            ? `contact:${contactId}`
            : "pylon",
        displayName:
          m.author?.name ??
          m.author?.user?.email ??
          m.author?.contact?.email ??
          "Pylon",
        isBot: userId !== null && (h.botUserIds ?? []).includes(userId),
        isSelf: userId !== null && userId === self,
      };
      const text = pylonHtmlToText(m.message_html);
      const base = {
        messageKey,
        channel,
        conversationKey,
        sender,
        conversationDetails: details,
        ackDeadlineMs: ACK_DEADLINE_MS,
      };
      if (sender.isSelf || sender.isBot) {
        return [{ ...base, kind: "message", addressed: false, text }];
      }
      if (m.is_private) {
        const cut = cutMention(text, selfNames(inst));
        const decision = /^\s*(approve|deny)\s+#?\d+\s*$/i.test(cut.text);
        if (decision || (cut.mentioned && triggers.mention)) {
          return [
            { ...base, kind: "message", addressed: true, text: cut.text },
          ];
        }
        return [noted(messageKey, "note-not-addressed")];
      }
      if (contactId || !userId) {
        return [
          {
            ...base,
            kind: "message",
            addressed: false,
            untrusted: true,
            text,
          },
        ];
      }
      return [noted(messageKey, "teammate-reply")];
    }
  }
}

/**
 * The id a retry of a delivery repeats. Pylon sends no delivery id, and a
 * retry is signed again with a new timestamp, so the id is a hash of the body
 * (never `hydrated`, added later) and the epoch-aligned bucket of
 * `dedupeWindowSeconds` its timestamp falls in: Pylon's two retries come
 * about 4 and 12 seconds after the first attempt, so they share a bucket
 * unless one crosses its edge. One that does is recorded as a second event,
 * which changes nothing: a message is deduped in the inbox by its own id,
 * and a disengagement of an ended conversation is a no-op.
 * @param body - The parsed body.
 * @param headers - The request's headers.
 * @returns The id.
 */
export function pylonEventId(body: unknown, headers: Headers | null): string {
  const { hydrated: _h, ...rest } = (body ?? {}) as PylonWebhookBody;
  const sorted = JSON.stringify(
    Object.fromEntries(
      Object.entries(rest).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  const ts = Number(headers?.get("x-pylon-timestamp"));
  const at = Number.isFinite(ts) && ts > 0 ? ts : Math.floor(Date.now() / 1000);
  const window = Math.floor(at / config.platforms.pylon.dedupeWindowSeconds);
  return `sha256:${createHash("sha256").update(sorted).digest("hex").slice(0, 32)}:${window}`;
}
