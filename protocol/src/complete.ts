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
});
export type CompleteRequest = z.infer<typeof CompleteRequest>;

/** `daemon:complete`'s answer. Repeating a completion is harmless. */
export const CompleteResponse = z.looseObject({
  alreadyTerminal: z.boolean(),
});
export type CompleteResponse = z.infer<typeof CompleteResponse>;
