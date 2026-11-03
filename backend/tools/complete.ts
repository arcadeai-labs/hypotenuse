import { z } from "zod";
import { inScheduledTurn } from "../ops/ScheduleRunOps";
import { type ToolDefinition, ToolError } from "./types";

const input = z.object({
  summary: z
    .string()
    .max(40_000)
    .optional()
    .describe(
      "What was done, in markdown, for the person reading the result. Required unless silent",
    ),
  silent: z
    .boolean()
    .optional()
    .describe(
      "Only in a turn a schedule started: true ends it with nothing posted, because there was nothing worth saying",
    ),
});

const output = z.object({
  completed: z.literal(true),
  silent: z.boolean(),
});

/**
 * `complete` — post a final summary and close the conversation as completed.
 * A person who writes again starts a new turn. In a turn a schedule started,
 * `silent: true` closes it with nothing posted — a legitimate outcome the
 * schedule's run records as `silent`.
 */
export const complete: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "complete",
  description:
    "Post a final summary and close the conversation as completed. Use this when the work asked for is done and nothing more is expected; use reply_and_wait instead if the person may answer. In a turn a schedule started, call it with silent: true (and no summary) when there is nothing worth saying: nothing is posted.",
  inputSchema: input,
  outputSchema: output,
  replay: "unsafe",
  parallelSafe: false,
  terminal: (out, args) =>
    out.silent
      ? { to: "ended", outcome: "completed" }
      : {
          to: "ended",
          outcome: "completed",
          outbound: { kind: "complete", text: args.summary ?? "" },
        },
  available: () => true,
  run: async (args, ctx) => {
    if (args.silent) {
      if (!(await inScheduledTurn(ctx.db, ctx.conversation.id))) {
        throw new ToolError(
          "not_scheduled",
          "Only a turn a schedule started may end silently; a person is waiting for an answer here.",
          "Call complete with a summary, or reply_and_wait.",
        );
      }
      return { completed: true as const, silent: true };
    }
    if (!args.summary?.trim()) {
      throw new ToolError(
        "summary_required",
        "Say what was done.",
        "Call complete again with a summary.",
      );
    }
    return { completed: true as const, silent: false };
  },
};
