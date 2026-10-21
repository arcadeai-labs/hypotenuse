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
  reap,
  ScriptedDaemon,
  setItem,
  withoutRunnerRateLimits,
} from "./helpers";

/**
 * A question mid-turn is answered in the turn. A held turn that posts an
 * `elicitation` keeps running; the person's next follow-up is delivered to it
 * by heartbeat as an answer, not queued behind it. What the daemon reports it
 * did not take as an answer becomes the session's next prompt when the turn
 * ends — and a stopped turn takes its unread answers with it.
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
    "answer-laptop",
    { limits: { maxParallelJobs: 5 } },
  );
  await laptop.heartbeat();
}, HOOK_TIMEOUT);

const ask = {
  type: "elicitation",
  body: "The agent wants to run `rm -rf build/`. Allow it?",
  signal: "select",
  signalMetadata: {
    options: [
      { label: "Allow", value: "yes" },
      { label: "Reject", value: "no" },
    ],
  },
};

/**
 * A session whose turn is held by the laptop and waiting on a question.
 * @param title - The issue title.
 * @returns The session, Linear's id, and the held item's id.
 */
async function waitingTurn(title: string) {
  const { externalSessionId, session } = await delegatedSession(
    linear,
    appUserId,
    title,
  );
  const [first] = await itemsOf(session.id);
  const claimed = await laptop.claim([first.id]);
  await laptop.events(claimed!.workItemId, [ask]);
  return { externalSessionId, session, workItemId: claimed!.workItemId };
}

describe("answers", () => {
  test("LC-SIG-03 a reply to a mid-turn select is delivered to the turn, not queued", async () => {
    const { externalSessionId, session, workItemId } =
      await waitingTurn("Ask first");
    const [held] = await itemsOf(session.id);
    expect(held.awaitingAnswerSince).not.toBeNull();

    await personSays(linear, externalSessionId, "yes");
    const items = await itemsOf(session.id);
    expect(items).toHaveLength(1);
    const inbound = (await activityRows(session.id)).filter(
      (r) => r.direction === "inbound",
    );
    expect(items[0].answers).toEqual([
      { activityId: inbound[0].id, body: "yes" },
    ]);
    expect(items[0].awaitingAnswerSince).toBeNull();
    // Not told it is queued: it is being read now.
    const thoughts = (await activityRows(session.id)).filter(
      (r) =>
        r.direction === "outbound" &&
        (r.content as { body?: string }).body === QUEUED_BEHIND_BODY,
    );
    expect(thoughts).toEqual([]);

    // Every heartbeat carries it until the turn ends.
    for (let i = 0; i < 2; i++) {
      const beat = await laptop.heartbeat();
      expect(beat.answers).toEqual([
        { workItemId, activityId: inbound[0].id, body: "yes" },
      ]);
    }

    await laptop.events(workItemId, [{ type: "response", body: "Removed." }]);
    await laptop.complete(workItemId, "completed", {
      answersConsumed: [inbound[0].id],
    });
    expect((await itemsOf(session.id)).map((i) => i.status)).toEqual([
      "completed",
    ]);
    expect(
      (await laptop.heartbeat()).answers.filter(
        (a) => a.workItemId === workItemId,
      ),
    ).toEqual([]);
  });

  test("LC-SIG-05 a reply the turn did not take becomes the next prompt", async () => {
    const { externalSessionId, session, workItemId } =
      await waitingTurn("Free text");
    await personSays(linear, externalSessionId, "run the tests instead");
    const [inbound] = (await activityRows(session.id)).filter(
      (r) => r.direction === "inbound",
    );
    await laptop.events(workItemId, [
      { type: "response", body: "I did not remove build/." },
    ]);
    await laptop.complete(workItemId, "completed");
    const items = await itemsOf(session.id);
    expect(items.map((i) => [i.kind, i.status])).toEqual([
      ["session_created", "completed"],
      ["prompt", "queued"],
    ]);
    expect(items[1].prompt).toEqual([
      { activityId: inbound.id, body: "run the tests instead" },
    ]);
  });

  test("a second reply while the first is unread queues as a follow-up", async () => {
    const { externalSessionId, session } = await waitingTurn("Two replies");
    await personSays(linear, externalSessionId, "yes");
    await personSays(linear, externalSessionId, "and then the docs");
    const items = await itemsOf(session.id);
    expect(items.map((i) => [i.kind, i.status])).toEqual([
      ["session_created", "running"],
      ["prompt", "queued"],
    ]);
    expect(items[0].answers.map((a) => a.body)).toEqual(["yes"]);
    expect(items[1].prompt?.map((p) => p.body)).toEqual(["and then the docs"]);
  });

  test("an unread answer joins a queued follow-up in the order it was sent", async () => {
    const { externalSessionId, session, workItemId } =
      await waitingTurn("Unread, then more");
    await personSays(linear, externalSessionId, "run the tests first");
    await personSays(linear, externalSessionId, "and then the docs");
    await laptop.events(workItemId, [
      { type: "response", body: "I did not remove build/." },
    ]);
    await laptop.complete(workItemId, "completed");
    const items = await itemsOf(session.id);
    expect(items.map((i) => [i.kind, i.status])).toEqual([
      ["session_created", "completed"],
      ["prompt", "queued"],
    ]);
    expect(items[1].prompt?.map((p) => p.body)).toEqual([
      "run the tests first",
      "and then the docs",
    ]);
  });

  test("a stop while waiting cancels the turn and drops its unread answers", async () => {
    const { externalSessionId, session, workItemId } =
      await waitingTurn("Stop waiting");
    await personSays(linear, externalSessionId, "hmm, let me think");
    await personSays(linear, externalSessionId, "Stop", "stop");
    const beat = await laptop.heartbeat();
    expect(beat.cancels).toContainEqual({ workItemId, reason: "stop" });
    expect(beat.answers.filter((a) => a.workItemId === workItemId)).toEqual([]);
    await laptop.events(workItemId, [
      { type: "response", body: "Stopped at your request." },
    ]);
    await laptop.complete(workItemId, "cancelled");
    expect((await itemsOf(session.id)).map((i) => i.status)).toEqual([
      "cancelled",
    ]);
  });

  test("a turn lost while waiting requeues itself, its answers as a prompt behind it", async () => {
    const { externalSessionId, session, workItemId } =
      await waitingTurn("Lost while waiting");
    await personSays(linear, externalSessionId, "yes");
    await setItem(workItemId, { leaseExpiresAt: new Date(Date.now() - 1_000) });
    expect((await reap()).requeued).toContain(workItemId);
    const items = await itemsOf(session.id);
    expect(
      items.map((i) => [i.kind, i.status, i.answers, i.awaitingAnswerSince]),
    ).toEqual([
      ["session_created", "queued", [], null],
      ["prompt", "queued", [], null],
    ]);
    expect(items[1].prompt?.map((p) => p.body)).toEqual(["yes"]);
  });
});
