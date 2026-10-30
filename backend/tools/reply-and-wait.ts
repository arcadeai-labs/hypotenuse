import { z } from "zod";
import type { ToolDefinition } from "./types";

const input = z.object({
  text: z
    .string()
    .min(1, "The reply needs text")
    .max(40_000)
    .describe("The reply, in markdown, exactly as the person should read it"),
});

const output = z.object({ posted: z.literal(true) });

/**
 * `reply_and_wait` — post a reply and end the turn. The conversation rests
 * (`hibernating`) until someone writes again.
 */
export const replyAndWait: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "reply_and_wait",
  description:
    "Post your reply to the conversation and end your turn. Use this whenever you have answered, or need the person to say more. The text is markdown and is shown exactly as written.",
  inputSchema: input,
  outputSchema: output,
  replay: "unsafe",
  parallelSafe: false,
  terminal: (_output, args) => ({
    to: "hibernating",
    outbound: { kind: "reply", text: args.text },
  }),
  available: () => true,
  run: async () => ({ posted: true as const }),
};
