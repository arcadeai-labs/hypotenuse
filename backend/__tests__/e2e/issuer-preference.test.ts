import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DaemonHome } from "../daemon/helpers";
import { signed } from "../daemon/helpers";
import { itemsOf } from "../routing/helpers";
import {
  createUserAndLogin,
  HOOK_TIMEOUT,
  inviteAndAccept,
  TEST_PASSWORD,
  type TestUser,
} from "../setup";
import { bodies, useE2E } from "./harness";

/**
 * Issuer preference across real daemons: two runners are equally eligible
 * and equally idle, and the one registered first would win a tie. The person
 * who delegates in Linear (finear's Human 1) is matched to a Hypotenuse user
 * by e-mail, and that user's runner — registered second — takes the turn and
 * answers it, while the other runner never starts an agent.
 */

const e2e = useE2E();

let human: TestUser;
let stranger: DaemonHome;
let mine: DaemonHome;
beforeAll(async () => {
  const { universe } = e2e;
  // The same e-mail as finear's Human 1, who starts every delegation.
  human = await createUserAndLogin(
    universe.url,
    "Human One",
    "human1@example.test",
    TEST_PASSWORD,
  );
  await inviteAndAccept(
    universe.url,
    universe.peach,
    universe.projectId,
    human,
    [],
  );
  // Registered first: without a preference the lower id wins the tie.
  stranger = await e2e.daemon(universe.mario, "mario-laptop");
  mine = await e2e.daemon(human, "human-laptop");
}, HOOK_TIMEOUT);

describe("issuer preference", () => {
  test("the delegating person's own runner takes the turn", async () => {
    expect(stranger.runner.id).toBeLessThan(mine.runner.id);
    const { externalSessionId, agentSessionId, issue } =
      await e2e.delegate("Mine, please");
    const view = await e2e.linearSession(
      externalSessionId,
      (s) => s.status === "complete",
    );
    expect(bodies(view, "AgentActivityResponseContent")).toEqual([
      signed("Fixed the rounding in `src/a.ts`.", "human-laptop"),
    ]);
    const [item] = await itemsOf(agentSessionId);
    expect(item).toMatchObject({
      status: "completed",
      preferredUserId: human.userId,
      runnerId: mine.runner.id,
    });
    expect(
      existsSync(join(mine.root, "worktrees", "web", issue.identifier)),
    ).toBe(true);
    // The other runner never started an agent for it.
    expect(stranger.received()).toEqual([]);
  }, 60_000);
});
