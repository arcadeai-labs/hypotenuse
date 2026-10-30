import type { ConversationEntries } from "@backend/actions/conversation/conversation-entries";
import type { ConversationList } from "@backend/actions/conversation/conversation-list";
import type { ConversationView } from "@backend/actions/conversation/conversation-view";
import type { ActionResponse } from "keryx";
import type {
  ConversationStatus,
  Platform,
  WaitingOn,
} from "../../../../design/states";
import { PLATFORMS, WAITING_ON } from "../../../../design/states";

/** One transcript entry, as `conversation:entries` serializes it. */
export type Entry = ActionResponse<ConversationEntries>["entries"][number];

/** A conversation, as every conversation action serializes it. */
export type Conversation = ActionResponse<ConversationEntries>["conversation"];

/** `conversation:view`'s answer: the conversation, its bot, channel, and standing. */
export type ConversationViewResponse = ActionResponse<ConversationView>;

/** One row of `conversation:list`. */
export type ConversationRow =
  ActionResponse<ConversationList>["conversations"][number];

/** The tools whose call is the bot speaking to the person. */
const SPEAKING_TOOLS: Record<string, string> = {
  reply_and_wait: "text",
  complete: "summary",
  fail: "reason",
};

/** A transcript entry turned into what the page draws. */
export type TranscriptItem =
  | {
      kind: "person";
      key: string;
      seq: number;
      text: string;
      userId: number | null;
      createdAt: number;
    }
  | {
      kind: "bot";
      key: string;
      seq: number;
      text: string;
      /** The terminal tool that posted it: `reply_and_wait`, `complete`, or `fail`. */
      tool: string;
      createdAt: number;
    }
  | {
      kind: "question";
      key: string;
      seq: number;
      question: string;
      options: string[];
      createdAt: number;
    }
  | {
      /** Text the model wrote in a step, which no tool posted to anyone. */
      kind: "note";
      key: string;
      seq: number;
      text: string;
    }
  | { kind: "thinking"; key: string; seq: number; text: string }
  | {
      kind: "tool";
      key: string;
      seq: number;
      toolName: string;
      input: unknown;
      output: unknown;
      status: ToolCallStatus;
      /** `safe` or `unsafe`: whether recovery may run it again. */
      replay: string | null;
      durationMs: number | null;
    }
  | {
      kind: "status";
      key: string;
      seq: number;
      text: string;
      detail: string | null;
      tone: "quiet" | "error";
      createdAt: number;
    }
  | { kind: "prompt"; key: string; seq: number; prompt: string }
  | {
      kind: "compaction";
      key: string;
      seq: number;
      summary: string;
      throughSeq: number;
    };

/**
 * Where a tool call stands. `running` has an intent and no result while the
 * conversation works; `unsettled` has none and the conversation is not
 * working (recovery has not reached it yet); `interrupted` is a result
 * recovery wrote because the call may or may not have run.
 */
export type ToolCallStatus =
  | "running"
  | "unsettled"
  | "ok"
  | "error"
  | "interrupted";

/**
 * Read a string field of an entry's content.
 * @param content - The entry's content.
 * @param key - The field.
 * @returns The string, or `""`.
 */
function text(content: Record<string, unknown>, key: string): string {
  const value = content[key];
  return typeof value === "string" ? value : "";
}

/**
 * Whether a tool's output is an error envelope.
 * @param output - The stored output.
 * @returns `true` for `{ is_error: true }`.
 */
function isErrorOutput(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    (output as { is_error?: unknown }).is_error === true
  );
}

/** Why a conversation woke, as a person reads it. */
const WAKE_WORDS: Record<string, string> = {
  created: "Started",
  message: "Woke for a new message",
  answer: "Woke with an answer",
  answered: "Took the message waiting as the answer",
  timer: "Woke when its timer ended",
  question_timeout: "Woke: nobody answered in time",
  cancel: "Woke to stop",
  nudge: "Nudged to end its turn with a tool",
};

/**
 * The sentence a `status_change` entry reads as.
 * @param content - The entry's content: `from`, `to`, `reason`, `outcome`, `text`.
 * @returns The line, an optional detail, and its tone.
 */
export function statusLine(content: Record<string, unknown>): {
  text: string;
  detail: string | null;
  tone: "quiet" | "error";
} {
  const to = text(content, "to");
  const reason = text(content, "reason");
  const outcome = text(content, "outcome");
  const detail = text(content, "text") || null;
  switch (to) {
    case "working":
      return {
        text:
          text(content, "from") === "new"
            ? "Started"
            : (WAKE_WORDS[reason] ?? "Working"),
        detail,
        tone: "quiet",
      };
    case "hibernating":
      return { text: "Resting until someone writes", detail, tone: "quiet" };
    case "waiting":
      return {
        text:
          reason === "timer" ? "Waiting on a timer" : "Waiting for an answer",
        detail,
        tone: "quiet",
      };
    case "ended":
      if (outcome === "cancelled" || reason === "cancelled") {
        // The detail only repeats the line.
        return { text: "Cancelled", detail: null, tone: "quiet" };
      }
      if (outcome === "failed") {
        return {
          text: reason === "turn_failed" ? "The turn failed" : "Ended: failed",
          detail,
          tone: "error",
        };
      }
      return { text: "Ended: completed", detail, tone: "quiet" };
    default:
      return { text: to || "State changed", detail, tone: "quiet" };
  }
}

