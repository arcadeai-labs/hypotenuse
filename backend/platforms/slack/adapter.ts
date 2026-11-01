import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { api, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/frontend";
import type {} from "../../config/platforms";
import {
  buildSlackManifest,
  SLACK_BOT_SCOPES,
} from "../../ops/SlackManifestOps";
import { toMrkdwn, truncateForSlack } from "../../ops/SlackMarkdownOps";
import { SlackApiError, slackCall, slackTsOlderThan } from "../../ops/SlackOps";
import type { Channel } from "../../schema/channels";
import {
  type OutboxMessage,
  outboxMessages,
} from "../../schema/outbox_messages";
import { applyFallbacks, linkProblem } from "../surface";
import type {
  OpenInstallation,
  PlatformAdapter,
  RawInbound,
  SendResult,
  SurfaceContext,
} from "../types";
import { parseSlackDelivery, slackEventId } from "./events";
import { approvalBlocks, planMessage, questionBlocks } from "./render";

/**
 * **The Slack platform.** Every bot is its own Slack app, created from the
 * manifest Hypotenuse generates (`ops/SlackManifestOps.ts`) and installed into
 * a workspace by OAuth v2. A Slack channel — public, private, or a DM — is a
 * channel and its memory; a thread is a conversation.
 *
 * **Inbound** is `POST /api/webhooks/slack/<routingKey>`: the Events API
 * (JSON) and interactivity (a form whose `payload` is JSON), both signed
 * with Slack's v0 scheme — `X-Slack-Signature: v0=hex(HMAC-SHA256(signing
 * secret, "v0:" + X-Slack-Request-Timestamp + ":" + body))` — within five
 * minutes (https://api.slack.com/authentication/verifying-requests-from-slack).
 * During a signing-secret rotation the previous secret is tried too.
 * `url_verification` is answered with its `challenge`, even before install.
 * What each event means is `events.ts`.
 *
 * **Outbound**, by surface kind, through the Web API (`ops/SlackOps.ts`):
 *
 * | Kind | Slack | Notes |
 * |---|---|---|
 * | `status` | `assistant.threads.setStatus` | Slack clears it when the bot posts in the thread |
 * | `stream` | `chat.startStream` / `chat.appendStream`, `markdown_text` | each row is the step's whole text so far; the delta is appended. A row that does not extend the open stream (a retried model call) closes it and opens another, as does a stream past `streamMaxAgeMs` (Slack closes them at ten minutes) |
 * | `plan` | `chat.postMessage`, then `chat.update` of that message | one message per turn, one line per tool step |
 * | `message` | `chat.stopStream` of an open stream, then `chat.postMessage` | `mrkdwn` from markdown, sanitized; past 40,000 characters, truncated with a link to the transcript |
 * | `question` | `chat.postMessage` with buttons (a menu past five options) | `action_id` `q:<question>:<option>` |
 * | `approval` | `chat.postMessage` with Approve / Deny, or a dashboard link | `action_id` `a:<approval>:approve\|deny` |
 * | `link` | `chat.postMessage` of `<url\|label: text>` in the thread | a pull request a sandbox job opened; unfurls off, like every message |
 *
 * | Slack answers | Then |
 * |---|---|
 * | `ok: true` | `sent`, with the message's `ts` as the row's `externalMessageId` |
 * | `ratelimited` (HTTP 429, `Retry-After`), an empty bucket, a network error or 5xx | `retry`, after the wait Slack named |
 * | any other `ok: false` | `undeliverable`, with Slack's error |
 */

/** The installation's non-secret settings. */
const installationSchema = z.object({
  appId: z
    .string()
    .trim()
    .regex(/^A[A-Z0-9]+$/, "A Slack app id starts with A")
    .max(32)
    .optional()
    .describe("The Slack app's id (Basic Information → App ID)"),
  clientId: z
    .string()
    .trim()
    .regex(/^[0-9]+\.[0-9]+$/, "A Slack client id looks like 1234.5678")
    .max(64)
    .describe("The app's Client ID (Basic Information → App Credentials)"),
  teamId: z
    .string()
    .max(32)
    .optional()
    .describe("The workspace, set by the install"),
  teamName: z.string().max(200).optional().describe("The workspace's name"),
  scopes: z.array(z.string()).optional().describe("The scopes granted"),
});

/** The installation's secrets. */
const credentialSchema = z.object({
  clientSecret: z.string().min(8).max(256).describe("The app's Client Secret"),
  signingSecret: z
    .string()
    .min(8)
    .max(256)
    .describe("The app's Signing Secret"),
  signingSecretPrevious: z
    .string()
    .max(256)
    .optional()
    .describe("The signing secret before a rotation, still accepted"),
  botToken: z
    .string()
    .regex(/^xoxb-/, "A bot token starts with xoxb-")
    .max(512)
    .optional()
    .describe(
      "The Bot User OAuth Token (xoxb-…), when the app was installed in Slack rather than through Hypotenuse",
    ),
});

/**
 * Compute a v0 signature.
 * @param secret - The signing secret.
 * @param timestamp - `X-Slack-Request-Timestamp`.
 * @param bytes - The raw body.
 * @returns `v0=<hex>`.
 */
export function slackSignature(
  secret: string,
  timestamp: string,
  bytes: Uint8Array,
): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`v0:${timestamp}:`);
  hmac.update(bytes);
  return `v0=${hmac.digest("hex")}`;
}

