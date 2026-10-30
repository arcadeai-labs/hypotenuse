import { z } from "zod";
import type { ToolDefinition } from "./types";

const input = z.object({
  reason: z
    .string()
    .min(1, "Say why")
    .max(40_000)
    .describe(
      "Why the work cannot be done, and what the person could do about it, in markdown",
    ),
});

const output = z.object({ failed: z.literal(true) });

/**
 * `fail` — post a reason the person can act on and close the conversation as
 * failed.
 */
export const fail: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "fail",
  description:
    "Close the conversation as failed, posting a reason the person can act on. Use this only when you cannot do what was asked; say what would let it succeed.",
  inputSchema: input,
  outputSchema: output,
  replay: "unsafe",
  parallelSafe: false,
  terminal: (_output, args) => ({
    to: "ended",
    outcome: "failed",
    outbound: { kind: "fail", text: args.reason },
  }),
  available: () => true,
  run: async () => ({ failed: true as const }),
};
