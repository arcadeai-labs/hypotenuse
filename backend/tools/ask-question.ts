import { z } from "zod";
import type { ToolDefinition } from "./types";
import { MAX_WAIT_SECONDS } from "./wait-for";

const input = z.object({
  question: z
    .string()
    .min(1, "Ask something")
    .max(10_000)
    .describe("The question, in markdown"),
  options: z
    .array(z.string().min(1).max(200))
    .max(10)
    .optional()
    .describe("Choices to offer, if the answer is one of a few"),
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(MAX_WAIT_SECONDS)
    .optional()
    .describe(
      "How long to wait for an answer (at most 7 days). Without it you wait until someone answers",
    ),
});

const output = z.object({
  asked: z.literal(true),
  note: z.string(),
});

/**
 * `ask_question` — post a question and wait for the answer, which is the next
 * message in the conversation. The turn continues when it arrives.
 */
export const askQuestion: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "ask_question",
  description:
    "Ask the person a question and wait for the answer; your turn continues when it arrives as their next message. Offer options when the answer is one of a few. With timeoutSeconds, you are told if nobody answers in time.",
  inputSchema: input,
  outputSchema: output,
  replay: "unsafe",
  parallelSafe: false,
  terminal: (_output, args, ctx) => ({
    to: "waiting",
    waitingOn: {
      kind: "answer",
      questionEntryId: ctx.intentEntryId,
      timeoutAt: args.timeoutSeconds
        ? Date.now() + args.timeoutSeconds * 1000
        : null,
    },
    outbound: {
      kind: "question",
      text: args.question,
      ...(args.options?.length ? { options: args.options } : {}),
    },
  }),
  available: () => true,
  run: async () => ({
    asked: true as const,
    note: "The question is posted. The answer arrives as the next message.",
  }),
};
