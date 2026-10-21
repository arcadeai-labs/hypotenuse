import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NOT_YOUR_WORK } from "@hypotenuse/protocol";
import { api } from "keryx";
import {
  DONE_FALLBACK_BODY,
  FAILED_FALLBACK_BODY,
  STOPPED_FALLBACK_BODY,
} from "../../ops/WorkItemOps";
import { useFinear } from "../linear/finear";
import { appToken, integrationRow } from "../linear/helpers";
import { activityRows, finearSession, settle } from "../linear/sessions";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import {
  delegatedSession,
  itemRow,
  itemsOf,
  personSays,
  ScriptedDaemon,
  withoutRunnerRateLimits,
} from "./helpers";

/**
 * `daemon:complete`: a turn ends, its slot frees, and the session is never
 * left hanging — when the turn wrote no `response`, `error`, or
 * `elicitation`, the server writes one. A queued follow-up starts at once;
 * repeating a completion is harmless; another runner's is refused.
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
let token: string;
let laptop: ScriptedDaemon;
let stranger: ScriptedDaemon;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  token = await appToken(universe.projectId);
  laptop = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    universe.projectId,
    "complete-laptop",
    { limits: { maxParallelJobs: 10 } },
  );
  await laptop.heartbeat();
  stranger = await ScriptedDaemon.register(
    universe.url,
    universe.luigi,
    universe.projectId,
    "complete-stranger",
  );
  await stranger.heartbeat({
    capabilities: { ...stranger.shape.capabilities, roles: [] },
  });
}, HOOK_TIMEOUT);

/**
 * Delegate an issue and have the laptop claim its first turn.
 * @param title - The issue's title.
 * @returns The session and the claimed item's id.
 */
async function claimed(title: string) {
  const started = await delegatedSession(linear, appUserId, title);
  const assignment = await laptop.claim();
  if (!assignment) throw new Error("nothing to claim");
  return { ...started, workItemId: assignment.workItemId };
}

/**
 * The last activity Linear holds for a session.
 * @param externalSessionId - Linear's id.
 * @returns Its type and body.
 */
async function lastInLinear(externalSessionId: string) {
  await settle();
  const finear = await finearSession(linear, token, externalSessionId);
  const last = finear.activities.at(-1);
  return [last?.content.__typename, last?.content.body];
}

describe("the hanging-session guarantee", () => {
  test("completed without an answer → the server says Done.", async () => {
    const { externalSessionId, workItemId } = await claimed("Silent success");
    await laptop.events(workItemId, [{ type: "thought", body: "Working" }]);
    const res = await laptop.complete(workItemId, "completed", {
      branch: "hypotenuse/eng-1-silent",
      acpSessionId: "sess_01",
    });
    expect(res).toEqual({ status: 200, body: { alreadyTerminal: false } });
    expect(await lastInLinear(externalSessionId)).toEqual([
      "AgentActivityResponseContent",
      DONE_FALLBACK_BODY,
    ]);
    const item = await itemRow(workItemId);
    expect(item.status).toBe("completed");
    expect(item.finishedAt).not.toBeNull();
    expect(item.outcome).toEqual({
      outcome: "completed",
      error: null,
      acpSessionId: "sess_01",
      branch: "hypotenuse/eng-1-silent",
    });
  });

  test("failed with an error → that error", async () => {
    const { externalSessionId, workItemId } = await claimed("Loud failure");
    await laptop.complete(workItemId, "failed", {
      error: "claude-code-acp exited with 137",
    });
    expect(await lastInLinear(externalSessionId)).toEqual([
      "AgentActivityErrorContent",
      "claude-code-acp exited with 137",
    ]);
    expect((await itemRow(workItemId)).status).toBe("failed");
  });

  test("failed without an error → the generic failure", async () => {
    const { externalSessionId, workItemId } = await claimed("Quiet failure");
    await laptop.complete(workItemId, "failed");
    expect(await lastInLinear(externalSessionId)).toEqual([
      "AgentActivityErrorContent",
      FAILED_FALLBACK_BODY,
    ]);
  });

  test("cancelled without an answer → Stopped.", async () => {
    const { externalSessionId, workItemId } = await claimed("Quiet cancel");
    await laptop.complete(workItemId, "cancelled");
    expect(await lastInLinear(externalSessionId)).toEqual([
      "AgentActivityResponseContent",
      STOPPED_FALLBACK_BODY,
    ]);
    expect((await itemRow(workItemId)).status).toBe("cancelled");
  });

  test("a turn that answered, even with an elicitation, gets nothing more", async () => {
    for (const answer of [
      { type: "response", body: "Here you go." },
      { type: "elicitation", body: "Which file?" },
      { type: "error", body: "Could not build." },
    ]) {
      const { session, workItemId } = await claimed(`Answered ${answer.type}`);
      await laptop.events(workItemId, [answer]);
      const before = (await activityRows(session.id)).length;
      await laptop.complete(
        workItemId,
        answer.type === "error" ? "failed" : "completed",
      );
      await settle();
      expect(await activityRows(session.id), answer.type).toHaveLength(before);
    }
  });
});

describe("after the turn", () => {
  test("a queued follow-up is offered as soon as the turn completes", async () => {
    const { externalSessionId, session, workItemId } =
      await claimed("Follow on");
    await laptop.events(workItemId, [{ type: "thought", body: "Busy" }]);
    await personSays(linear, externalSessionId, "And the docs");
    const [, followUp] = await itemsOf(session.id);
    expect(followUp.status).toBe("queued");

    await laptop.events(workItemId, [{ type: "response", body: "Done." }]);
    await laptop.complete(workItemId, "completed");
    await settle();
    expect((await itemRow(followUp.id)).status).toBe("offered");
    const beat = await laptop.heartbeat();
    expect(beat.offers.map((o) => o.workItemId)).toContain(followUp.id);
  });

  test("completing again is harmless; another runner's completion is refused", async () => {
    const { workItemId } = await claimed("Twice");
    const theirs = await stranger.complete(workItemId, "completed");
    expect(theirs.status).toBe(409);
    expect((theirs.body.error as { type: string }).type).toBe(NOT_YOUR_WORK);

    await laptop.events(workItemId, [{ type: "response", body: "Once." }]);
    expect((await laptop.complete(workItemId, "completed")).body).toEqual({
      alreadyTerminal: false,
    });
    expect((await laptop.complete(workItemId, "failed")).body).toEqual({
      alreadyTerminal: true,
    });
    expect((await itemRow(workItemId)).status).toBe("completed");

    const late = await stranger.complete(workItemId, "completed");
    expect(late.status).toBe(409);
  });
});
