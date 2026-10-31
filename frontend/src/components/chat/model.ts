import type { ConversationLive } from "@backend/actions/conversation/conversation-live";
import type { ActionResponse } from "keryx";
import type { Entry } from "../transcript/model";

/** `conversation:live`'s answer: the status line, streamed text, and plan. */
export type LiveSurface = ActionResponse<ConversationLive>["live"];

/** One step of a turn's plan, as `conversation:live` reports it. */
export interface PlanStep {
  seq: number;
  tool: string;
  state: "running" | "done" | "error";
}

/**
 * The tools whose call is the bot speaking, and which input field holds what
 * it said.
 */
export const SPEAKING_TOOLS: Readonly<Record<string, string>> = {
  reply_and_wait: "text",
  complete: "summary",
  fail: "reason",
};

/** The ending a `complete` or `fail` bubble shows as a chip. */
const OUTCOMES: Readonly<Record<string, "completed" | "failed">> = {
  complete: "completed",
  fail: "failed",
};

/** What a bot bubble's collapsed diagnostics show about the step that posted it. */
export interface StepDiagnostics {
  /** The model name the bot used (`default`, `fast`), when the step recorded it. */
  alias: string | null;
  /** The provider's model id. */
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  /** The hash of the system prompt the step was sent. */
  promptHash: string | null;
}

/** One line of the chat. */
export type ChatItem =
  | {
      /** A message a person wrote: a member in the dashboard, or a platform participant. */
      kind: "person";
      key: string;
      seq: number;
      text: string;
      userId: number | null;
      participantId: number | null;
      createdAt: number;
    }
  | {
      /** A message the system wrote into the conversation (a timeout, a wake, a help answer), or a turn that failed. */
      kind: "system";
      key: string;
      seq: number;
      text: string;
      tone: "quiet" | "error";
      createdAt: number;
    }
  | {
      /** What the bot posted: a reply, or its closing summary or failure. */
      kind: "bot";
      key: string;
      seq: number;
      text: string;
      tool: string;
      /** `complete` and `fail` end the conversation, and say how. */
      outcome: "completed" | "failed" | null;
      diagnostics: StepDiagnostics | null;
      createdAt: number;
    }
  | {
      /** A question the bot asked, with its options. */
      kind: "question";
      key: string;
      seq: number;
      question: string;
      options: string[];
      /** Whether it is the newest question: only that one can be answered. */
      latest: boolean;
      diagnostics: StepDiagnostics | null;
      createdAt: number;
    }
  | {
      /** The conversation paused on tool calls waiting for approval. */
      kind: "approval";
      key: string;
      seq: number;
      /** The intent entries of the step that asked, which an approval names as its `entryId`. */
      callEntryIds: number[];
      createdAt: number;
    }
  | {
      /** The work between two lines a person reads: tool calls, model steps, prompt changes, thinking. */
      kind: "steps";
      key: string;
      /** Every entry counted, so the transcript can open on them. */
      seqs: number[];
      count: number;
      /** A terminal call errored or was interrupted among them. */
      warning: boolean;
      /** A call among them has not finished. */
      running: boolean;
    }
  | {
      kind: "compaction";
      key: string;
      seq: number;
      summary: string;
      throughSeq: number;
    };

/** What {@link buildChat} needs besides the entries. */
export interface ChatOptions {
  /** Whether the conversation is working now: an open call then counts as running. */
  working?: boolean;
}

/**
 * Read a string field.
 * @param content - An entry's content.
 * @param key - The field.
 * @returns The string, or `""`.
 */
function str(content: Record<string, unknown>, key: string): string {
  const value = content[key];
  return typeof value === "string" ? value : "";
}

/**
 * Read a number that may be missing.
 * @param value - The field.
 * @returns The number, or `null`.
 */
function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Whether a stored tool output is an error envelope.
 * @param output - The output.
 * @returns `true` for `{ is_error: true }`.
 */
function isError(output: unknown): boolean {
  return (
    typeof output === "object" &&
    output !== null &&
    (output as { is_error?: unknown }).is_error === true
  );
}

