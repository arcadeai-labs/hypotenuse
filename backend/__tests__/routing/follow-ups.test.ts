import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { QUEUED_BEHIND_BODY } from "../../ops/WorkItemOps";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import { activityRows } from "../linear/sessions";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import {
  delegatedSession,
  itemsOf,
  personSays,
  route,
  ScriptedDaemon,
  withoutRunnerRateLimits,
} from "./helpers";

/**
 * Follow-ups: what a person types while a turn runs is queued behind it —
 * merged into one turn when they type twice — and they are told so; the next
 * turn carries every message in order. A role prefix mid-session does not
 * switch roles.
 */

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();
withoutRunnerRateLimits();

let appUserId: string;
let laptop: ScriptedDaemon;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  laptop = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    universe.projectId,
    "follow-laptop",
    { limits: { maxParallelJobs: 5 } },
  );
  await laptop.heartbeat();
}, HOOK_TIMEOUT);

/**
 * The bodies of a session's outbound thoughts, in order.
 * @param agentSessionId - The session.
 * @returns The bodies.
 */
async function thoughts(agentSessionId: number): Promise<string[]> {
  return (await activityRows(agentSessionId))
    .filter((r) => r.direction === "outbound" && r.contentType === "thought")
    .map((r) => (r.content as { body: string }).body);
}

describe("follow-ups", () => {
  test("LC-BP-10 two prompts during a running turn are one queued turn, read next", async () => {
    const { externalSessionId, session } = await delegatedSession(
      linear,
      appUserId,
      "Busy agent",
    );
    const first = await laptop.claim();
    await laptop.events(first!.workItemId, [
      { type: "thought", body: "Working on it" },
    ]);

    await personSays(linear, externalSessionId, "Also the README");
    await personSays(linear, externalSessionId, "And the changelog");

    const items = await itemsOf(session.id);
    expect(items.map((i) => [i.kind, i.status])).toEqual([
      ["session_created", "running"],
      ["prompt", "queued"],
    ]);
    const inbound = (await activityRows(session.id)).filter(
      (r) => r.direction === "inbound",
    );
    expect(items[1].prompt).toEqual([
      { activityId: inbound[0].id, body: "Also the README" },
      { activityId: inbound[1].id, body: "And the changelog" },
    ]);
    expect(
      (await thoughts(session.id)).filter((b) => b === QUEUED_BEHIND_BODY),
    ).toHaveLength(2);

    // Nothing is offered while the turn runs.
    expect((await laptop.heartbeat()).offers).toEqual([]);

    await laptop.events(first!.workItemId, [
      { type: "response", body: "README done." },
    ]);
    await laptop.complete(first!.workItemId, "completed");
    await route();
    await laptop.heartbeat();
    const next = await laptop.claim();
    expect(next).toMatchObject({
      workItemId: items[1].id,
      kind: "prompt",
      fresh: false,
      prompt: [
        { activityId: inbound[0].id, body: "Also the README" },
        { activityId: inbound[1].id, body: "And the changelog" },
      ],
    });
  });

  test("a role prefix mid-session keeps the role, says so, and is stripped", async () => {
    const { externalSessionId, session } = await delegatedSession(
      linear,
      appUserId,
      "Stays a worker",
    );
    const first = await laptop.claim();
    await laptop.events(first!.workItemId, [
      { type: "response", body: "First pass done." },
    ]);
    await laptop.complete(first!.workItemId, "completed");

    await personSays(linear, externalSessionId, "/manage plan the rest");
    const said = await thoughts(session.id);
    expect(said.at(-1)).toContain("stays a **worker** session");
    expect(said.at(-1)).toContain("/manage");
    const [, followUp] = await itemsOf(session.id);
    expect(followUp.role).toBe("worker");
    expect(followUp.prompt?.map((p) => p.body)).toEqual(["plan the rest"]);
  });
});
