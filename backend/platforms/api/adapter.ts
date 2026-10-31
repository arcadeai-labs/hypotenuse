import { eq } from "drizzle-orm";
import { api, config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/agents";
import { decryptSecret } from "../../ops/CryptoOps";
import { guardedFetch, HostRefused } from "../../ops/NetworkGuardOps";
import { signCallback } from "../../ops/SignatureOps";
import { bots } from "../../schema/bots";
import { NO_CAPABILITIES, type SurfaceAdapter } from "../types";

/**
 * **The API channel**: conversations created over HTTP. Its surface is a
 * signed callback, when the caller gave one, carrying final messages only —
 * `{conversationId, entrySeq, kind, text, options?}` with `kind` one of
 * `reply`, `complete`, `fail`, `question`, `error`. Without a callback URL
 * the transcript is the message and a poller reads it, so nothing is
 * written.
 *
 * | Answer | Then |
 * |---|---|
 * | 2xx | `sent` |
 * | 408, 429, 5xx, a network error, a lost response | retried with back-off until the window (24 h) ends, then `undeliverable` |
 * | any other 4xx, a refused host, no secret | `undeliverable` |
 */
export const apiAdapter: SurfaceAdapter = {
  type: "api",
  capabilities: { ...NO_CAPABILITIES },
  settlesAtEnqueue: false,
  validateOutbound(draft, { conversation }) {
    if (!conversation.callbackUrl) return null;
    if (draft.kind !== "message" && draft.kind !== "question") return null;
    const p = draft.payload;
    return {
      ...draft,
      payload: {
        conversationId: conversation.id,
        entrySeq: p.entrySeq,
        kind: draft.kind === "question" ? "question" : p.messageKind,
        text: p.text,
        ...(p.options ? { options: p.options } : {}),
      },
    };
  },
  async send(row, { conversation }) {
    const timeout = config.agents.callbackTimeoutMs;
    const target = row.target;
    if (target.type !== "api-callback") {
      return { outcome: "undeliverable", error: "Not an API callback row." };
    }
    try {
      const [owner] = await api.db.db
        .select({ secret: bots.apiCallbackSecret })
        .from(bots)
        .where(eq(bots.id, conversation.botId))
        .limit(1);
      if (!owner?.secret) {
        return {
          outcome: "undeliverable",
          error: "The bot has no callback secret.",
        };
      }
      const secret = decryptSecret(owner.secret);
      const body = JSON.stringify(row.payload);
      const res = await guardedFetch(target.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "Hypotenuse-Callback/1",
          "hypotenuse-signature": signCallback(
            secret,
            body,
            Math.floor(Date.now() / 1000),
          ),
          "hypotenuse-delivery": String(row.id),
        },
        body,
        signal: AbortSignal.timeout(timeout),
      });
      await res.body?.cancel().catch(() => {});
      if (res.status >= 200 && res.status < 300) return { outcome: "sent" };
      const retryable =
        res.status === 408 || res.status === 429 || res.status >= 500;
      return {
        outcome: retryable ? "retry" : "undeliverable",
        error: `The receiver answered HTTP ${res.status}.`,
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