/**
 * Turn a transcript's entries into what the page draws, in order.
 *
 * - A tool call is one item: its intent, joined with its result by
 *   `toolCallId`, so a call reads as one collapsed row.
 * - A terminal call that posted something (`reply_and_wait`, `complete`,
 *   `fail`, `ask_question`) is drawn as the bot speaking, not as a call —
 *   unless it failed or was interrupted, when nobody can be sure it was
 *   posted, and it stays a call.
 * - An assistant message with no text is a step's record (model, tokens,
 *   timing): nothing to read, so it draws nothing.
 * @param entries - The entries, oldest first.
 * @param working - Whether the conversation is working now: an open call then spins.
 * @returns The items.
 */
export function buildTranscript(
  entries: readonly Entry[],
  working: boolean,
): TranscriptItem[] {
  const results = new Map<string, Entry>();
  for (const entry of entries) {
    if (entry.kind === "tool_result" && entry.toolCallId) {
      results.set(entry.toolCallId, entry);
    }
  }

  const items: TranscriptItem[] = [];
  for (const entry of entries) {
    const content = (entry.content ?? {}) as Record<string, unknown>;
    const key = `e${entry.seq}`;
    switch (entry.kind) {
      case "message": {
        const body = text(content, "text");
        if (entry.role === "user") {
          items.push({
            kind: "person",
            key,
            seq: entry.seq,
            text: body,
            userId: entry.userId,
            createdAt: entry.createdAt,
          });
        } else if (body.trim()) {
          items.push({ kind: "note", key, seq: entry.seq, text: body });
        }
        break;
      }
      case "thinking": {
        const body = text(content, "text");
        if (body.trim()) {
          items.push({ kind: "thinking", key, seq: entry.seq, text: body });
        }
        break;
      }
      case "tool_call_intent": {
        const result = entry.toolCallId
          ? results.get(entry.toolCallId)
          : undefined;
        const output = result
          ? (result.content as Record<string, unknown>).output
          : undefined;
        const status: ToolCallStatus = !result
          ? working
            ? "running"
            : "unsettled"
          : result.interrupted
            ? "interrupted"
            : isErrorOutput(output)
              ? "error"
              : "ok";
        const input = (content.input ?? {}) as Record<string, unknown>;
        const toolName = entry.toolName ?? "tool";
        if (status === "ok" && toolName in SPEAKING_TOOLS) {
          items.push({
            kind: "bot",
            key,
            seq: entry.seq,
            text: text(input, SPEAKING_TOOLS[toolName] ?? "text"),
            tool: toolName,
            createdAt: result?.createdAt ?? entry.createdAt,
          });
          break;
        }
        if (status === "ok" && toolName === "ask_question") {
          items.push({
            kind: "question",
            key,
            seq: entry.seq,
            question: text(input, "question"),
            options: Array.isArray(input.options)
              ? input.options.filter((o): o is string => typeof o === "string")
              : [],
            createdAt: result?.createdAt ?? entry.createdAt,
          });
          break;
        }
        items.push({
          kind: "tool",
          key,
          seq: entry.seq,
          toolName,
          input,
          output,
          status,
          replay: entry.replay,
          durationMs: result?.durationMs ?? null,
        });
        break;
      }
      case "tool_result":
        // Drawn with its intent. A result whose intent is missing would be a
        // corrupt transcript; there is nothing honest to draw for it alone.
        break;
      case "context_update":
        items.push({
          kind: "prompt",
          key,
          seq: entry.seq,
          prompt: text(content, "prompt"),
        });
        break;
      case "status_change": {
        // A turn's own ending is already said by the bot's message; the line
        // still marks where the state moved.
        const line = statusLine(content);
        items.push({
          kind: "status",
          key,
          seq: entry.seq,
          ...line,
          createdAt: entry.createdAt,
        });
        break;
      }
      case "compaction":
        items.push({
          kind: "compaction",
          key,
          seq: entry.seq,
          summary: text(content, "summary"),
          throughSeq: Number(content.throughSeq ?? 0),
        });
        break;
    }
  }
  return items;
}

/**
 * The status a conversation's glyph draws, from what the server reports.
 *
 * The server's `completed` is the design table's `complete`; `failed` and
 * `cancelled` are the same names in both.
 * @param c - The conversation's `state`, `waitingOn`, and `outcome`.
 * @returns The status for `StatusGlyph`.
 */