/**
 * The diagnostics of the model step an entry came from, read off that step's
 * record (its assistant `message`).
 * @param step - The step's record, if there is one.
 * @returns The diagnostics, or `null`.
 */
export function stepDiagnostics(
  step: Entry | undefined,
): StepDiagnostics | null {
  if (!step) return null;
  const content = (step.content ?? {}) as Record<string, unknown>;
  return {
    alias: str(content, "alias") || null,
    model: str(content, "model") || null,
    inputTokens: num(step.inputTokens),
    outputTokens: num(step.outputTokens),
    durationMs: num(step.durationMs),
    promptHash: step.promptHash ?? null,
  };
}

/**
 * Turn a conversation's entries into its chat, one row per entry kind:
 *
 * | Entry | Chat item |
 * |---|---|
 * | `message` from a person | `person`, with their user or participant id |
 * | `message` from the system | a centred `system` line |
 * | `reply_and_wait`, `complete`, `fail` with an ok result | a `bot` bubble; `complete` and `fail` carry an outcome |
 * | `ask_question` with an ok result | a `question` card |
 * | a wait on approvals | an `approval` card, naming the step's calls |
 * | any other tool call, model step, context update, thinking | counted into the turn's `steps` line |
 * | a terminal call that errored or was interrupted | counted, and the `steps` line warns |
 * | `compaction` | a `compaction` divider |
 *
 * A turn that fails, or is cancelled, also leaves a `system` line, since a
 * chat that went quiet would otherwise not say why. Other state changes draw
 * nothing: the bubbles already say what happened. The model step that posted
 * a bubble is that bubble's diagnostics, not a counted step.
 * @param entries - The entries, oldest first.
 * @param options - See {@link ChatOptions}.
 * @returns The chat's items, in order.
 */
