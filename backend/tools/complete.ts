import { z } from "zod";
import type { ToolDefinition } from "./types";

const input = z.object({
  summary: z
    .string()
    .min(1, "Say what was done")
    .max(40_000)
    .describe("What was done, in markdown, for the person reading the result"),
});

const output = z.object({ completed: z.literal(true) });

/**
 * `complete` — post a final summary and close the conversation as completed.
 * A person who writes again starts a new turn.
 */
export const complete: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "complete",
  description:
    "Post a final summary and close the conversation as completed. Use this when the work asked for is done and nothing more is expected; use reply_and_wait instead if the person may answer.",
  inputSchema: input,
  outputSchema: output,
  replay: "unsafe",
  parallelSafe: false,
  terminal: (_output, args) => ({
    to: "ended",
    outcome: "completed",
    outbound: { kind: "complete", text: args.summary },
  }),
  available: () => true,
  run: async () => ({ completed: true as const }),
};
