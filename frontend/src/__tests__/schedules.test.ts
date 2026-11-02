import { describe, expect, test } from "bun:test";
import { findBotSection } from "../components/bots/sections";
import {
  formatSlot,
  RUN_STATUS_LABELS,
  runTone,
  scheduleBody,
  targetSummary,
} from "../utils/schedules";

describe("a schedule's draft as the API takes it", () => {
  const draft = {
    name: "  Monday summary ",
    kind: "instruction",
    targetType: "channel",
    channelId: "12",
    conversationId: "99",
    cron: " 0 9 * * 1 ",
    timeZone: "",
    instruction: " Summarize. ",
    guard: "  ",
    catchUp: "latest",
  };

  test("trims, defaults the zone, sends only the target's own id, and an empty guard as none", () => {
    expect(scheduleBody(draft)).toEqual({
      name: "Monday summary",
      kind: "instruction",
      targetType: "channel",
      channelId: 12,
      cron: "0 9 * * 1",
      timeZone: "UTC",
      instruction: "Summarize.",
      guard: null,
      catchUp: "latest",
    });
  });

  test("a conversation target sends its conversation, a none target neither", () => {
    expect(
      scheduleBody({ ...draft, targetType: "conversation" }),
    ).toMatchObject({ conversationId: 99 });
    const none = scheduleBody({ ...draft, targetType: "none" });
    expect(none).not.toHaveProperty("channelId");
    expect(none).not.toHaveProperty("conversationId");
  });
});

describe("what a run says happened", () => {
  test("every status has a label and a tone", () => {
    for (const status of [
      "pending",
      "guarding",
      "skipped",
      "woken",
      "silent",
      "posted",
      "failed",
    ]) {
      expect(RUN_STATUS_LABELS[status]).toBeDefined();
    }
    expect(runTone("posted")).toBe("complete");
    expect(runTone("silent")).toBe("idle");
    expect(runTone("skipped")).toBe("idle");
    expect(runTone("failed")).toBe("error");
    expect(runTone("woken")).toBe("active");
  });

  test("a target in words", () => {
    expect(
      targetSummary(
        { targetType: "channel", channelId: 1, conversationId: null },
        "general",
      ),
    ).toBe("New conversation in #general");
    expect(
      targetSummary({
        targetType: "conversation",
        channelId: null,
        conversationId: 7,
      }),
    ).toBe("Turn in conversation #7");
    expect(
      targetSummary({
        targetType: "none",
        channelId: null,
        conversationId: null,
      }),
    ).toBe("Nothing posted");
  });

  test("a slot is shown in the zone asked for", () => {
    const slot = Date.UTC(2026, 10, 9, 14, 0);
    expect(formatSlot(slot, "America/New_York")).toContain("09:00");
    expect(formatSlot(slot, "UTC")).toContain("14:00");
  });
});

test("the bot page has a Schedules section under Behavior", () => {
  expect(findBotSection("schedules")?.group).toBe("Behavior");
});
