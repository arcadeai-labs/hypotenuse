import { z } from "zod";

/** How a turn ended, as the daemon reports it. */
export const COMPLETE_OUTCOMES = ["completed", "failed", "cancelled"] as const;

/** `daemon:complete`'s body. */
export const CompleteRequest = z.strictObject({
  workItemId: z.number().int().positive(),
  outcome: z.enum(COMPLETE_OUTCOMES),
  error: z.string().max(4096).nullable().optional(),
  acpSessionId: z.string().max(255).nullable().optional(),
  branch: z.string().max(255).nullable().optional(),
  answersConsumed: z
    .array(z.number().int().positive())
    .max(100)
    .optional()
    .describe(
      "The activity ids of delivered answers the turn took as answers; any other answer becomes the session's next prompt",
    ),
});
export type CompleteRequest = z.infer<typeof CompleteRequest>;

/** `daemon:complete`'s answer. Repeating a completion is harmless. */
export const CompleteResponse = z.looseObject({
  alreadyTerminal: z.boolean(),
});
export type CompleteResponse = z.infer<typeof CompleteResponse>;