export function buildChat(
  entries: readonly Entry[],
  options: ChatOptions = {},
): ChatItem[] {
  const results = new Map<string, Entry>();
  const steps = new Map<string, Entry>();
  for (const entry of entries) {
    if (entry.kind === "tool_result" && entry.toolCallId) {
      results.set(entry.toolCallId, entry);
    }
    if (
      entry.kind === "message" &&
      entry.role === "assistant" &&
      entry.stepId
    ) {
      steps.set(entry.stepId, entry);
    }
  }

  // Steps whose record is a posted bubble's diagnostics rather than work.
  const speakingSteps = new Set<string>();
  for (const entry of entries) {
    if (entry.kind !== "tool_call_intent" || !entry.stepId) continue;
    const name = entry.toolName ?? "";
    if (!(name in SPEAKING_TOOLS) && name !== "ask_question") continue;
    const result = entry.toolCallId ? results.get(entry.toolCallId) : undefined;
    const output = result
      ? (result.content as Record<string, unknown>).output
      : undefined;
    if (result && !result.interrupted && !isError(output)) {
      speakingSteps.add(entry.stepId);
    }
  }

  const items: ChatItem[] = [];
  let group: { seqs: number[]; warning: boolean; running: boolean } | null =
    null;
  // The newest step's intents, for the approval card a wait draws.
  let lastStepId: string | null = null;
  let stepIntents: number[] = [];

  const count = (seq: number, warn = false, running = false) => {
    group ??= { seqs: [], warning: false, running: false };
    group.seqs.push(seq);
    if (warn) group.warning = true;
    if (running) group.running = true;
  };
  const flush = () => {
    if (group && group.seqs.length > 0) {
      items.push({
        kind: "steps",
        key: `s${group.seqs[0]}`,
        seqs: group.seqs,
        count: group.seqs.length,
        warning: group.warning,
        running: group.running,
      });
    }
    group = null;
  };

  for (const entry of entries) {
    const content = (entry.content ?? {}) as Record<string, unknown>;
    const key = `c${entry.seq}`;
    switch (entry.kind) {
      case "message": {
        if (entry.role === "assistant") {
          if (entry.stepId && entry.stepId !== lastStepId) {
            lastStepId = entry.stepId;
            stepIntents = [];
          }
          if (!entry.stepId || !speakingSteps.has(entry.stepId)) {
            count(entry.seq);
          }
          break;
        }
        const source = str(content, "source");
        flush();
        if (source === "system" || source === "event") {
          items.push({
            kind: "system",
            key,
            seq: entry.seq,
            text: str(content, "text"),
            tone: "quiet",
            createdAt: entry.createdAt,
          });
        } else {
          items.push({
            kind: "person",
            key,
            seq: entry.seq,
            text: str(content, "text"),
            userId: entry.userId,
            participantId: entry.participantId,
            createdAt: entry.createdAt,
          });
        }
        break;
      }
      case "thinking":
      case "context_update":
        count(entry.seq);
        break;
      case "tool_call_intent": {
        if (entry.stepId && entry.stepId !== lastStepId) {
          lastStepId = entry.stepId;
          stepIntents = [];
        }
        stepIntents.push(entry.id);
        const name = entry.toolName ?? "tool";
        const result = entry.toolCallId
          ? results.get(entry.toolCallId)
          : undefined;
        const output = result
          ? (result.content as Record<string, unknown>).output
          : undefined;
        const failed = !!result && (result.interrupted || isError(output));
        const terminal = name in SPEAKING_TOOLS || name === "ask_question";
        const input = (content.input ?? {}) as Record<string, unknown>;
        const diagnostics = stepDiagnostics(
          entry.stepId ? steps.get(entry.stepId) : undefined,
        );
        if (result && !failed && name in SPEAKING_TOOLS) {
          flush();
          items.push({
            kind: "bot",
            key,
            seq: entry.seq,
            text: str(input, SPEAKING_TOOLS[name] ?? "text"),
            tool: name,
            outcome: OUTCOMES[name] ?? null,
            diagnostics,
            createdAt: result.createdAt,
          });
          break;
        }
        if (result && !failed && name === "ask_question") {
          flush();
          items.push({
            kind: "question",
            key,
            seq: entry.seq,
            question: str(input, "question"),
            options: Array.isArray(input.options)
              ? input.options.filter((o): o is string => typeof o === "string")
              : [],
            latest: false,
            diagnostics,
            createdAt: result.createdAt,
          });
          break;
        }
        count(
          entry.seq,
          terminal && failed,
          !result && options.working === true,
        );
        break;
      }
      case "tool_result":
        // Drawn with its intent.
        break;
      case "status_change": {
        const to = str(content, "to");
        const reason = str(content, "reason");
        const outcome = str(content, "outcome");
        if (to === "waiting" && reason === "approval") {
          flush();
          items.push({
            kind: "approval",
            key,
            seq: entry.seq,
            callEntryIds: [...stepIntents],
            createdAt: entry.createdAt,
          });
        } else if (to === "ended" && reason === "turn_failed") {
          flush();
          items.push({
            kind: "system",
            key,
            seq: entry.seq,
            text: str(content, "text")
              ? `The turn failed: ${str(content, "text")}`
              : "The turn failed",
            tone: "error",
            createdAt: entry.createdAt,
          });
        } else if (
          to === "ended" &&
          (outcome === "cancelled" || reason === "cancelled")
        ) {
          flush();
          items.push({
            kind: "system",
            key,
            seq: entry.seq,
            text: "Cancelled",
            tone: "quiet",
            createdAt: entry.createdAt,
          });
        }
        break;
      }
      case "compaction":
        flush();
        items.push({
          kind: "compaction",
          key,
          seq: entry.seq,
          summary: str(content, "summary"),
          throughSeq: Number(content.throughSeq ?? 0),
        });
        break;
    }
  }
  flush();

  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "question") {
      item.latest = true;
      break;
    }
  }
  return items;
}

/**
 * What a steps line says.
 * @param count - How many steps it counts.
 * @returns "Worked through 1 step", "Worked through 4 steps".
 */