/**
 * Compare two strings in constant time.
 * @param a - One.
 * @param b - The other.
 * @returns Whether they are equal.
 */
function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * The bot token of an installation, if it has one.
 * @param inst - The installation.
 * @returns The token, or `null`.
 */
function tokenOf(inst: OpenInstallation): string | null {
  const t = inst.credentials.botToken;
  return typeof t === "string" && t ? t : null;
}

/**
 * Neutralize broadcasts and the bot's own mention in `markdown_text`, which
 * Slack renders as markdown rather than `mrkdwn`.
 * @param text - The model's text.
 * @param self - The bot's user id.
 * @returns The text, safe to stream.
 */
function sanitizeMarkdown(text: string, self: string | null): string {
  let out = text.replace(/<!(channel|here|everyone)[^>]*>/gi, "@$1");
  if (self) out = out.split(`<@${self}>`).join("");
  return out;
}

/** The thread an outbox row goes to. */
interface SlackTarget {
  channel: string;
  threadTs: string | null;
}

/**
 * The newest row sent before this one in its conversation, among the kinds
 * that open or close a stream.
 * @param row - The row being sent.
 * @returns The row, or `undefined`.
 */
async function previousStreamOrFinal(
  row: OutboxMessage,
): Promise<OutboxMessage | undefined> {
  const [prev] = await api.db.db
    .select()
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.conversationId, row.conversationId),
        eq(outboxMessages.status, "sent"),
        inArray(outboxMessages.kind, [
          "stream",
          "message",
          "question",
          "approval",
        ]),
        lt(outboxMessages.id, row.id),
      ),
    )
    .orderBy(desc(outboxMessages.id))
    .limit(1);
  return prev;
}

/**
 * The stream open in a conversation: the newest sent stream row with a `ts`,
 * when nothing final was sent after it. Its payload is the stream's whole text.
 * @param row - The row being sent.
 * @returns The stream's `ts` and text, or `null`.
 */
async function openStream(
  row: OutboxMessage,
): Promise<{ ts: string; text: string } | null> {
  const prev = await previousStreamOrFinal(row);
  if (!prev || prev.kind !== "stream" || !prev.externalMessageId) return null;
  return {
    ts: prev.externalMessageId,
    text: String((prev.payload as { text?: string }).text ?? ""),
  };
}

/**
 * Close an open stream before something else is posted. A stream Slack has
 * already closed is closed.
 * @param target - The thread.
 * @param token - The bot token.
 * @param installationId - Whose bucket.
 * @param row - The row being sent.
 */
async function closeStream(
  target: SlackTarget,
  token: string,
  installationId: number,
  row: OutboxMessage,
): Promise<void> {
  const open = await openStream(row);
  if (!open) return;
  try {
    await slackCall(
      "chat.stopStream",
      { channel: target.channel, ts: open.ts },
      { token, installationId },
    );
  } catch (e) {
    if (e instanceof SlackApiError && e.retryable) throw e;
    // Already closed (Slack's own ten-minute limit): nothing to do.
  }
}

/**
 * Send a `stream` row: append its new text to the open stream, or open one.
 * @param row - The row.
 * @param target - The thread.
 * @param token - The bot token.
 * @param inst - The installation.
 * @returns The stream's `ts`, recorded on the row, or `null` once closed.
 */
