import { config } from "keryx";
import type { OutboxDraft, SurfaceCapabilities } from "./types";

/**
 * The interactive surface's fallbacks: what a kind becomes on a surface that
 * lacks the capability its rich form needs.
 *
 * | Kind | Rich form | Fallback |
 * |---|---|---|
 * | `status` | a working line | dropped |
 * | `stream` | partial text | dropped; the final `message` carries the text |
 * | `plan` | the turn's steps | dropped |
 * | `message` | a reply | plain text |
 * | `question` | buttons for its options | text listing the options; the next message is the answer |
 * | `approval` | Approve / Deny buttons | text with the dashboard link |
 */

/** The ephemeral kinds: a newer row supersedes an older undelivered one. */
export const EPHEMERAL_KINDS = ["status", "stream", "plan"] as const;

/**
 * Whether a kind is ephemeral.
 * @param kind - The kind.
 * @returns `true` for `status`, `stream`, and `plan`.
 */
export function isEphemeral(kind: string): boolean {
  return (EPHEMERAL_KINDS as readonly string[]).includes(kind);
}

/**
 * The dashboard link to an approval.
 * @param approvalId - The approval.
 * @returns An absolute URL.
 */
export function approvalLink(approvalId: number): string {
  return `${config.frontend.url.replace(/\/+$/, "")}/approvals/${approvalId}`;
}

/**
 * Apply the fallbacks for a surface's capabilities: drop what it cannot show,
 * and turn buttons into text where it has none.
 * @param draft - The draft.
 * @param caps - The surface's capabilities.
 * @returns The draft as this surface takes it, or `null` to drop it.
 */
export function applyFallbacks(
  draft: OutboxDraft,
  caps: SurfaceCapabilities,
): OutboxDraft | null {
  switch (draft.kind) {
    case "status":
      return caps.status ? draft : null;
    case "stream":
      return caps.streaming ? draft : null;
    case "plan":
      return caps.plan ? draft : null;
    case "question": {
      const options = (draft.payload.options as string[] | undefined) ?? [];
      if (caps.buttons || options.length === 0) return draft;
      const text = `${String(draft.payload.text)}\n\n${options
        .map((o, i) => `${i + 1}. ${o}`)
        .join("\n")}\n\nReply with your answer.`;
      return { ...draft, payload: { ...draft.payload, text } };
    }
    case "approval": {
      if (caps.buttons) return draft;
      const p = draft.payload;
      const inChannel = p.inChannel
        ? ` Or reply \`approve ${p.approvalId}\` or \`deny ${p.approvalId}\`.`
        : "";
      return {
        ...draft,
        payload: {
          ...p,
          text: `I need approval to run ${String(p.name)}. Decide at ${approvalLink(Number(p.approvalId))}.${inChannel}`,
        },
      };
    }
    default:
      return draft;
  }
}