export function stepsLabel(count: number): string {
  return `Worked through ${count} ${count === 1 ? "step" : "steps"}`;
}

/**
 * Where a steps line leads: the transcript view of the conversation, opened
 * on the entries it counts.
 * @param conversationId - The conversation.
 * @param seqs - The entries.
 * @returns The path.
 */
export function stepsHref(
  conversationId: number,
  seqs: readonly number[],
): string {
  return `/conversations/${conversationId}?view=transcript&seqs=${seqs.join(",")}`;
}

/**
 * A bubble's diagnostics on one line: model, tokens, duration, prompt hash.
 * @param d - The diagnostics.
 * @returns e.g. "default · claude-x · 1,200 in / 80 out · 2.4s · prompt 3f9a1c2b".
 */
export function diagnosticsLine(d: StepDiagnostics): string {
  const parts: string[] = [];
  if (d.alias && d.model) parts.push(`${d.alias} (${d.model})`);
  else if (d.alias || d.model) parts.push((d.alias ?? d.model) as string);
  if (d.inputTokens !== null || d.outputTokens !== null) {
    parts.push(
      `${(d.inputTokens ?? 0).toLocaleString("en-US")} in / ${(d.outputTokens ?? 0).toLocaleString("en-US")} out`,
    );
  }
  if (d.durationMs !== null) {
    parts.push(
      d.durationMs < 1000
        ? `${Math.round(d.durationMs)}ms`
        : `${(d.durationMs / 1000).toFixed(1)}s`,
    );
  }
  if (d.promptHash) parts.push(`prompt ${d.promptHash.slice(0, 8)}`);
  return parts.join(" · ");
}

/** A skill a bot may run, as the composer completes it. */
export interface SkillChoice {
  name: string;
  description: string;
}

/**
 * The skills a composer offers for what is typed: while the text is a `/`
 * followed by part of a name (and nothing after it), every skill whose name
 * starts with that part, then those that merely contain it.
 * @param text - What is in the box.
 * @param skills - The bot's skills.
 * @returns The matches, or none when the text is not a skill being named.
 */
export function skillCompletions(
  text: string,
  skills: readonly SkillChoice[],
): SkillChoice[] {
  const match = /^\/([A-Za-z0-9._-]*)$/.exec(text);
  if (!match) return [];
  const part = (match[1] ?? "").toLowerCase();
  const starts = skills.filter((s) => s.name.toLowerCase().startsWith(part));
  const contains = skills.filter(
    (s) =>
      !s.name.toLowerCase().startsWith(part) &&
      s.name.toLowerCase().includes(part),
  );
  return [...starts, ...contains];
}

/**
 * The newest `web` conversation a person started with a bot, from a page of
 * `conversation:list` rows (newest activity first).
 * @param rows - The rows.
 * @param userId - The person.
 * @returns Its id, or `null` when they have none.
 */
export function newestWebConversation(
  rows: readonly {
    id: number;
    createdByUserId: number | null;
    channel: { type: string };
  }[],
  userId: number | null,
): number | null {
  if (userId === null) return null;
  const found = rows.find(
    (r) => r.channel.type === "web" && r.createdByUserId === userId,
  );
  return found ? found.id : null;
}

/**
 * Which view of a conversation the page shows: what the address asks for,
 * else the chat for a dashboard conversation and the transcript for any other.
 * @param param - The `view` search parameter.
 * @param channelType - The conversation's channel type.
 * @returns `chat` or `transcript`.
 */
export function conversationViewOf(
  param: string | null,
  channelType: string,
): "chat" | "transcript" {
  if (param === "chat" || param === "transcript") return param;
  return channelType === "web" ? "chat" : "transcript";
}

/**
 * Whether a live surface has anything to show.
 * @param live - The surface, or `null`.
 * @returns `true` when a status, streamed text, or plan is current.
 */
export function hasLive(live: LiveSurface | null): boolean {
  return !!live && (!!live.status || !!live.stream?.text || !!live.plan);
}
