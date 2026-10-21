import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, config } from "keryx";
import { deliverSession, enqueueActivity } from "../../ops/ActivityOutboxOps";
import { bucketKey } from "../../ops/LinearBucketOps";
import { ackBody } from "../../ops/WorkItemOps";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import { useFinear } from "./finear";
import { appToken, integrationRow } from "./helpers";
import {
  activityRows,
  createIssue,
  delegate,
  finearSession,
  recordedEvent,
  sessionRow,
  waitFor,
} from "./sessions";

/**
 * The acknowledgement Linear requires within ten seconds of `created`,
 * measured through a real Resque worker: webhook → `triggers:process-event` on
 * the `triggers` queue → `activities:deliver` → finear. Every other suite drives
 * jobs in-process; this one is the latency of the path as deployed.
 */

let universe: TestUniverse;
let saved: Pick<typeof config.tasks, "taskProcessors" | "queues">;
beforeAll(async () => {
  universe = await buildTestUniverse();
  saved = {
    taskProcessors: config.tasks.taskProcessors,
    queues: config.tasks.queues,
  };
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.resque.stopWorkers();
  config.tasks.taskProcessors = saved.taskProcessors;
  config.tasks.queues = saved.queues;
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

let token: string;
let appUserId: string;
let integrationId: number;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  const row = await integrationRow(universe.projectId);
  appUserId = row.externalAppUserId;
  integrationId = row.id;
  token = await appToken(universe.projectId);
  // One worker, on the queue Linear's work runs on.
  config.tasks.taskProcessors = 1;
  config.tasks.queues = ["triggers"];
  await api.resque.startWorkers();
}, HOOK_TIMEOUT);

describe("the acknowledgement", () => {
  test("LC-BP-01 a delegation is acknowledged in finear within 3 s of the webhook arriving", async () => {
    const issue = await createIssue(linear, "Acknowledge me");
    const externalSessionId = await delegate(linear, issue.id, appUserId);
    const event = await recordedEvent(
      (e) =>
        (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
        externalSessionId,
    );
    const finear = await waitFor(async () => {
      const seen = await finearSession(linear, token, externalSessionId);
      return seen.activities.length >= 1 ? seen : undefined;
    }, 10_000);

    // The acknowledgement goes before routing even starts: routing runs on its
    // own queue, which this worker does not drain.
    const [ack] = finear.activities;
    expect(ack.content).toEqual({
      __typename: "AgentActivityThoughtContent",
      body: ackBody(issue.identifier),
    });
    const latency = Date.parse(ack.createdAt) - event.receivedAt.getTime();
    expect(latency).toBeLessThan(3000);
  });

  test("LC-BP-01 the acknowledgement spends the reserve when the bucket is otherwise empty", async () => {
    // Five tokens: below the ten kept back, so only an acknowledgement goes.
    await api.redis.redis.hset(bucketKey(integrationId), {
      tokens: "5",
      ts: String(Date.now()),
    });
    const issue = await createIssue(linear, "Busy workspace");
    const externalSessionId = await delegate(linear, issue.id, appUserId);
    const finear = await waitFor(async () => {
      const seen = await finearSession(linear, token, externalSessionId);
      return seen.activities.length >= 1 ? seen : undefined;
    }, 10_000);
    expect(finear.activities.map((a) => a.content.body)).toEqual([
      ackBody(issue.identifier),
    ]);

    const session = await sessionRow(externalSessionId);
    // finear records the activity a moment before the worker records it sent.
    await waitFor(async () => {
      const seen = await activityRows(session!.id);
      return seen[0]?.deliveryStatus === "sent" ? seen : undefined;
    });
    // Ordinary chatter in the same session waits for the bucket to refill.
    await api.db.db.transaction((tx) =>
      enqueueActivity(tx, session!.id, { type: "thought", body: "Thinking" }),
    );
    await deliverSession(session!.id);
    const rows = await activityRows(session!.id);
    expect(rows.map((r) => [r.priority, r.deliveryStatus])).toEqual([
      ["ack", "sent"],
      ["normal", "pending"],
    ]);
    expect(rows[1].attempts).toBe(0);
    expect(rows[1].nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });
});
