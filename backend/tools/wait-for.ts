import { z } from "zod";
import { type ToolDefinition, ToolError } from "./types";

/** The longest a conversation may sleep; longer pauses are schedules. */
export const MAX_WAIT_SECONDS = 7 * 24 * 60 * 60;

const input = z.object({
  at: z
    .string()
    .optional()
    .describe("When to wake, as an ISO 8601 timestamp. Give this or seconds"),
  seconds: z
    .number()
    .int()
    .positive()
    .max(MAX_WAIT_SECONDS)
    .optional()
    .describe(
      "How long to sleep, in seconds (at most 7 days). Give this or at",
    ),
  note: z
    .string()
    .max(2_000)
    .optional()
    .describe("Why you are waiting, for whoever reads the transcript"),
});

const output = z.object({
  until: z.string(),
  note: z.string().nullable(),
});

/**
 * `wait_for` — sleep until a time, then carry on with the same turn. Replay
 * safe: deciding to wait changes nothing outside the conversation.
 */
export const waitFor: ToolDefinition<
  z.infer<typeof input>,
  z.infer<typeof output>
> = {
  name: "wait_for",
  description:
    "Pause this conversation until a time (at, ISO 8601) or for a number of seconds (at most 7 days), then continue where you left off. Messages that arrive meanwhile are delivered when you wake.",
  inputSchema: input,
  outputSchema: output,
  replay: "safe",
  parallelSafe: false,
  terminal: (out) => ({
    to: "waiting",
    waitingOn: { kind: "timer", at: Date.parse(out.until) },
  }),
  available: () => true,
  run: async (args) => {
    const now = Date.now();
    let until: number;
    if (args.at !== undefined && args.seconds !== undefined) {
      throw new ToolError(
        "invalid_input",
        "Give either at or seconds, not both.",
        "Call wait_for again with only one of them.",
      );
    }
    if (args.at !== undefined) {
      until = Date.parse(args.at);
      if (Number.isNaN(until)) {
        throw new ToolError(
          "invalid_input",
          `"${args.at}" is not an ISO 8601 timestamp.`,
          "Call wait_for again with at like 2026-01-31T09:00:00Z, or use seconds.",
        );
      }
      if (until <= now) {
        throw new ToolError(
          "invalid_input",
          `${args.at} is already in the past.`,
          "Carry on now, or choose a time in the future.",
        );
      }
      if (until - now > MAX_WAIT_SECONDS * 1000) {
        throw new ToolError(
          "invalid_input",
          "wait_for sleeps at most 7 days.",
          "Choose a time within 7 days.",
        );
      }
    } else if (args.seconds !== undefined) {
      until = now + args.seconds * 1000;
    } else {
      throw new ToolError(
        "invalid_input",
        "wait_for needs at or seconds.",
        "Call wait_for again with one of them.",
      );
    }
    return { until: new Date(until).toISOString(), note: args.note ?? null };
  },
};