async function sendStream(
  row: OutboxMessage,
  target: SlackTarget,
  token: string,
  inst: OpenInstallation,
): Promise<string | null> {
  const id = inst.installation.id;
  const self = inst.installation.externalBotUserId;
  const text = sanitizeMarkdown(
    String((row.payload as { text?: string }).text ?? ""),
    self,
  );
  const found = await openStream(row);
  // Both sides sanitized: the open stream holds what was sent, not the raw row.
  const open = found
    ? { ts: found.ts, text: sanitizeMarkdown(found.text, self) }
    : null;
  const stale =
    open !== null &&
    (!text.startsWith(open.text) ||
      slackTsOlderThan(open.ts, config.platforms.slack.streamMaxAgeMs));
  if (open && (stale || !text)) {
    try {
      await slackCall(
        "chat.stopStream",
        { channel: target.channel, ts: open.ts },
        { token, installationId: id },
      );
    } catch (e) {
      if (e instanceof SlackApiError && e.retryable) throw e;
    }
  }
  if (!text) return null;
  if (open && !stale) {
    const delta = text.slice(open.text.length);
    if (delta) {
      await slackCall(
        "chat.appendStream",
        { channel: target.channel, ts: open.ts, markdown_text: delta },
        { token, installationId: id },
      );
    }
    return open.ts;
  }
  const started = await slackCall<{ ts: string }>(
    "chat.startStream",
    {
      channel: target.channel,
      ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      markdown_text: text,
    },
    { token, installationId: id },
  );
  return started.ts;
}

/**
 * Send a `plan` row: post the turn's plan message, or edit it in place.
 * @param row - The row.
 * @param target - The thread.
 * @param token - The bot token.
 * @param installationId - Whose bucket.
 * @returns The plan message's `ts`.
 */
async function sendPlan(
  row: OutboxMessage,
  target: SlackTarget,
  token: string,
  installationId: number,
): Promise<string> {
  const steps = ((row.payload as { steps?: unknown[] }).steps ?? []) as {
    tool: string;
    state: string;
  }[];
  const { text, blocks } = planMessage(steps);
  const [prev] = await api.db.db
    .select({ ts: outboxMessages.externalMessageId })
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.conversationId, row.conversationId),
        eq(outboxMessages.kind, "plan"),
        eq(outboxMessages.status, "sent"),
        eq(outboxMessages.supersedesKey, row.supersedesKey ?? ""),
        lt(outboxMessages.id, row.id),
      ),
    )
    .orderBy(desc(outboxMessages.id))
    .limit(1);
  if (prev?.ts) {
    await slackCall(
      "chat.update",
      { channel: target.channel, ts: prev.ts, text, blocks },
      { token, installationId },
    );
    return prev.ts;
  }
  const posted = await slackCall<{ ts: string }>(
    "chat.postMessage",
    {
      channel: target.channel,
      ...(target.threadTs ? { thread_ts: target.threadTs } : {}),
      text,
      blocks,
    },
    { token, installationId },
  );
  return posted.ts;
}

/**
 * The transcript page of a conversation, for a truncated message's link.
 * @param conversationId - The conversation.
 * @returns An absolute URL.
 */
function transcriptLink(conversationId: number): string {
  return `${config.frontend.url.replace(/\/+$/, "")}/conversations/${conversationId}`;
}

/**
 * Escape text for Slack's `mrkdwn` control characters.
 * @param text - The text.
 * @returns It, with `&`, `<`, and `>` escaped.
 */
