import { config } from "keryx";
import { z } from "zod";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/platforms";
import { HelpCapReached, raiseHelpRequest } from "../ops/HelpOps";
import { type ToolDefinition, ToolError } from "./types";
import { MAX_WAIT_SECONDS } from "./wait-for";

const input = z.object({
  question: z
    .string()
    .min(1, "Ask something")
    .max(4_000)
    .describe("What you need a person on the team to tell you"),
  context: z
    .string()
    .max(10_000)
    .optional()
    .describe(
      "What they need to know to answer: what you tried, what you found",
    ),
  urgency: z
    .enum(["low", "normal", "high"])
    .optional()
    .describe("How soon someone should look (default normal)"),
  blocking: z
    .boolean()
    .optional()
    .describe(
      "true (the default): wait for the answer before going on; false: carry on, and the answer arrives later as a message",
    ),
  timeoutSeconds: z
    .number()
    .int()
    .positive()
    .max(MAX_WAIT_SECONDS)
    .optional()
    .describe("How long to wait for an answer (default a day, at most 7 days)"),
});

const output = z.object({
  helpRequestId: z.number(),
  note: z.string(),
});

/**
 * `escalate_to_human` — ask the project's people, outside the channel. The
 * channel hears only that a person was asked. A blocking request ends the
 * turn on `waiting` / `answer`; a non-blocking one lets it go on.
 */
export const escalateToHuman: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "escalate_to_human",
  description:
    'Ask a person on your team for help when nobody in this conversation can answer: a decision only staff can make, access you lack, something you must not guess. They are notified in the dashboard and by email; the channel is told only that you asked someone. Blocking (the default) waits for the answer, which arrives as a message starting "Answer from"; if nobody answers by the timeout you are told so and should carry on. Do not use it for questions the person you are talking to can answer: ask them.',
  inputSchema: input,
  outputSchema: output,
  replay: "unsafe",
  parallelSafe: false,
  terminal: (_out, args, ctx) =>
    args.blocking === false
      ? { to: "working" }
      : {
          to: "waiting",
          waitingOn: {
            kind: "answer",
            questionEntryId: ctx.intentEntryId,
            timeoutAt: null,
          },
        },
  available: () => true,
  async run(args, ctx) {
    try {
      const request = await raiseHelpRequest(
        ctx.conversation.id,
        ctx.intentEntryId,
        {
          question: args.question,
          context: args.context ?? "",
          urgency: args.urgency ?? "normal",
          blocking: args.blocking !== false,
          timeoutSeconds:
            args.timeoutSeconds ?? config.platforms.helpDefaultTimeoutSeconds,
        },
      );
      return {
        helpRequestId: request.id,
        note:
          args.blocking === false
            ? "A person was asked. Carry on; their answer arrives later as a message."
            : "A person was asked. Their answer arrives as your next message.",
      };
    } catch (e) {
      if (e instanceof HelpCapReached) {
        throw new ToolError(
          "help_cap_reached",
          e.message,
          "Do not ask again. Tell the person what you could not resolve, and end your turn.",
        );
      }
      throw e;
    }
  },
};
