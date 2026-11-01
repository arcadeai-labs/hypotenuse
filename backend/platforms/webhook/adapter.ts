import { config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/agents";
import type {} from "../../config/platforms";
import { guardedFetch, HostRefused } from "../../ops/NetworkGuardOps";
import { signCallback, verifySignatureBytes } from "../../ops/SignatureOps";
import type { Channel } from "../../schema/channels";
import { applyFallbacks, linkProblem } from "../surface";
import type {
  NormalizedInbound,
  OpenInstallation,
  PlatformAdapter,
  RawInbound,
} from "../types";

/**
 * **The generic `webhook` platform**: signed JSON in and out, so any system
 * can be a channel. It is the smallest real adapter and the reference every
 * other adapter's conformance suite is held to.
 *
 * **Inbound** is `POST /api/webhooks/webhook/<routingKey>`, signed with
 * `Hypotenuse-Signature: t=…,v1=hmac(signingSecret, t + "." + body)`:
 *
 * | `type` | Fields | Becomes |
 * |---|---|---|
 * | `message` (default) | `channel`, `conversation`, `messageId`, `sender {id, name, isBot?}`, `text`, `mentions?`, `edited?`, `deleted?` | a message, addressed when `mentions` or the channel is a DM |
 * | `interaction` | the above, plus `interaction {kind: answer\|approval, targetId, value}` | an answer to a question, or an approval decision (`approve` / `deny`) |
 * | `signal` | `signal: stop\|disengage` | cancel the conversation / end it |
 * | `lifecycle` | `lifecycle: uninstall\|channel_archived` | mark the installation or the channel |
 *
 * `channel` is a string id or `{id, name?, private?, shared?, dm?}`.
 * `eventId` (default `messageId`) is the delivery id a retry repeats.
 *
 * **Outbound** is a `POST` of every surface kind as JSON to the
 * installation's `deliveryUrl`, signed the same way, with
 * `Hypotenuse-Delivery: <outbox row id>` as the idempotency key:
 * `{deliveryId, kind, channel, conversation, ...payload}` — a `message` carries
 * `messageKind` (`reply`, `complete`, `fail`, `error`); a `link` carries
 * `label`, `url`, and `text` (a pull request a sandbox job opened). An answer of
 * `{"messageId": "…"}` is recorded as the row's `externalMessageId`.
 *
 * | Answer | Then |
 * |---|---|
 * | 2xx | `sent` |
 * | 408, 429 (honouring `Retry-After`), 5xx, a network error | retried with back-off |
 * | any other 4xx, a refused host | `undeliverable` |
 */

/** The installation's non-secret settings. */
const installationSchema = z.object({
  deliveryUrl: z
    .string()
    .trim()
    .url("The delivery URL must be an absolute URL")
    .max(2048)
    .describe("Where the bot's messages are POSTed, signed"),
});

/** The installation's secrets. */
const credentialSchema = z.object({
  signingSecret: z
    .string()
    .min(16, "A signing secret is at least 16 characters")
    .max(256)
    .describe(
      "The shared secret both sides sign with (Hypotenuse-Signature, HMAC-SHA256)",
    ),
});

/** A channel as the sender names it. */
const channelInput = z.union([
  z.string().min(1).max(200),
  z.object({
    id: z.string().min(1).max(200),
    name: z.string().max(200).optional(),
    private: z.boolean().optional(),
    shared: z.boolean().optional(),
    dm: z.boolean().optional(),
  }),
]);

/** One inbound delivery. */
export const webhookInboundSchema = z.object({
  type: z
    .enum(["message", "interaction", "signal", "lifecycle"])
    .default("message"),
  eventId: z.string().min(1).max(200).optional(),
  messageId: z.string().min(1).max(200),
  channel: channelInput,
  conversation: z.string().min(1).max(200),
  sender: z.object({
    id: z.string().min(1).max(200),
    name: z.string().max(200).default(""),
    isBot: z.boolean().optional(),
  }),
  text: z.string().max(40_000).optional(),
  mentions: z.boolean().optional(),
  edited: z.boolean().optional(),
  deleted: z.boolean().optional(),
  interaction: z
    .object({
      kind: z.enum(["answer", "approval"]),
      targetId: z.string().min(1).max(200),
      value: z.string().min(1).max(2000),
    })
    .optional(),
  signal: z.enum(["stop", "disengage"]).optional(),
  lifecycle: z.enum(["uninstall", "channel_archived"]).optional(),
});

/** One inbound delivery, parsed. */
export type WebhookInbound = z.infer<typeof webhookInboundSchema>;

/**
 * The signing secret of an open installation.
 * @param inst - The installation.
 * @returns The secret.
 */
function secretOf(inst: OpenInstallation): string {
  return String(inst.credentials.signingSecret ?? "");
}

export const webhookAdapter: PlatformAdapter = {
  type: "webhook",
  label: "Webhook",
  installationSchema,
  credentialSchema,
  capabilities: {
    threads: true,
    streaming: true,
    status: true,
    plan: true,
    buttons: true,
    ephemeral: false,
    edits: false,
    elicitation: false,
    typing: false,
  },
  settlesAtEnqueue: false,

  manifest(bot, urls) {
    return {
      instructions: `Point your system at the events URL and sign every request with the secret you give Hypotenuse (Hypotenuse-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">). ${bot.displayName}'s messages are POSTed, signed the same way, to the delivery URL you connect.`,
      manifest: {
        name: bot.displayName,
        botUserId: `bot:${bot.slug}`,
        eventsUrl: urls.events,
        signature:
          "Hypotenuse-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, t + '.' + body)>",
        inbound: {
          type: "message | interaction | signal | lifecycle",
          messageId: "string",
          channel: "string | {id, name?, private?, shared?, dm?}",
          conversation: "string",
          sender: "{id, name, isBot?}",
          text: "string",
          mentions: "boolean",
        },
      },
    };
  },

  verifyInbound(req: RawInbound, inst) {
    const header = req.headers.get("hypotenuse-signature");
    const secret = secretOf(inst);
    if (!header || !secret) return { ok: false, reason: "unsigned" };
    return verifySignatureBytes(
      secret,
      header,
      req.bytes,
      config.platforms.signatureToleranceSeconds,
    )
      ? { ok: true }
      : { ok: false, reason: "bad signature" };
  },

  eventId(body) {
    const parsed = webhookInboundSchema.safeParse(body);
    if (!parsed.success) return `invalid:${Bun.hash(JSON.stringify(body))}`;
    return parsed.data.eventId ?? parsed.data.messageId;
  },

  parseInbound(body, inst) {
    const d = webhookInboundSchema.parse(body);
    const ch = typeof d.channel === "string" ? { id: d.channel } : d.channel;
    const isDm = Boolean("dm" in ch && ch.dm);
    const inbound: NormalizedInbound = {
      kind: d.type,
      messageKey: `${ch.id}:${d.messageId}`,
      channel: {
        externalId: ch.id,
        name: ("name" in ch && ch.name) || ch.id,
        isPrivate: Boolean("private" in ch && ch.private) || isDm,
        isShared: Boolean("shared" in ch && ch.shared),
        isDm,
      },
      conversationKey: d.conversation,
      sender: {
        externalUserId: d.sender.id,
        displayName: d.sender.name || d.sender.id,
        isBot: Boolean(d.sender.isBot),
        isSelf:
          inst.installation.externalBotUserId !== null &&
          d.sender.id === inst.installation.externalBotUserId,
      },
      addressed: Boolean(d.mentions) || isDm,
      edit: Boolean(d.edited || d.deleted),
      text: d.text,
      ...(d.interaction ? { interaction: d.interaction } : {}),
      ...(d.signal ? { signal: d.signal } : {}),
      ...(d.lifecycle ? { lifecycle: d.lifecycle } : {}),
      ackDeadlineMs: 5_000,
    };
    return [inbound];
  },

  resolveChannel: (inbound) => inbound.channel,

  async probe(inst) {
    const deliveryUrl = String(inst.installation.config.deliveryUrl ?? "");
    const body = JSON.stringify({ kind: "ping" });
    const res = await guardedFetch(deliveryUrl, {
      method: "POST",
      headers: signedHeaders(secretOf(inst), body, "ping"),
      body,
      signal: AbortSignal.timeout(config.agents.callbackTimeoutMs),
    });
    const text = await res.text().catch(() => "");
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`The delivery URL answered HTTP ${res.status}.`);
    }
    let botUserId: string | undefined;
    try {
      botUserId = (JSON.parse(text) as { botUserId?: string }).botUserId;
    } catch {
      // A 2xx with no JSON is fine: the identity stays what it was.
    }
    return {
      externalBotUserId:
        botUserId ??
        inst.installation.externalBotUserId ??
        `bot:${inst.installation.botId}`,
    };
  },

  target(channel: Channel, conversationKey: string | null) {
    return {
      type: "platform",
      platform: "webhook",
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
    if (draft.kind === "approval" && !draft.payload.approvalId) {
      return { refused: true, reason: "An approval needs its approvalId." };
    }
    const problem = linkProblem(draft);
    if (problem) return { refused: true, reason: problem };
    return applyFallbacks(draft, this.capabilities);
  },

  async send(row, { installation, conversation }) {
    if (!installation || installation.status !== "active") {
      return {
        outcome: "undeliverable",
        error: "The installation is not active.",
      };
    }
    const { openInstallation } = await import("../../ops/InstallationOps");
    const inst = openInstallation(installation);
    const target = row.target as {
      channelExternalId?: string;
      conversationKey?: string | null;
    };
    const body = JSON.stringify({
      deliveryId: row.id,
      kind: row.kind,
      channel: target.channelExternalId,
      conversation:
        target.conversationKey ?? conversation.externalConversationKey,
      ...row.payload,
    });
    try {
      const res = await guardedFetch(String(installation.config.deliveryUrl), {
        method: "POST",
        headers: signedHeaders(secretOf(inst), body, String(row.id)),
        body,
        signal: AbortSignal.timeout(config.agents.callbackTimeoutMs),
      });
      const text = await res.text().catch(() => "");
      if (res.status >= 200 && res.status < 300) {
        let externalMessageId: string | null = null;
        try {
          const id = (JSON.parse(text) as { messageId?: unknown }).messageId;
          if (typeof id === "string") externalMessageId = id;
        } catch {
          // No JSON answer: nothing to record.
        }
        return { outcome: "sent", externalMessageId };
      }
      const retryAfter = Number(res.headers.get("retry-after"));
      const retryable =
        res.status === 408 || res.status === 429 || res.status >= 500;
      return {
        outcome: retryable ? "retry" : "undeliverable",
        error: `The receiver answered HTTP ${res.status}.`,
        ...(Number.isFinite(retryAfter) && retryAfter > 0
          ? { retryAfterMs: retryAfter * 1000 }
          : {}),
      };
    } catch (e) {
      if (e instanceof HostRefused) {
        return { outcome: "undeliverable", error: e.message };
      }
      return {
        outcome: "retry",
        error: e instanceof Error ? e.message : String(e),
      };
    }
  },
};

/**
 * The headers of a signed outbound request.
 * @param secret - The signing secret.
 * @param body - The exact body.
 * @param delivery - The idempotency key.
 * @returns The headers.
 */
function signedHeaders(
  secret: string,
  body: string,
  delivery: string,
): Record<string, string> {
  return {
    "content-type": "application/json",
    "user-agent": "Hypotenuse-Webhook/1",
    "hypotenuse-signature": signCallback(
      secret,
      body,
      Math.floor(Date.now() / 1000),
    ),
    "hypotenuse-delivery": delivery,
  };
}
