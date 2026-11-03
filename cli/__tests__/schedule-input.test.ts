import { describe, expect, test } from "bun:test";
import {
  renderSchedule,
  type Schedule,
  scheduleBody,
  targetText,
} from "../src/commands/schedule";

/**
 * The pure parts of `schedule`: how its flags become a request body, and how
 * a schedule reads for a person.
 */
describe("schedule flags", () => {
  test("map to the action's inputs, ids as numbers", () => {
    expect(
      scheduleBody({
        name: "Monday",
        target: "channel",
        channel: "12",
        cron: "0 9 * * 1",
        tz: "Europe/Berlin",
        guard: "only if new",
        catchUp: "none",
      }),
    ).toEqual({
      name: "Monday",
      targetType: "channel",
      channelId: 12,
      cron: "0 9 * * 1",
      timeZone: "Europe/Berlin",
      guard: "only if new",
      catchUp: "none",
    });
  });

  test("--no-guard clears the guard; a bad choice is refused naming the flag", () => {
    expect(scheduleBody({ guard: false })).toEqual({ guard: null });
    expect(() => scheduleBody({ target: "everywhere" })).toThrow("--target");
    expect(() => scheduleBody({ kind: "daily" })).toThrow("--kind");
    expect(() => scheduleBody({ catchUp: "all" })).toThrow("--catch-up");
  });
});

test("a schedule reads with its zone, state, and proposal", () => {
  const s: Schedule = {
    id: 3,
    botId: 1,
    name: "Moat check",
    kind: "instruction",
    targetType: "conversation",
    channelId: null,
    conversationId: 9,
    cron: "0 9 * * *",
    timeZone: "UTC",
    description: "Every day at 09:00",
    instruction: "Check the moat.",
    guard: null,
    catchUp: "latest",
    enabled: false,
    proposedByBot: true,
    nextRunAt: null,
    lastRunAt: null,
  };
  expect(targetText(s)).toBe("conversation #9");
  const text = renderSchedule(s);
  expect(text).toContain("proposed by the bot");
  expect(text).toContain("Every day at 09:00 (UTC)");
  expect(text).toContain("disabled");
});
