import type { z } from "zod";
import type { ApprovalDraft, GateOutcome } from "../ops/ApprovalOps";
import type { DbHandle, TxHandle } from "../ops/DbOps";
import type { Bot } from "../schema/bots";
import type { Conversation, WaitingOn } from "../schema/conversations";

/**
 * The tool contract. A tool is defined once, here under `tools/`, and the tick,
 * tests, and later the MCP surface all use the same definition.
 */

/** Whether a call with an intent and no result may be run again after a crash. */
export type Replay = "safe" | "unsafe";

/** What a call needs to know about where it runs. */
export interface ToolContext {
  /** The conversation, as the tick last read it. */
  conversation: Conversation;
  /** The bot running the call. */
  bot: Bot;
  /** The model's id for this call. */
  toolCallId: string;
  /** The `conversation_entries.id` of this call's intent. */
  intentEntryId: number;
  /**
   * The key to pass to anything external that accepts one:
   * `hyp-<conversationId>-<toolCallId>`, so a retry is recognized as one.
   */
  idempotencyKey: string;
  /** Fires when the conversation is cancelled or the tick loses its lease. */
  signal: AbortSignal;
  /** A database handle for reads. A tool never writes the transcript itself. */
  db: DbHandle;
}

/** A message a terminal tool posts to the conversation's channel. */
export interface Outbound {
  /** What it is: `reply`, `complete`, `fail`, `question`, or `error`. */
  kind: "reply" | "complete" | "fail" | "question" | "error";
  /** Markdown text. */
  text: string;
  /** Choices offered with a question. */
  options?: string[];
  /** A question's intent entry, which an answer button targets. */
  questionEntryId?: number;
}

/**
 * Where a terminal tool moves the conversation. The tick applies it in the
 * same transaction as the tool's result and its outbound message, so a
 * terminal tool's effect and its record are one commit.
 */
export type Transition =
  | { to: "hibernating"; outbound: Outbound }
  | {
      to: "ended";
      outcome: "completed" | "failed";
      outbound: Outbound;
    }
  | {
      to: "waiting";
      waitingOn: WaitingOn;
      outbound?: Outbound;
    }
  /** The call does not end the turn after all (a non-blocking escalation). */
  | { to: "working" };

/**
 * One tool. `inputSchema` is what the model is shown and what every call is
 * validated against before it runs; `outputSchema` documents and checks what
 * comes back.
 */
export interface ToolDefinition<I = unknown, O = unknown> {
  /** `snake_case`, model-facing. */
  name: string;
  /** What the model reads: when to call it, and what happens. */
  description: string;
  inputSchema: z.ZodType<I>;
  outputSchema: z.ZodType<O>;
  /** `safe` tools are re-run after a crash; `unsafe` ones are reported as interrupted. */
  replay: Replay;
  /** Whether it may run concurrently with the step's other parallel-safe calls. */
  parallelSafe: boolean;
  /**
   * Present only on the terminal tools: the transition a successful call makes.
   * @param output - What `run` returned.
   * @param input - What it was called with.
   * @param ctx - Where it ran.
   */
  terminal?: (output: O, input: I, ctx: ToolContext) => Transition;
  /**
   * Whether the bot may see this tool here (bot configuration, channel capabilities).
   * @param ctx - The bot and conversation.
   */
  available(
    ctx: Pick<ToolContext, "bot" | "conversation">,
  ): boolean | Promise<boolean>;
  /**
   * Present on tools whose calls may need a person's approval (`mcp_exec`):
   * decides, before `run`, whether the call runs, is refused, or waits. The
   * tick applies the outcome (`ApprovalOps` has the table); `run` is called
   * only for an outcome that runs.
   * @param input - The validated input.
   * @param ctx - Where it runs.
   */
  gate?: (input: I, ctx: ToolContext) => Promise<GateOutcome>;
  /**
   * Do the work. Throw a {@link ToolError} for a failure the model should read;
   * anything else thrown is reported as `tool_failed`. A tool with a
   * {@link ToolDefinition.resume} hook may instead return a
   * {@link Suspension}: the call waits for people, with no result yet.
   * @param input - The validated input.
   * @param ctx - Where it runs.
   */
  run(input: I, ctx: ToolContext): Promise<O | Suspension>;
  /**
   * Present on a tool whose call can stop partway for approvals and go on
   * later (`run_code`). Recovery calls it for the call's open intent instead
   * of reporting the call interrupted; it decides from its own records whether
   * to go on, wait again, or report the call interrupted.
   * @param input - The validated input.
   * @param ctx - Where it runs.
   */
  resume?: (input: I, ctx: ToolContext) => Promise<O | Suspension>;
}

/**
 * A call that stopped before its effect to wait for people: the approvals
 * it waits on, and those to write. The tick writes them and parks the
 * conversation on all of them in one transaction, with `onPark`'s writes in
 * it too; the call's intent stays open, with no result, until it goes on.
 */
export interface Suspension {
  suspended: true;
  /** Approvals already written that it still waits on. */
  approvalIds: number[];
  /** New approvals to write, bound to the call's intent. */
  drafts: ApprovalDraft[];
  /** The tool's own writes, in the parking transaction. */
  onPark?: (tx: TxHandle) => Promise<void>;
}

/**
 * Whether a tool's answer is a {@link Suspension}.
 * @param output - What `run` or `resume` returned.
 * @returns `true` for one.
 */
export function isSuspension(output: unknown): output is Suspension {
  return (
    typeof output === "object" &&
    output !== null &&
    (output as { suspended?: unknown }).suspended === true
  );
}

/** The error a model reads: data, never an exception. */
export interface ToolErrorEnvelope {
  is_error: true;
  error_type: string;
  message: string;
  next_action_hint: string;
}

/**
 * A failure a tool reports to the model. Its envelope says what went wrong and
 * what to do next, because the model is the reader of every error.
 */
export class ToolError extends Error {
  /**
   * @param errorType - A short machine-readable kind, e.g. `not_found`.
   * @param message - What went wrong.
   * @param nextActionHint - What the model should do about it.
   */
  constructor(
    public errorType: string,
    message: string,
    public nextActionHint: string,
  ) {
    super(message);
  }

  /** @returns The envelope stored as the call's result. */
  envelope(): ToolErrorEnvelope {
    return toolErrorEnvelope(this.errorType, this.message, this.nextActionHint);
  }
}

/**
 * Build an error envelope.
 * @param errorType - A short machine-readable kind.
 * @param message - What went wrong.
 * @param nextActionHint - What to do next.
 * @returns The envelope.
 */
export function toolErrorEnvelope(
  errorType: string,
  message: string,
  nextActionHint: string,
): ToolErrorEnvelope {
  return {
    is_error: true,
    error_type: errorType,
    message,
    next_action_hint: nextActionHint,
  };
}

/**
 * Whether a stored tool output is an error envelope.
 * @param output - A stored output.
 * @returns `true` for an envelope.
 */
export function isToolErrorEnvelope(
  output: unknown,
): output is ToolErrorEnvelope {
  return (
    typeof output === "object" &&
    output !== null &&
    (output as { is_error?: unknown }).is_error === true
  );
}
