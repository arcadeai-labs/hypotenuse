import { createHmac, timingSafeEqual } from "node:crypto";
import {
  and,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  lt,
  ne,
  sql,
} from "drizzle-orm";
import { api, config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/platforms";
import { markdownToPylonHtml } from "../../ops/PylonMarkdownOps";
import {
  type PylonAccount,
  PylonApiError,
  type PylonIssue,
  type PylonMessage,
  type PylonRegion,
  pylonFetch,
  pylonMessages,
  pylonRequest,
} from "../../ops/PylonOps";
import { botInstallations } from "../../schema/bot_installations";
import { bots } from "../../schema/bots";
import type { Channel } from "../../schema/channels";
import { conversations } from "../../schema/conversations";
import {
  type OutboxMessage,
  outboxMessages,
} from "../../schema/outbox_messages";
import { applyFallbacks, approvalLink } from "../surface";
import type {
  OpenInstallation,
  PlatformAdapter,
  RawInbound,
  SendResult,
  SurfaceContext,
} from "../types";
import {
  PYLON_TRIGGERS,
  type PylonHydrated,
  type PylonWebhookBody,
  parsePylonDelivery,
  pylonEventId,
} from "./events";

/**
 * **The Pylon platform.** A bot works a support team's Pylon queue as its
 * own teammate: a Pylon admin creates an **API token with its own identity**
 * for it (its own name, icon, and role — Settings → Integrations & dev → API
 * tokens), and a **webhook** fed by four **Triggers** (`events.ts`). An issue
 * is a conversation; its account — the customer company — is the channel and
 * its memory.
 *
 * **Nothing reaches a customer by default.** Everything the bot writes is an
 * internal note, in one Pylon-only thread per conversation; a customer-facing
 * reply is only ever the `pylon_reply_to_customer` tool, under the bot's
 * `customerReplyPolicy` (`never` by default; see that tool).
 *
 * **Inbound** is `POST /api/webhooks/pylon/<routingKey>`, signed as
 * `X-Pylon-Signature-V2: hex(HMAC-SHA256(secret, "<X-Pylon-Timestamp>.<raw body>"))`
 * with the timestamp (Unix seconds) within `timestampToleranceSeconds` (300)
 * of now; a `hs256=` prefix is tolerated. The legacy `X-Pylon-Signature` (an
 * HMAC of the body alone, which never expires) is accepted only when the
 * installation is set to `legacySignature`.
 *
 * **Outbound**, by surface kind:
 *
 * | Kind | Pylon | Notes |
 * |---|---|---|
 * | `status` (priority `ack`) | a note, "Looking into this.", which opens the conversation's thread (`thread_name`) | only the first: later acknowledgements post nothing |
 * | `status` (an escalation) | a note | |
 * | `status` (anything else), `stream` | — | Pylon has no ephemeral or edit-in-place element: dropped at enqueue |
 * | `plan` | — (recorded, nothing posted) | the turn's steps are written as a checklist in the turn's final note, one note a turn |
 * | `message` | a note: the text, then the turn's steps | under every policy: a customer reply is a tool, never a message |
 * | `question` | a note asking the team; a teammate's note mentioning the bot answers it | |
 * | `approval` of `pylon/reply_to_customer` | a draft reply (`POST /issues/{id}/draft-reply`, in the bot's drafts) and a note quoting it, asking for `approve <id>` | approving sends exactly the approved text |
 * | `approval` of anything else | a note asking for `approve <id>` | |
 *
 * Every note after the first goes to the same thread (`message_id` of the
 * first note, kept on the conversation as `noteMessageId`).
 *
 * | Pylon answers | Then |
 * |---|---|
 * | 2xx | `sent`, with the note's id |
 * | `429` (`Retry-After`), an empty bucket, a network error, 5xx | `retry`, after the wait |
 * | anything else | `undeliverable`, with Pylon's message |
 */

/** A bot's triggers, each a per-bot setting. */
const triggersSchema = z.object({
  autoTriage: z
    .boolean()
    .default(true)
    .describe("Start working every new issue in a listened team and tag"),
  mention: z
    .boolean()
    .default(true)
    .describe("Answer an internal note that mentions the bot by name"),
  assignment: z
    .boolean()
    .default(true)
    .describe("Start working an issue assigned to the bot"),
});

/** The customer reply policies, safest first. */
export const CUSTOMER_REPLY_POLICIES = [
  "never",
  "approve",
  "auto-on-low-risk",
] as const;

/** One of {@link CUSTOMER_REPLY_POLICIES}. */
export type CustomerReplyPolicy = (typeof CUSTOMER_REPLY_POLICIES)[number];

/** The installation's non-secret settings. */
export const pylonInstallationSchema = z.object({
  region: z
    .enum(["us", "eu"])
    .default("us")
    .describe("The Pylon region the organization lives in"),
  selfName: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe(
      "The token identity's name in Pylon, which teammates mention the bot by",
    ),
  organizationId: z.string().max(200).optional().describe("Set by the probe"),
  organizationName: z.string().max(200).optional().describe("Set by the probe"),
  triggers: triggersSchema.default({
    autoTriage: true,
    mention: true,
    assignment: true,
  }),
  listen: z
    .object({
      teamIds: z.array(z.string().max(200)).max(50).default([]),
      tags: z.array(z.string().max(200)).max(50).default([]),
    })
    .default({ teamIds: [], tags: [] })
    .describe(
      "The Pylon teams and tags new issues must be in (any when empty)",
    ),
  customerReplyPolicy: z
    .enum(CUSTOMER_REPLY_POLICIES)
    .default("never")
    .describe(
      "Whether the bot may reply to customers; set by pylon:settings-edit",
    ),
  customerReplyPolicySetByUserId: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe("Who set the policy"),
  legacySignature: z
    .boolean()
    .default(false)
    .describe(
      "Also accept the legacy X-Pylon-Signature (an HMAC of the body alone, with no timestamp)",
    ),
});

/** The installation's secrets. */
const credentialSchema = z.object({
  apiToken: z
    .string()
    .min(8)
    .max(4096)
    .describe("The Pylon API token, created with its own identity"),
  webhookSecret: z
    .string()
    .min(8)
    .max(512)
    .describe("The Pylon webhook's secret, shown once when it was created"),
});

/**
 * Compute Pylon's V2 webhook signature.
 * @param secret - The webhook secret, used as-is.
 * @param timestamp - `X-Pylon-Timestamp`.
 * @param text - The raw body.
 * @returns The hex HMAC-SHA256.
 */
export function pylonSignature(
  secret: string,
  timestamp: string,
  text: string,
): string {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${text}`)
    .digest("hex");
}

/**
 * Compute Pylon's legacy webhook signature (the body alone).
 * @param secret - The webhook secret.
 * @param text - The raw body.
 * @returns The hex HMAC-SHA256.
 */
export function pylonLegacySignature(secret: string, text: string): string {
  return createHmac("sha256", secret).update(text).digest("hex");
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
 * The conversation's issue.
 * @param ctx - The surface context.
 * @returns The issue id, or `null`.
 */
function issueOf(ctx: SurfaceContext): string | null {
  const fromDetails = ctx.conversation.details?.issueId;
  if (typeof fromDetails === "string" && fromDetails) return fromDetails;
  const key = ctx.conversation.externalConversationKey ?? "";
  return key.startsWith("issue:") ? key.slice("issue:".length) : null;
}

/**
 * Remember something about the conversation's Pylon thread.
 * @param conversationId - The conversation.
 * @param patch - The details to merge.
 */
async function remember(
  conversationId: number,
  patch: Record<string, unknown>,
): Promise<void> {
  await api.db.db
    .update(conversations)
    .set({
      details: sql`coalesce(${conversations.details}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`,
    })
    .where(eq(conversations.id, conversationId));
}

/**
 * The bot's name, for its thread.
 * @param botId - The bot.
 * @returns Its display name.
 */
async function botName(botId: number): Promise<string> {
  const [row] = await api.db.db
    .select({ name: bots.displayName })
    .from(bots)
    .where(eq(bots.id, botId))
    .limit(1);
  return row?.name ?? "bot";
}

/**
 * Post an internal note in the conversation's thread, opening it with the
 * first note.
 * @param inst - The installation.
 * @param ctx - The surface context.
 * @param issueId - The issue.
 * @param markdown - The note.
 * @param reserved - An acknowledgement, which may draw on the bucket's reserve.
 * @returns The note's id.
 */
async function note(
  inst: OpenInstallation,
  ctx: SurfaceContext,
  issueId: string,
  markdown: string,
  reserved = false,
): Promise<string> {
  const [fresh] = await api.db.db
    .select({ details: conversations.details })
    .from(conversations)
    .where(eq(conversations.id, ctx.conversation.id))
    .limit(1);
  const thread = fresh?.details?.noteMessageId;
  const body: Record<string, unknown> = {
    body_html: markdownToPylonHtml(markdown),
  };
  if (typeof thread === "string" && thread) {
    body.message_id = thread;
  } else {
    body.thread_name = `Hypotenuse — ${await botName(ctx.conversation.botId)}`;
  }
  const posted = await pylonRequest<{ id: string }>(
    inst,
    "POST",
    `/issues/${encodeURIComponent(issueId)}/note`,
    body,
    { write: true, reserved },
  );
  if (!(typeof thread === "string" && thread) && posted.id) {
    await remember(ctx.conversation.id, { noteMessageId: posted.id });
  }
  return posted.id;
}

/** One step of a plan row. */
interface PlanStep {
  seq: number;
  tool: string;
  state: "running" | "done" | "error";
}

/**
 * The steps of the turn a final row ends: the newest plan row written after
 * the previous final row (whatever became of it: a final row supersedes the
 * plan rows before it).
 * @param row - The final row.
 * @returns The steps.
 */
async function turnSteps(row: OutboxMessage): Promise<PlanStep[]> {
  const [previousFinal] = await api.db.db
    .select({ id: outboxMessages.id })
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.conversationId, row.conversationId),
        inArray(outboxMessages.kind, ["message", "question", "approval"]),
        lt(outboxMessages.id, row.id),
      ),
    )
    .orderBy(desc(outboxMessages.id))
    .limit(1);
  const [plan] = await api.db.db
    .select({ payload: outboxMessages.payload })
    .from(outboxMessages)
    .where(
      and(
        eq(outboxMessages.conversationId, row.conversationId),
        eq(outboxMessages.kind, "plan"),
        lt(outboxMessages.id, row.id),
        gt(outboxMessages.id, previousFinal?.id ?? 0),
      ),
    )
    .orderBy(desc(outboxMessages.id))
    .limit(1);
  return ((plan?.payload as { steps?: PlanStep[] } | undefined)?.steps ??
    []) as PlanStep[];
}

/**
 * A turn's finished steps as a checklist.
 * @param all - The turn's steps.
 * @returns Markdown, or `""` for none.
 */
function checklist(all: PlanStep[]): string {
  // A step still running when the turn's final row is written is the
  // terminal tool writing it.
  const steps = all.filter((s) => s.state !== "running");
  if (steps.length === 0) return "";
  return `\n\n**Steps**\n${steps.map((s) => `- ${s.state === "done" ? "✓" : "✗"} \`${s.tool}\``).join("\n")}`;
}

/**
 * How a teammate decides an approval, in a note.
 * @param p - The approval row's payload.
 * @returns Markdown.
 */
function decideHow(p: Record<string, unknown>): string {
  const id = Number(p.approvalId);
  const link = approvalLink(id);
  return p.inChannel
    ? `To decide, write a note: \`approve ${id}\` or \`deny ${id}\` — or decide in Hypotenuse: ${link}`
    : `A project member decides in Hypotenuse: ${link}`;
}

/**
 * Send an approval: for a customer reply, the draft and a note quoting it;
 * for anything else, a note.
 * @param inst - The installation.
 * @param ctx - The surface context.
 * @param issueId - The issue.
 * @param p - The approval row's payload.
 * @returns The note's id.
 */
async function sendApproval(
  inst: OpenInstallation,
  ctx: SurfaceContext,
  issueId: string,
  p: Record<string, unknown>,
): Promise<string> {
  const args = (p.args ?? {}) as Record<string, unknown>;
  if (p.server === "pylon" && p.tool === "reply_to_customer") {
    const text = String(args.text ?? "");
    let drafted = "";
    try {
      const draft = await pylonRequest<{ id: string }>(
        inst,
        "POST",
        `/issues/${encodeURIComponent(issueId)}/draft-reply`,
        {
          body_html: markdownToPylonHtml(text),
          ...(inst.installation.externalBotUserId
            ? { user_id: inst.installation.externalBotUserId }
            : {}),
        },
        { write: true },
      );
      await remember(ctx.conversation.id, { draftId: draft.id });
      drafted = " It is also saved as a draft reply on this issue.";
    } catch (e) {
      // A teammate's own draft is in the way (409): the note carries the text.
      if (!(e instanceof PylonApiError) || e.retryable) throw e;
    }
    const quoted = text
      .split("\n")
      .map((l) => `> ${l}`)
      .join("\n");
    return note(
      inst,
      ctx,
      issueId,
      `**Reply to the customer, waiting for approval (#${Number(p.approvalId)})**\n\n${quoted}\n\nApproving sends exactly this text to the customer.${drafted}\n\n${decideHow(p)}`,
    );
  }
  const json = JSON.stringify(args, null, 2).slice(0, 4000);
  return note(
    inst,
    ctx,
    issueId,
    `**I need approval to run \`${String(p.name)}\` (#${Number(p.approvalId)})**\n\n\`\`\`\n${json}\n\`\`\`\n\n${decideHow(p)}`,
  );
}

export const pylonAdapter: PlatformAdapter = {
  type: "pylon",
  label: "Pylon",
  installationSchema: pylonInstallationSchema as unknown as z.ZodType<
    Record<string, unknown>
  >,
  credentialSchema,
  capabilities: {
    threads: true,
    streaming: false,
    status: true,
    plan: true,
    buttons: false,
    ephemeral: false,
    edits: false,
    elicitation: false,
    typing: false,
  },
  settlesAtEnqueue: false,
  probeOnConnect: true,
  protectedSettings: ["customerReplyPolicy", "customerReplyPolicySetByUserId"],
  autoBindApprovalPolicy: "participants",

  manifest(bot, urls) {
    return {
      instructions: `A Pylon admin (1) creates an API token for ${bot.displayName} with its own identity — Settings → Integrations & dev → API tokens, named "${bot.displayName}", with a role that may read issues, accounts, and contacts and write notes — and (2) creates a webhook pointing at the URL below (Settings → Integrations & dev → Webhooks), copying its secret, which Pylon shows once. Then (3) creates the four Triggers below (Settings → Workflows → Triggers), each with a "Send webhook" action to that webhook and the body shown. Connect the token, the webhook secret, the region, and the token's name here.`,
      manifest: {
        token: {
          name: bot.displayName,
          ownIdentity: true,
          permissions:
            "read issues, messages, accounts, and contacts; write internal notes and draft replies; send replies only if the bot will ever reply to customers",
        },
        webhook: { url: urls.events, method: "POST" },
        triggers: PYLON_TRIGGERS.map((t) => ({
          kickoff: t.kickoff,
          action: "Send webhook",
          body: t.body,
        })),
      },
    };
  },

  verifyInbound(req: RawInbound, inst) {
    const secret = inst.credentials.webhookSecret;
    if (typeof secret !== "string" || secret === "") {
      return { ok: false, reason: "no secret" };
    }
    const v2 = (req.headers.get("x-pylon-signature-v2") ?? "")
      .toLowerCase()
      .replace(/^hs256=/, "");
    const ts = req.headers.get("x-pylon-timestamp") ?? "";
    if (/^[0-9a-f]{64}$/.test(v2) && /^\d{1,12}$/.test(ts)) {
      if (!safeEqual(pylonSignature(secret, ts, req.text), v2)) {
        return { ok: false, reason: "bad signature" };
      }
      if (
        Math.abs(Date.now() / 1000 - Number(ts)) >
        config.platforms.pylon.timestampToleranceSeconds
      ) {
        return { ok: false, reason: "stale" };
      }
      return { ok: true };
    }
    const legacy = (req.headers.get("x-pylon-signature") ?? "").toLowerCase();
    if (
      inst.installation.config.legacySignature === true &&
      /^[0-9a-f]{64}$/.test(legacy)
    ) {
      return safeEqual(pylonLegacySignature(secret, req.text), legacy)
        ? { ok: true }
        : { ok: false, reason: "bad signature" };
    }
    return { ok: false, reason: "unsigned" };
  },

  eventId: (body, req) => pylonEventId(body, req.headers),

  parseInbound: (body, inst) => parsePylonDelivery(body, inst),

  resolveChannel: (inbound) => inbound.channel,

  async hydrate(body, inst) {
    const b = (body ?? {}) as PylonWebhookBody;
    const issueId = String(b.issue_id ?? "").trim();
    // A Trigger whose variable is empty sends "" (or the template, unfilled).
    if (!issueId || issueId.includes("{{")) return { missing: true };
    const out: PylonHydrated = {};
    try {
      out.issue = await pylonRequest<PylonIssue>(
        inst,
        "GET",
        `/issues/${encodeURIComponent(issueId)}`,
      );
    } catch (e) {
      if (e instanceof PylonApiError && e.status === 404) {
        return { missing: true };
      }
      throw e;
    }
    const accountId = out.issue?.account?.id;
    if (accountId) {
      try {
        out.account = await pylonRequest<PylonAccount>(
          inst,
          "GET",
          `/accounts/${encodeURIComponent(accountId)}`,
        );
      } catch (e) {
        if (!(e instanceof PylonApiError) || e.retryable) throw e;
        out.account = { id: accountId };
      }
    }
    if (b.event === "issue_message") {
      const messages: PylonMessage[] = await pylonMessages(inst, issueId);
      const wanted = String(b.message_id ?? "");
      out.message =
        messages.find((m) => m.id === wanted) ??
        (wanted && !wanted.includes("{{") ? null : (messages.at(-1) ?? null));
    }
    const others = await api.db.db
      .select({ id: botInstallations.externalBotUserId })
      .from(botInstallations)
      .where(
        and(
          eq(botInstallations.projectId, inst.installation.projectId),
          eq(botInstallations.type, "pylon"),
          isNotNull(botInstallations.externalBotUserId),
          ne(botInstallations.id, inst.installation.id),
        ),
      );
    out.botUserIds = others
      .map((o) => o.id)
      .filter((id): id is string => typeof id === "string");
    return out as Record<string, unknown>;
  },

  async probe(inst) {
    const region = (inst.installation.config.region as PylonRegion) ?? "us";
    const token = String(inst.credentials.apiToken ?? "");
    try {
      const me = await pylonFetch<{
        id: string;
        name?: string;
        user: { id: string; email?: string };
      }>(region === "eu" ? "eu" : "us", token, "GET", "/me");
      return {
        externalBotUserId: me.user.id,
        config: {
          organizationId: me.id,
          ...(me.name ? { organizationName: me.name } : {}),
        },
      };
    } catch (e) {
      if (e instanceof PylonApiError) {
        if (e.wrongRegion) {
          throw new Error(
            `Pylon says this token belongs to the other region: connect it again with region "${region === "eu" ? "us" : "eu"}".`,
          );
        }
        throw new Error(`Pylon refused the token: ${e.detail} (${e.code}).`);
      }
      throw e;
    }
  },

  target(channel: Channel, conversationKey: string | null) {
    return {
      type: "platform",
      platform: "pylon",
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
    if (draft.kind === "status") {
      if (typeof draft.payload.text !== "string") {
        return { refused: true, reason: "A status needs text." };
      }
      // A note is permanent: only an acknowledgement or an escalation is one.
      if (draft.priority !== "ack" && draft.payload.escalation !== true) {
        return null;
      }
    }
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
    const issueId = issueOf(ctx);
    if (!issueId) return { outcome: "undeliverable", error: "No issue." };
    const { openInstallation } = await import(
      "../../ops/InstallationCredentialOps"
    );
    const inst = openInstallation(installation);
    const p = row.payload as Record<string, unknown>;
    try {
      switch (row.kind) {
        case "status": {
          if (row.priority === "ack") {
            // Only the first acknowledgement opens the thread; later ones
            // would be noise in a permanent record.
            const [fresh] = await api.db.db
              .select({ details: conversations.details })
              .from(conversations)
              .where(eq(conversations.id, ctx.conversation.id));
            if (fresh?.details?.noteMessageId) return { outcome: "sent" };
            const id = await note(
              inst,
              ctx,
              issueId,
              "Looking into this.",
              true,
            );
            return { outcome: "sent", externalMessageId: id };
          }
          const id = await note(inst, ctx, issueId, String(p.text));
          return { outcome: "sent", externalMessageId: id };
        }
        case "plan":
        case "stream":
          return { outcome: "sent" };
        case "question": {
          // The options are already listed in the text (applyFallbacks).
          const name = String(installation.config.selfName ?? "");
          const id = await note(
            inst,
            ctx,
            issueId,
            `**A question for the team**\n\n${String(p.text).replace(/\n\nReply with your answer\.$/, "")}\n\nAnswer in a note${name ? ` that mentions ${name}` : ""}.${checklist(await turnSteps(row))}`,
          );
          return { outcome: "sent", externalMessageId: id };
        }
        case "approval": {
          const id = await sendApproval(inst, ctx, issueId, p);
          return { outcome: "sent", externalMessageId: id };
        }
        default: {
          const failed = p.messageKind === "error" || p.messageKind === "fail";
          const id = await note(
            inst,
            ctx,
            issueId,
            `${failed ? "**I could not finish this.**\n\n" : ""}${String(p.text)}${checklist(await turnSteps(row))}`,
          );
          return { outcome: "sent", externalMessageId: id };
        }
      }
    } catch (e) {
      if (e instanceof PylonApiError) {
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
