import { beforeAll, describe, expect, test } from "bun:test";
import { type DaemonHome, until } from "../daemon/helpers";
import { itemsOf } from "../routing/helpers";
import { HOOK_TIMEOUT } from "../setup";
import { bodies, useE2E } from "./harness";

/**
 * Turns that end badly, end to end. An agent that refuses and an agent that
 * crashes mid-turn each leave the person a readable `error` in Linear — the
 * refusal in the agent's own words, the crash with its (redacted) stderr
 * tail — and neither keeps the runner's slot: with `max_parallel_jobs = 2`,
 * a third delegation after both failures is still claimed by the same runner
 * and answered.
 */

const e2e = useE2E();

let home: DaemonHome;
beforeAll(async () => {
  home = await e2e.daemon(e2e.universe.mario, "bad-day", {
    scenario: "refusal",
  });
}, HOOK_TIMEOUT);

/**
 * Delegate an issue and wait until its first turn has ended, and the person
 * can see how in Linear.
 * @param title - The issue's title.
 * @param typename - The content type the turn ends with in Linear.
 * @returns The session, its first turn, and the bodies of that kind.
 */
async function delegatedUntil(title: string, typename: string) {
  const { externalSessionId, agentSessionId } = await e2e.delegate(title);
  const view = await e2e.linearSession(
    externalSessionId,
    (s) => bodies(s, typename).length > 0,
  );
  const item = await until(async () => {
    const [first] = await itemsOf(agentSessionId);
    return first &&
      !["queued", "offered", "claimed", "running"].includes(first.status)
      ? first
      : null;
  });
  return { view, item, said: bodies(view, typename) };
}

describe("refusal and crash", () => {
  test("a refusal ends in an error quoting the agent", async () => {
    const { view, item, said } = await delegatedUntil(
      "Drop the production database",
      "AgentActivityErrorContent",
    );
    expect(said).toEqual([
      "The agent declined to continue: That would delete production data.",
    ]);
    expect(view.activities.at(-1)?.content.__typename).toBe(
      "AgentActivityErrorContent",
    );
    expect(item.status).toBe("failed");
    expect(item.runnerId).toBe(home.runner.id);
  }, 60_000);

  test("a crash mid-turn ends in an error with the redacted stderr tail", async () => {
    home = await e2e.restart(home, "crash");
    const { view, item, said } = await delegatedUntil(
      "Fall over",
      "AgentActivityErrorContent",
    );
    expect(said).toHaveLength(1);
    expect(said[0]).toStartWith("claude exited unexpectedly (code 1).");
    expect(said[0]).toContain("panic: out of cheese");
    expect(said[0]).toContain("key [redacted]");
    expect(said[0]).not.toContain("sk-abcdef");
    expect(view.activities.at(-1)?.content.__typename).toBe(
      "AgentActivityErrorContent",
    );
    expect(item.status).toBe("failed");
  }, 60_000);

  test("both slots are free again: the next delegation is claimed and answered", async () => {
    home = await e2e.restart(home, "happy");
    const { item, said } = await delegatedUntil(
      "Something that works",
      "AgentActivityResponseContent",
    );
    expect(item.status).toBe("completed");
    expect(item.runnerId).toBe(home.runner.id);
    expect(said).toHaveLength(1);
  }, 60_000);
});
