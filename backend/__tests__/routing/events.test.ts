import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { NOT_YOUR_WORK, SEQ_REGRESSION } from "@hypotenuse/protocol";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { dashboardSessionUrl } from "../../ops/WorkItemOps";
import { agentActivities } from "../../schema/agent_activities";
import { useFinear } from "../linear/finear";
import { appToken, integrationRow } from "../linear/helpers";
import { activityRows, finearSession, settle } from "../linear/sessions";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import {
  delegatedSession,
  itemRow,
  ScriptedDaemon,
  sessionById,
  withoutRunnerRateLimits,
} from "./helpers";

/**
 * `daemon:events`: every event type a daemon reports lands in Linear as the
 * right activity or session update (through the outbox, keyed by its
 * `eventId`), dashboard-only events stay on the work item, and every refusal
 * — invalid, not held, regressing, oversized — is the documented one.
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
    "events-laptop",
    { limits: { maxParallelJobs: 10 } },
  );
  await laptop.heartbeat();
  // A second runner that takes nothing: no roles.
  stranger = await ScriptedDaemon.register(
    universe.url,
    universe.luigi,
    universe.projectId,
    "events-stranger",
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
  expect(assignment.agentSessionId).toBe(started.session.id);
  return { ...started, workItemId: assignment.workItemId };
}

/**
 * A complete event with fresh ids.
 * @param seq - Its seq.
 * @param fields - The type and fields.
 * @returns The event.
 */
function event(
  seq: number,
  fields: Record<string, unknown>,
): Record<string, unknown> & { eventId: string } {
  return { eventId: crypto.randomUUID(), seq, at: Date.now(), ...fields };
}

describe("events reach Linear", () => {
  test("LC-SES-17 LC-SES-18 activities and session updates, each keyed by its eventId", async () => {
    const { externalSessionId, session, workItemId } =
      await claimed("Every event");
    expect((await itemRow(workItemId)).status).toBe("claimed");

    const thought = event(1, { type: "thought", body: "Reading" });
    const first = await laptop.rawEvents(workItemId, [thought]);
    expect(first.status).toBe(200);
    expect((await itemRow(workItemId)).status).toBe("running");
    await settle();

    const passing = event(2, {
      type: "thought",
      body: "Scanning files",
      ephemeral: true,
    });
    await laptop.rawEvents(workItemId, [passing]);
    await settle();

    const batch = [
      event(3, {
        type: "action",
        action: "Edited",
        parameter: "src/a.ts",
        result: "+1",
      }),
      event(4, {
        type: "plan",
        entries: [
          { content: "Read", status: "completed" },
          { content: "Write", status: "in_progress" },
        ],
      }),
      event(5, { type: "summary", title: "Fixing the thing" }),
      event(6, {
        type: "external_url",
        label: "Pull Request",
        url: "https://github.com/acme/web/pull/1",
      }),
      event(7, {
        type: "elicitation",
        body: "Which branch?",
        signal: "select",
        signalMetadata: {
          options: [{ label: "main", value: "main" }, { value: "dev" }],
        },
      }),
    ];
    const answer = await laptop.rawEvents(workItemId, batch);
    expect(answer).toEqual({
      status: 200,
      body: { accepted: 5, duplicates: 0, dropped: 0, cancelRequested: false },
    });
    await settle();

    const finear = await finearSession(linear, token, externalSessionId);
    const tail = finear.activities.slice(-4);
    expect(
      tail.map((a) => [a.content.__typename, a.ephemeral, a.signal]),
    ).toEqual([
      ["AgentActivityThoughtContent", false, null],
      ["AgentActivityThoughtContent", true, null],
      ["AgentActivityActionContent", false, null],
      ["AgentActivityElicitationContent", false, "select"],
    ]);
    expect(tail.map((a) => a.content.body ?? null)).toEqual([
      "Reading",
      "Scanning files",
      null,
      "Which branch?",
    ]);
    expect(finear.status).toBe("awaitingInput");

    const mirror = await sessionById(session.id);
    expect(mirror.plan).toEqual([
      { content: "Read", status: "completed" },
      { content: "Write", status: "inProgress" },
    ]);
    expect(mirror.summary).toBe("Fixing the thing");
    // The claim linked the dashboard; the event added the pull request.
    expect(mirror.externalUrls).toEqual([
      { label: "Hypotenuse", url: dashboardSessionUrl(session.id) },
      { label: "Pull Request", url: "https://github.com/acme/web/pull/1" },
    ]);

    // Each event is the outbox row whose client id is its eventId.
    const rows = await activityRows(session.id);
    for (const e of [thought, passing, ...batch]) {
      const row = rows.find((r) => r.clientActivityId === e.eventId);
      expect(row?.deliveryStatus, String(e.type)).toBe("sent");
    }
    const elicitation = rows.find(
      (r) => r.clientActivityId === batch[4].eventId,
    );
    expect(elicitation).toMatchObject({
      signal: "select",
      signalMetadata: {
        options: [{ label: "main", value: "main" }, { value: "dev" }],
      },
    });
    expect(
      rows.find((r) => r.clientActivityId === batch[1].eventId)?.kind,
    ).toBe("session_update");
  });

  test("a response and an error end their sessions as Linear shows them", async () => {
    const answered = await claimed("Answered");
    await laptop.events(answered.workItemId, [
      { type: "response", body: "All done." },
    ]);
    const failed = await claimed("Failed");
    await laptop.events(failed.workItemId, [
      { type: "error", body: "The tests would not run." },
    ]);
    await settle();
    const done = await finearSession(linear, token, answered.externalSessionId);
    expect(done.status).toBe("complete");
    expect(done.activities.at(-1)?.content).toEqual({
      __typename: "AgentActivityResponseContent",
      body: "All done.",
    });
    const broke = await finearSession(linear, token, failed.externalSessionId);
    expect(broke.status).toBe("error");
    expect(broke.activities.at(-1)?.content.body).toBe(
      "The tests would not run.",
    );
    expect((await itemRow(answered.workItemId)).answeredAt).not.toBeNull();
  });

  test("usage and status stay on the work item and are not sent", async () => {
    const { session, workItemId } = await claimed("Accounting");
    const before = (await activityRows(session.id)).length;
    const res = await laptop.events(workItemId, [
      { type: "status", state: "waiting_permission" },
      { type: "usage", inputTokens: 1200, outputTokens: 300, costUsd: 0.02 },
    ]);
    expect(res.body).toMatchObject({ accepted: 2 });
    const item = await itemRow(workItemId);
    expect(item.daemonState).toBe("waiting_permission");
    expect(item.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.02,
    });
    expect(await activityRows(session.id)).toHaveLength(before);
  });

  test("a replayed batch is idempotent end to end", async () => {
    const { externalSessionId, session, workItemId } =
      await claimed("Replayed");
    const batch = [
      event(1, { type: "thought", body: "Once" }),
      event(2, { type: "status", state: "running" }),
    ];
    expect((await laptop.rawEvents(workItemId, batch)).body).toMatchObject({
      accepted: 2,
      duplicates: 0,
    });
    await settle();
    const rowsBefore = (await activityRows(session.id)).length;
    expect((await laptop.rawEvents(workItemId, batch)).body).toMatchObject({
      accepted: 0,
      duplicates: 2,
    });
    await settle();
    expect(await activityRows(session.id)).toHaveLength(rowsBefore);
    const finear = await finearSession(linear, token, externalSessionId);
    expect(
      finear.activities.filter((a) => a.content.body === "Once"),
    ).toHaveLength(1);
  });
});

