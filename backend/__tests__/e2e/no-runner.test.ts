import { describe, expect, test } from "bun:test";
import { until } from "../daemon/helpers";
import { ago, itemsOf, setItem } from "../routing/helpers";
import { bodies, useE2E } from "./harness";

/**
 * A delegation in a project with no runner at all, end to end: the person is
 * acknowledged at once, then told the turn is waiting and why; and when the
 * project's queue timeout passes (moved by writing `queuedAt`, not waited
 * out) routing expires the turn with an `error` naming the reason. The
 * session is never left looking unresponsive, and never silently dropped.
 */

const e2e = useE2E();

describe("no runner", () => {
  test("acknowledged, waiting with a reason, then an error when the queue times out", async () => {
    const { externalSessionId, agentSessionId, issue } =
      await e2e.delegate("Nobody home");

    const waiting = await e2e.linearSession(externalSessionId, (s) =>
      bodies(s, "AgentActivityThoughtContent").some((b) =>
        b.startsWith("Waiting for a runner:"),
      ),
    );
    const thoughts = bodies(waiting, "AgentActivityThoughtContent");
    expect(thoughts[0]).toBe(
      `On it — finding a runner for ${issue.identifier}.`,
    );
    expect(thoughts.find((b) => b.startsWith("Waiting for a runner:"))).toBe(
      "Waiting for a runner: No runner in this project takes worker work to ENG.",
    );
    const [item] = await itemsOf(agentSessionId);
    expect(item.status).toBe("queued");

    // The project's queue timeout (30 minutes by default) has passed.
    await setItem(item.id, { queuedAt: ago(31 * 60_000) });
    const ended = await e2e.linearSession(
      externalSessionId,
      (s) => bodies(s, "AgentActivityErrorContent").length > 0,
    );
    expect(bodies(ended, "AgentActivityErrorContent")).toEqual([
      "No runner took this within 30 minutes. No runner in this project takes worker work to ENG.",
    ]);
    expect(ended.activities.at(-1)?.content.__typename).toBe(
      "AgentActivityErrorContent",
    );
    expect(ended.status).toBe("error");
    const [expired] = await until(async () => {
      const items = await itemsOf(agentSessionId);
      return items[0]?.status === "expired" ? items : null;
    });
    expect(expired.id).toBe(item.id);
  }, 60_000);
});
