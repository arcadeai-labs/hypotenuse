import { describe, expect, test } from "bun:test";
import {
  availableAgents,
  capacityLabel,
  capacitySegments,
  groupByOwner,
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

describe("runner fleet helpers", () => {
  const base = {
    limits: { maxParallelJobs: 3 },
    activeCount: 1,
    status: "online",
  };

  test("one segment per slot; held sessions first, linked to their pages", () => {
    const segments = capacitySegments(base as never, [
      { id: 9, issueIdentifier: "ENG-1" },
    ]);
    expect(segments.map((s) => s.state)).toEqual(["busy", "free", "free"]);
    expect(segments[0]).toMatchObject({ label: "ENG-1", href: "/sessions/9" });
  });

  test("a runner gone offline holding work turns its slots stale", () => {
    const segments = capacitySegments({ ...base, status: "offline" } as never, [
      { id: 9, issueIdentifier: null },
    ]);
    expect(segments[0]).toMatchObject({ state: "stale", label: "#9" });
  });

  test("never fewer segments than held sessions, even without limits", () => {
    expect(
      capacitySegments(
        { limits: null, activeCount: 0, status: "online" } as never,
        [{ id: 1, issueIdentifier: "A-1" }],
      ),
    ).toHaveLength(1);
  });

  test("runners group by owner, owners sorted by name", () => {
    const r = (id: number, owner: string | null) =>
      ({ id, owner: owner ? { name: owner } : null }) as never;
    expect(
      groupByOwner([r(1, "Zed"), r(2, "Amy"), r(3, "Zed"), r(4, null)]).map(
        ([owner, list]) => [owner, (list as { id: number }[]).map((x) => x.id)],
      ),
    ).toEqual([
      ["Amy", [2]],
      ["Unknown owner", [4]],
      ["Zed", [1, 3]],
    ]);
  });
});
