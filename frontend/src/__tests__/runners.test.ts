import { describe, expect, test } from "bun:test";
import {
  availableAgents,
  capacityLabel,
  isRunnersPayload,
  presenceOf,
  runnersChannel,
} from "../utils/runners";

describe("runners page helpers", () => {
  test("the channel is the project's runners channel", () => {
    expect(runnersChannel(7)).toBe("project:7:runners");
  });

  test("only the runners frame triggers a re-read", () => {
    expect(isRunnersPayload({ event: "runners" })).toBe(true);
    expect(isRunnersPayload({ event: "notifications" })).toBe(false);
    expect(isRunnersPayload("runners")).toBe(false);
    expect(isRunnersPayload(null)).toBe(false);
  });

  test("presence follows status, and revoked draws offline", () => {
    expect(presenceOf("online")).toBe("online");
    expect(presenceOf("draining")).toBe("draining");
    expect(presenceOf("offline")).toBe("offline");
    expect(presenceOf("revoked")).toBe("offline");
  });

  test("capacity is used/total, or a dash before the first heartbeat", () => {
    expect(
      capacityLabel({ activeCount: 1, limits: { maxParallelJobs: 3 } }),
    ).toBe("1/3");
    expect(capacityLabel({ activeCount: 0, limits: null })).toBe("—");
  });

  test("only available agents are listed", () => {
    expect(
      availableAgents({
        agents: [
          { id: "claude", preset: "claude", available: true },
          { id: "codex", preset: "codex", available: false },
        ],
      }),
    ).toEqual(["claude"]);
  });
});
