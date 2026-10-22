import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { delegatedSession, itemsOf } from "../routing/helpers";
import {
  buildTestUniverse,
  HOOK_TIMEOUT,
  runAction,
  type TestUniverse,
} from "../setup";
import { useFinear } from "./finear";
import { integrationRow } from "./helpers";

/**
 * Linear asks integrations not to poll: changes arrive as webhooks. Every
 * clock the server runs is a candidate poller, so each one is run, more than
 * once, over a workspace with live state — a session waiting for a runner and
 * its delivered activities — and finear must hear nothing from any of them.
 * A clock that talks to Linear does so only for work a webhook or a person
 * started (an activity to send, a token about to expire, a notification
 * marked for a second look), never to ask what changed.
 */

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

let appUserId: string;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
}, HOOK_TIMEOUT);

/**
 * Every action that runs on a schedule.
 * @returns Their names.
 */
function clocks(): string[] {
  return api.actions.actions
    .filter((a) => (a.task?.frequency ?? 0) > 0)
    .map((a) => a.name)
    .sort();
}

describe("no polling", () => {
  test("LC-RATE-05 no clock asks Linear anything when nothing new has happened", async () => {
    const { session } = await delegatedSession(
      linear,
      appUserId,
      "Waiting for a runner",
    );
    expect((await itemsOf(session.id)).map((i) => i.status)).toEqual([
      "queued",
    ]);
    // Everything the delegation itself needed has been sent.
    for (const name of clocks()) await runAction(name);
    // The recorder sees what the server sends: the acknowledgement went out.
    expect(
      linear.requests().some((r) => r.operationName === "CreateAgentActivity"),
    ).toBe(true);
    linear.clearRequests();

    expect(clocks()).toContain("work:route");
    for (let round = 0; round < 3; round++) {
      for (const name of clocks()) await runAction(name);
    }
    expect(
      linear
        .requests()
        .filter((r) => r.path === "/graphql")
        .map((r) => r.operationName),
    ).toEqual([]);
  });
});