function escapeMrkdwn(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * A `link` row as one Slack message: `<url|label: text>`.
 * @param p - The row's payload (`label`, `url`, `text?`).
 * @returns The `mrkdwn` text.
 */
function slackLink(p: Record<string, unknown>): string {
  const label = String(p.label ?? "Link");
  const title = typeof p.text === "string" && p.text.trim() ? p.text : "";
  const shown = escapeMrkdwn(title ? `${label}: ${title}` : label).replace(
    /\|/g,
    "¦",
  );
  const url = String(p.url ?? "").replace(/[<>|\s]/g, "");
  return `<${url}|${shown}>`;
}

/**
 * Post a final row — a message, a question, an approval, or a link — in the thread.
 * @param row - The row.
 * @param target - The thread.
 * @param token - The bot token.
 * @param inst - The installation.
 * @returns The posted message's `ts`.
 */
async function sendFinal(
  row: OutboxMessage,
  target: SlackTarget,
  token: string,
  inst: OpenInstallation,
): Promise<string> {
  const id = inst.installation.id;
  const self = inst.installation.externalBotUserId;
  await closeStream(target, token, id, row);
  const p = row.payload as Record<string, unknown>;
  const thread = target.threadTs ? { thread_ts: target.threadTs } : {};
  let body: Record<string, unknown>;
  if (row.kind === "question") {
    const text = toMrkdwn(String(p.text ?? ""), self);
    body = {
      text,
      blocks: questionBlocks(
        text,
        (p.options as string[] | undefined) ?? [],
        Number(p.questionEntryId ?? 0),
      ),
    };
  } else if (row.kind === "approval") {
    body = {
      text: `I need approval to run ${String(p.name)}.`,
      blocks: approvalBlocks({
        approvalId: Number(p.approvalId),
        name: String(p.name),
        args: p.args,
        actions: (p.actions as string[] | undefined) ?? [],
      }),
    };
  } else if (row.kind === "link") {
    body = { text: slackLink(p) };
  } else {
    const prefix = p.messageKind === "error" ? ":warning: " : "";
    body = {
      text: truncateForSlack(
        prefix + toMrkdwn(String(p.text ?? ""), self),
        transcriptLink(row.conversationId),
      ),
    };
  }
  const posted = await slackCall<{ ts: string }>(
    "chat.postMessage",
    {
      channel: target.channel,
      ...thread,
      ...body,
      unfurl_links: false,
      unfurl_media: false,
    },
    { token, installationId: id },
  );
  return posted.ts;
}

export const slackAdapter: PlatformAdapter = {
  type: "slack",
  label: "Slack",
  installationSchema,
  credentialSchema,
  capabilities: {
    threads: true,
    streaming: true,
    status: true,
    plan: true,
    buttons: true,
    ephemeral: false,
    edits: true,
    elicitation: false,
    typing: false,
  },
  settlesAtEnqueue: false,
  handshakeWhilePending: true,

  manifest(bot, urls) {
    return {
      instructions: `Create ${bot.displayName}'s Slack app from this manifest (api.slack.com/apps → Create New App → From a manifest), or let Hypotenuse create it with an app configuration token. Then connect the app's Client ID, Client Secret, and Signing Secret, and install it into the workspace. Invite it to a channel with /invite.`,
      manifest: buildSlackManifest(bot, urls),
    };
  },

  readyToActivate: (credentials) =>
    typeof credentials.botToken === "string" && credentials.botToken !== "",

  verifyInbound(req: RawInbound, inst) {
    const timestamp = req.headers.get("x-slack-request-timestamp") ?? "";
    const signature = req.headers.get("x-slack-signature") ?? "";
    const t = Number(timestamp);
    if (!timestamp || !signature || !Number.isInteger(t)) {
      return { ok: false, reason: "unsigned" };
    }
    if (
      Math.abs(Date.now() / 1000 - t) >
      config.platforms.signatureToleranceSeconds
    ) {
      return { ok: false, reason: "stale" };
    }
    const secrets = [
      inst.credentials.signingSecret,
      inst.credentials.signingSecretPrevious,
    ].filter((s): s is string => typeof s === "string" && s !== "");
    for (const secret of secrets) {
      if (safeEqual(slackSignature(secret, timestamp, req.bytes), signature)) {
        return { ok: true };
      }
    }
    return { ok: false, reason: "bad signature" };
  },

  decodeBody(req) {
    const type = req.headers.get("content-type") ?? "";
    if (type.startsWith("application/x-www-form-urlencoded")) {
      const payload = new URLSearchParams(req.text).get("payload");
      if (!payload) throw new Error("An interactivity form has no payload.");
      return JSON.parse(payload);
    }
    return JSON.parse(req.text);
  },

  handshake(body) {
    const b = body as { type?: string; challenge?: unknown };
    if (b?.type !== "url_verification" || typeof b.challenge !== "string") {
      return null;
    }
    return Response.json({ challenge: b.challenge });
  },

  eventId: (body) => slackEventId(body),

  parseInbound: (body, inst) => parseSlackDelivery(body, inst),

  resolveChannel: (inbound) => inbound.channel,

  async probe(inst) {
    const token = tokenOf(inst);
    if (!token) {
      throw new Error(
        "It is not installed in a workspace yet: install it (bot-installation:oauth-start), or connect its bot token.",
      );
    }
    try {
      const who = await slackCall<{ user_id: string; team_id: string }>(
        "auth.test",
        {},
        { token },
      );
      return { externalBotUserId: who.user_id };
    } catch (e) {
      if (e instanceof SlackApiError) {
        throw new Error(`Slack refused the bot token: ${e.code}.`);
      }
      throw e;
    }
  },

  oauth: {
    authorizeUrl(inst, redirectUri, state) {
      const url = new URL(config.platforms.slack.authorizeUrl);
      url.searchParams.set(
        "client_id",
        String(inst.installation.config.clientId ?? ""),
      );
      url.searchParams.set("scope", SLACK_BOT_SCOPES.join(","));
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchange(inst, code, redirectUri) {
      const granted = await slackCall<{
        access_token: string;
        token_type: string;
        scope?: string;
        bot_user_id: string;
        app_id?: string;
        team?: { id: string; name?: string };
      }>(
        "oauth.v2.access",
        {
          client_id: String(inst.installation.config.clientId ?? ""),
          client_secret: String(inst.credentials.clientSecret ?? ""),
          code,
          redirect_uri: redirectUri,
        },
        { form: true },
      );
      if (granted.token_type !== "bot" || !granted.team?.id) {
        throw new Error("Slack's answer carried no bot token for a workspace.");
      }
      // Confirm the token works before anything is stored.
      const who = await slackCall<{ user_id: string }>(
        "auth.test",
        {},
        { token: granted.access_token },
      );
      return {
        credentials: { botToken: granted.access_token },
        config: {
          teamId: granted.team.id,
          ...(granted.team.name ? { teamName: granted.team.name } : {}),
          scopes: (granted.scope ?? "").split(",").filter(Boolean),
        },
        externalWorkspaceId: granted.team.id,
        externalBotUserId: who.user_id || granted.bot_user_id,
        externalAppId: granted.app_id ?? null,
      };
    },
  },

  target(channel: Channel, conversationKey: string | null) {
    return {
      type: "platform",
      platform: "slack",
      channelExternalId: channel.externalId.split("/").slice(1).join("/"),
      conversationKey,
    };
  },

  validateOutbound(draft) {
    if (draft.kind === "message" || draft.kind === "question") {
      if (typeof draft.payload.text !== "string" || !draft.payload.text) {
        return { refused: true, reason: `A ${draft.kind} needs text.` };
      }
    }
    if (draft.kind === "question" && !draft.payload.questionEntryId) {
      const options = draft.payload.options as string[] | undefined;
      if (options && options.length > 0) {
        return {
          refused: true,
          reason: "A question with options needs its questionEntryId.",
        };
      }
    }
    if (draft.kind === "approval" && !draft.payload.approvalId) {
      return { refused: true, reason: "An approval needs its approvalId." };
    }
    const problem = linkProblem(draft);
    if (problem) return { refused: true, reason: problem };
    return applyFallbacks(draft, this.capabilities);
  },

  async send(row, ctx: SurfaceContext): Promise<SendResult> {
    const { installation } = ctx;
    if (!installation || installation.status !== "active") {
      return {
        outcome: "undeliverable",
        error: "The installation is not active.",
      };
    }
    const { openInstallation } = await import("../../ops/InstallationOps");
    const inst = openInstallation(installation);
    const token = tokenOf(inst);
    if (!token) {
      return {
        outcome: "undeliverable",
        error: "The installation has no bot token.",
      };
    }
    const t = row.target as {
      channelExternalId?: string;
      conversationKey?: string | null;
    };
    const target: SlackTarget = {
      channel: String(t.channelExternalId ?? ""),
      threadTs: t.conversationKey ?? ctx.conversation.externalConversationKey,
    };
    try {
      let externalMessageId: string | null = null;
      switch (row.kind) {
        case "status":
          if (!target.threadTs) return { outcome: "sent" };
          await slackCall(
            "assistant.threads.setStatus",
            {
              channel_id: target.channel,
              thread_ts: target.threadTs,
              status: String(
                (row.payload as { text?: string }).text ?? "",
              ).slice(0, 200),
            },
            { token, installationId: installation.id },
          );
          break;
        case "stream":
          externalMessageId = await sendStream(row, target, token, inst);
          break;
        case "plan":
          externalMessageId = await sendPlan(
            row,
            target,
            token,
            installation.id,
          );
          break;
        default:
          externalMessageId = await sendFinal(row, target, token, inst);
      }
      return { outcome: "sent", externalMessageId };
    } catch (e) {
      if (e instanceof SlackApiError) {
        if (e.retryable) {
          return {
            outcome: "retry",
            error: e.message,
            ...(e.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : {}),
          };
        }
        return { outcome: "undeliverable", error: e.message };
      }
      return {
        outcome: "retry",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
};