export function conversationStatus(
  c: Pick<Conversation, "state" | "waitingOn" | "outcome">,
): ConversationStatus {
  switch (c.state) {
    case "waiting": {
      const kind = c.waitingOn?.kind;
      const waitingOn: WaitingOn = (WAITING_ON as readonly string[]).includes(
        kind ?? "",
      )
        ? (kind as WaitingOn)
        : "answer";
      return { state: "waiting", waitingOn };
    }
    case "ended":
      return {
        state: "ended",
        outcome:
          c.outcome === "completed"
            ? "complete"
            : c.outcome === "cancelled"
              ? "cancelled"
              : "failed",
      };
    case "working":
      return { state: "working" };
    default:
      return { state: "hibernating" };
  }
}

/**
 * The words for a conversation's state, naming what it waits on and how it
 * ended.
 * @param c - The conversation's `state`, `waitingOn`, and `outcome`.
 * @returns "Working", "Waiting for an answer", "Cancelled", ….
 */
export function conversationStateLabel(
  c: Pick<Conversation, "state" | "waitingOn" | "outcome">,
): string {
  switch (c.state) {
    case "working":
      return "Working";
    case "hibernating":
      return "Hibernating";
    case "waiting":
      switch (c.waitingOn?.kind) {
        case "timer":
          return "Waiting on a timer";
        case "approval":
          return "Waiting for approval";
        case "sandbox":
          return "Waiting on a sandbox";
        default:
          return "Waiting for an answer";
      }
    case "ended":
      if (c.outcome === "cancelled") return "Cancelled";
      if (c.outcome === "failed") return "Failed";
      return "Completed";
    default:
      return c.state;
  }
}

/**
 * The platform chip for a channel type. A type the kit does not draw yet is
 * shown as the API, which is the only channel that exists today.
 * @param type - The channel's `type`.
 * @returns The platform.
 */
export function platformOf(type: string): Platform {
  return (PLATFORMS as readonly string[]).includes(type)
    ? (type as Platform)
    : "api";
}

/**
 * The newest seq among entries, or the floor given.
 * @param entries - Entries, any order.
 * @param floor - What to answer for none.
 * @returns The highest seq.
 */
export function lastSeqOf(entries: readonly Entry[], floor = 0): number {
  let max = floor;
  for (const entry of entries) if (entry.seq > max) max = entry.seq;
  return max;
}

/**
 * Add newly read entries to those held, keeping seq order and dropping any
 * already held — a re-read after a reconnect may overlap.
 * @param held - The entries the page has.
 * @param incoming - Entries just read.
 * @returns The merged list, or `held` itself when nothing was new.
 */
export function mergeEntries(
  held: readonly Entry[],
  incoming: readonly Entry[],
): Entry[] {
  const seen = new Set(held.map((e) => e.seq));
  const fresh = incoming.filter((e) => !seen.has(e.seq));
  if (fresh.length === 0) return held as Entry[];
  return [...held, ...fresh].sort((a, b) => a.seq - b.seq);
}

/**
 * A tool call's input on one line, for its collapsed row.
 * @param input - The call's input.
 * @param max - The longest it may be.
 * @returns Compact JSON, truncated with an ellipsis.
 */
export function oneLine(input: unknown, max = 120): string {
  let json: string;
  try {
    json = JSON.stringify(input) ?? "";
  } catch {
    json = String(input);
  }
  if (json === "{}") return "";
  return json.length > max ? `${json.slice(0, max - 1)}…` : json;
}

/** The page size the list asks for. */
export const CONVERSATIONS_PAGE_SIZE = 25;

/**
 * The query string for one page of the list.
 * @param filters - The bot (when the list is one bot's) and the state.
 * @param page - The 1-indexed page.
 * @returns `?page=…&limit=…`, with `botId` and `state` when set.
 */
export function conversationsQuery(
  filters: { botId?: number; state?: string },
  page: number,
): string {
  const params = new URLSearchParams({
    page: String(page),
    limit: String(CONVERSATIONS_PAGE_SIZE),
  });
  if (filters.botId) params.set("botId", String(filters.botId));
  if (filters.state) params.set("state", filters.state);
  return `?${params}`;
}

/**
 * What to call a conversation. The server keeps a title only when its
 * creator gave one; otherwise the first line of the first message stands in,
 * when the page has the transcript, and the id when it does not.
 * @param c - The conversation's `id` and `title`.
 * @param entries - Its transcript, when the caller holds it.
 * @returns The title.
 */
export function conversationTitle(
  c: { id: number; title: string | null },
  entries: readonly Entry[] = [],
): string {
  if (c.title) return c.title;
  const first = entries.find((e) => e.kind === "message" && e.role === "user");
  const body = first
    ? text(first.content as Record<string, unknown>, "text")
    : "";
  const line = body
    .split("\n")
    .find((l) => l.trim())
    ?.trim();
  if (line) return line.length > 80 ? `${line.slice(0, 79)}…` : line;
  return `Conversation #${c.id}`;
}