describe("refusals", () => {
  test("an invalid event rejects the batch with its index", async () => {
    const { session, workItemId } = await claimed("Invalid");
    const before = (await activityRows(session.id)).length;
    const cases: Record<string, unknown>[] = [
      { type: "response", body: "x", ephemeral: true },
      { type: "summary", title: "two\nlines" },
      {
        type: "elicitation",
        body: "Pick",
        signal: "select",
        signalMetadata: { options: [] },
      },
    ];
    for (const bad of cases) {
      const res = await laptop.rawEvents(workItemId, [
        event(1, { type: "thought", body: "fine" }),
        event(2, bad),
      ]);
      expect(res.status, String(bad.type)).toBe(406);
      const error = res.body.error as { key?: string };
      expect(error.key, String(bad.type)).toMatch(/^events\.1(\.|$)/);
    }
    // Nothing from a refused batch was written.
    expect(await activityRows(session.id)).toHaveLength(before);
  });

  test("an item this runner does not hold is NOT_YOUR_WORK", async () => {
    const { workItemId } = await claimed("Not yours");
    const body = [event(1, { type: "thought", body: "Mine?" })];
    const theirs = await stranger.rawEvents(workItemId, body);
    expect(theirs.status).toBe(409);
    expect((theirs.body.error as { type: string }).type).toBe(NOT_YOUR_WORK);

    const unknown = await laptop.rawEvents(999_999, body);
    expect(unknown.status).toBe(409);
    expect((unknown.body.error as { type: string }).type).toBe(NOT_YOUR_WORK);

    await laptop.events(workItemId, [{ type: "response", body: "Done." }]);
    await laptop.complete(workItemId, "completed");
    const finished = await laptop.rawEvents(workItemId, [
      event(9, { type: "thought", body: "Late" }),
    ]);
    expect(finished.status).toBe(409);
    expect((finished.body.error as { type: string }).type).toBe(NOT_YOUR_WORK);
  });

  test("a new event at or below an accepted seq is SEQ_REGRESSION", async () => {
    const { session, workItemId } = await claimed("Regressing");
    await laptop.rawEvents(workItemId, [
      event(5, { type: "thought", body: "Five" }),
    ]);
    const before = (await activityRows(session.id)).length;
    for (const seq of [5, 3]) {
      const res = await laptop.rawEvents(workItemId, [
        event(seq, { type: "thought", body: `Again ${seq}` }),
      ]);
      expect(res.status).toBe(409);
      expect((res.body.error as { type: string }).type).toBe(SEQ_REGRESSION);
    }
    expect(await activityRows(session.id)).toHaveLength(before);
    expect((await itemRow(workItemId)).lastEventSeq).toBe(5);
  });

  test("a batch over 256 KiB is 413", async () => {
    const { workItemId } = await claimed("Oversized");
    const big = "x".repeat(60 * 1024);
    const res = await laptop.rawEvents(
      workItemId,
      [1, 2, 3, 4, 5].map((seq) => event(seq, { type: "thought", body: big })),
    );
    expect(res.status).toBe(413);
    const rows = await api.db.db
      .select()
      .from(agentActivities)
      .where(eq(agentActivities.content, { type: "thought", body: big }));
    expect(rows).toHaveLength(0);
  });
});
