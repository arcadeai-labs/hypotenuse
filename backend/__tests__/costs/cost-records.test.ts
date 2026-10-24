import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { api } from "keryx";
import type {
  CostGroup,
  CostTotals,
  SerializedCostRecord,
} from "../../ops/CostOps";
import { COST_DIMENSIONS } from "../../ops/CostOps";
import { agentSessions } from "../../schema/agent_sessions";
import { type CostRecord, costRecords } from "../../schema/cost_records";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import {
  ago,
  delegatedSession,
  itemRow,
  itemsOf,
  reap,
  route,
  ScriptedDaemon,
  setItem,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import {
  authHeaders,
  buildTestUniverse,
  cookieHeader,
  HOOK_TIMEOUT,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * Cost attribution: every claim of a turn that ends leaves one
 * `cost_records` row with what the daemon reported it spent and whom it is
 * attributable to — completed, stopped (its usage arriving only with the
 * completion), finished by the server and completed late, requeued by a
 * lapsed lease or a revoked runner — and none for a turn never claimed.
 * `cost:list`, `cost:summary`, and `agent-session:view` read them back over
 * HTTP.
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
    "costs-laptop",
    { limits: { maxParallelJobs: 10 } },
  );
  await laptop.heartbeat();
}, HOOK_TIMEOUT);

/**
 * Delegate an issue and have the laptop claim its first turn.
 * @param title - The issue's title.
 * @returns The session row and the claimed item's id.
 */
async function claimed(title: string) {
  const { session } = await delegatedSession(linear, appUserId, title);
  const assignment = await laptop.claim();
  if (!assignment) throw new Error("nothing to claim");
  expect(assignment.agentSessionId).toBe(session.id);
  return { session, workItemId: assignment.workItemId };
}

/**
 * A work item's cost records, oldest claim first.
 * @param workItemId - The item.
 * @returns Its rows.
 */
async function recordsOf(workItemId: number): Promise<CostRecord[]> {
  return api.db.db
    .select()
    .from(costRecords)
    .where(eq(costRecords.workItemId, workItemId))
    .orderBy(asc(costRecords.claimedAt));
}

/**
 * GET an API route as a user, in the shared project.
 * @param path - Under `/api`.
 * @param user - Who asks.
 * @param params - Query parameters.
 * @returns The status and body.
 */
async function get<T>(
  path: string,
  user: TestUser,
  params: Record<string, string | number> = {},
): Promise<{ status: number; body: T }> {
  const query = new URLSearchParams(
    Object.entries({ projectId: universe.projectId, ...params }).map(
      ([k, v]): [string, string] => [k, String(v)],
    ),
  );
  const res = await fetch(`${universe.url}/api${path}?${query}`, {
    headers: cookieHeader(user.sessionId),
  });
  return { status: res.status, body: (await res.json()) as T };
}

interface ListBody {
  costRecords: SerializedCostRecord[];
  total: CostTotals;
  pagination: { page: number; limit: number; total: number; pages: number };
}

interface SummaryBody {
  by: string;
  groups: CostGroup[];
  total: CostTotals;
  pagination: { page: number; limit: number; total: number; pages: number };
}

describe("cost records", () => {
  test("a completed claim records the completion's usage and its attribution", async () => {
    const { session, workItemId } = await claimed("Cost me");
    expect(
      (
        await laptop.events(workItemId, [
          { type: "usage", inputTokens: 100, outputTokens: 20, costUsd: 0.5 },
          { type: "response", body: "Done." },
        ])
      ).status,
    ).toBe(200);
    expect(
      (
        await laptop.complete(workItemId, "completed", {
          usage: { inputTokens: 1200, outputTokens: 300, costUsd: 0.75 },
        })
      ).status,
    ).toBe(200);

    const [record, ...rest] = await recordsOf(workItemId);
    expect(rest).toEqual([]);
    const item = await itemRow(workItemId);
    expect(record).toMatchObject({
      projectId: universe.projectId,
      agentSessionId: session.id,
      rootAgentSessionId: session.id,
      kind: "session_created",
      role: "worker",
      repository: "github.com/acme/web",
      issuerUserId: null,
      externalIssueId: session.externalIssueId,
      issueIdentifier: session.issueIdentifier,
      runnerId: laptop.id,
      runnerName: "costs-laptop",
      runnerUserId: universe.mario.userId,
      agentId: "claude",
      ending: "completed",
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.75,
      claimedAt: item.claimedAt,
    });
    // The turn's usage keeps the context window its events reported.
    expect(item.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.75,
    });
  });

  test("a stopped turn's usage arrives only with its completion, and is recorded", async () => {
    const { session, workItemId } = await claimed("Stop me");
    const cancel = await fetch(
      `${universe.url}/api/agent-session/${session.id}/cancel`,
      {
        method: "POST",
        headers: authHeaders(universe.luigi.sessionId),
        body: JSON.stringify({ projectId: universe.projectId }),
      },
    );
    expect(cancel.status).toBe(200);
    const dropped = await laptop.events(workItemId, [
      { type: "usage", costUsd: 0.1 },
    ]);
    expect(dropped.body).toMatchObject({ accepted: 0, dropped: 1 });
    await laptop.complete(workItemId, "cancelled", {
      usage: { inputTokens: 40, costUsd: 0.3 },
    });
    expect(await recordsOf(workItemId)).toEqual([
      expect.objectContaining({
        ending: "cancelled",
        inputTokens: 40,
        outputTokens: null,
        costUsd: 0.3,
      }),
    ]);
  });

  test("a stop the server finished first still takes the late completion's usage", async () => {
    const { session, workItemId } = await claimed("Too slow to stop");
    await fetch(`${universe.url}/api/agent-session/${session.id}/cancel`, {
      method: "POST",
      headers: authHeaders(universe.mario.sessionId),
      body: JSON.stringify({ projectId: universe.projectId }),
    });
    await setItem(workItemId, { cancelRequestedAt: ago(60 * 60 * 1000) });
    expect((await reap()).stopped).toContain(workItemId);
    expect(await recordsOf(workItemId)).toEqual([
      expect.objectContaining({ ending: "cancelled", costUsd: null }),
    ]);

    const late = await laptop.complete(workItemId, "cancelled", {
      usage: { outputTokens: 7, costUsd: 0.2 },
    });
    expect(late.body).toMatchObject({ alreadyTerminal: true });
    expect(await recordsOf(workItemId)).toEqual([
      expect.objectContaining({
        ending: "cancelled",
        outputTokens: 7,
        costUsd: 0.2,
      }),
    ]);
  });

  test("a lapsed lease records the lost claim, and the next claim records its own", async () => {
    const { workItemId } = await claimed("Lapse me");
    await laptop.events(workItemId, [{ type: "usage", costUsd: 0.4 }]);
    await setItem(workItemId, { leaseExpiresAt: ago(1000) });
    expect((await reap()).requeued).toEqual([workItemId]);
    expect((await itemRow(workItemId)).usage).toBeNull();
    expect(await recordsOf(workItemId)).toEqual([
      expect.objectContaining({
        ending: "requeued",
        runnerId: laptop.id,
        costUsd: 0.4,
      }),
    ]);

    await route();
    await laptop.heartbeat();
    const again = await laptop.claim();
    expect(again?.workItemId).toBe(workItemId);
    await laptop.complete(workItemId, "completed", { usage: { costUsd: 0.1 } });
    const records = await recordsOf(workItemId);
    expect(records.map((r) => [r.ending, r.costUsd])).toEqual([
      ["requeued", 0.4],
      ["completed", 0.1],
    ]);
    expect(records[0]!.claimedAt.getTime()).toBeLessThan(
      records[1]!.claimedAt.getTime(),
    );
  });

  test("a turn stopped before any runner claimed it records nothing", async () => {
    const { session } = await delegatedSession(
      linear,
      appUserId,
      "Never started",
    );
    const res = await fetch(
      `${universe.url}/api/agent-session/${session.id}/cancel`,
      {
        method: "POST",
        headers: authHeaders(universe.mario.sessionId),
        body: JSON.stringify({ projectId: universe.projectId }),
      },
    );
    expect(res.status).toBe(200);
    expect((await itemsOf(session.id)).map((i) => i.status)).toEqual([
      "cancelled",
    ]);
    const rows = await api.db.db
      .select()
      .from(costRecords)
      .where(eq(costRecords.agentSessionId, session.id));
    expect(rows).toEqual([]);
  });

  test("a manager's tree totals its own turns and its dispatched workers'", async () => {
    const manager = await claimed("Plan the work");
    await laptop.complete(manager.workItemId, "completed", {
      usage: { inputTokens: 10, outputTokens: 1, costUsd: 1 },
    });
    // A worker the manager dispatched: the parent column is what dispatch writes.
    const { session: worker } = await delegatedSession(
      linear,
      appUserId,
      "Do the work",
    );
    await api.db.db
      .update(agentSessions)
      .set({ parentAgentSessionId: manager.session.id })
      .where(eq(agentSessions.id, worker.id));
    const claim = await laptop.claim();
    expect(claim?.agentSessionId).toBe(worker.id);
    await laptop.complete(claim!.workItemId, "failed", {
      error: "boom",
      usage: { inputTokens: 5, outputTokens: 2, costUsd: 0.25 },
    });
    expect(await recordsOf(claim!.workItemId)).toEqual([
      expect.objectContaining({
        rootAgentSessionId: manager.session.id,
        ending: "failed",
      }),
    ]);
    // The worker's result wakes the manager for a review: a turn of its own.
    await route();
    await laptop.heartbeat();
    const review = await laptop.claim();
    expect(review?.agentSessionId).toBe(manager.session.id);
    expect(review?.kind).toBe("review");
    await laptop.complete(review!.workItemId, "completed", {
      usage: { costUsd: 0.5 },
    });

    const managerView = await get<{
      cost: CostTotals;
      treeCost: CostTotals | null;
    }>(`/agent-session/${manager.session.id}`, universe.luigi);
    expect(managerView.status).toBe(200);
    expect(managerView.body.cost).toEqual({
      turns: 2,
      unpricedTurns: 0,
      inputTokens: 10,
      outputTokens: 1,
      costUsd: 1.5,
    });
    expect(managerView.body.treeCost).toEqual({
      turns: 3,
      unpricedTurns: 0,
      inputTokens: 15,
      outputTokens: 3,
      costUsd: 1.75,
    });
    const workerView = await get<{
      cost: CostTotals;
      treeCost: CostTotals | null;
    }>(`/agent-session/${worker.id}`, universe.luigi);
    expect(workerView.body.cost.costUsd).toBe(0.25);
    expect(workerView.body.treeCost).toBeNull();

    const tree = await get<ListBody>("/costs", universe.luigi, {
      rootAgentSessionId: manager.session.id,
    });
    expect(tree.body.costRecords.map((r) => r.agentSessionId)).toEqual([
      manager.session.id,
      worker.id,
      manager.session.id,
    ]);
    expect(tree.body.total.costUsd).toBe(1.75);
  });
});

describe("cost:list", () => {
  test("newest first, paginated, filtered, with the filtered total", async () => {
    const all = await api.db.db.select().from(costRecords);
    const first = await get<ListBody>("/costs", universe.luigi, { limit: 2 });
    expect(first.status).toBe(200);
    expect(first.body.pagination).toEqual({
      page: 1,
      limit: 2,
      total: all.length,
      pages: Math.ceil(all.length / 2),
    });
    expect(first.body.costRecords).toHaveLength(2);
    expect(first.body.costRecords[0]!.endedAt).toBeGreaterThanOrEqual(
      first.body.costRecords[1]!.endedAt,
    );
    expect(first.body.total.turns).toBe(all.length);
    expect(first.body.total.unpricedTurns).toBe(
      all.filter((r) => r.costUsd === null).length,
    );

    const failed = await get<ListBody>("/costs", universe.luigi, {
      runnerUserId: universe.mario.userId,
      role: "worker",
      since: Date.now() - 60 * 60 * 1000,
    });
    expect(failed.body.costRecords.length).toBe(all.length);
    const nobody = await get<ListBody>("/costs", universe.luigi, {
      runnerUserId: universe.luigi.userId,
    });
    expect(nobody.body).toMatchObject({
      costRecords: [],
      total: { turns: 0, costUsd: null },
    });
    const future = await get<ListBody>("/costs", universe.luigi, {
      until: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });
    expect(future.body.costRecords).toEqual([]);
  });

  test("an outsider is refused, and another project's records are not listed", async () => {
    expect((await get("/costs", universe.bowser)).status).toBe(403);
    expect((await get("/costs/summary", universe.bowser)).status).toBe(403);
    const own = await get<ListBody>("/costs", universe.bowser, {
      projectId: universe.bowser.projectId,
    });
    expect(own.status).toBe(200);
    expect(own.body.costRecords).toEqual([]);
  });
});

describe("cost:summary", () => {
  test("every dimension's groups add up to the total", async () => {
    const all = await api.db.db.select().from(costRecords);
    const priced = all.filter((r) => r.costUsd !== null);
    const expectedCost =
      Math.round(priced.reduce((s, r) => s + Number(r.costUsd), 0) * 1e6) / 1e6;
    for (const by of COST_DIMENSIONS) {
      const { status, body } = await get<SummaryBody>(
        "/costs/summary",
        universe.luigi,
        { by, limit: 100 },
      );
      expect(status).toBe(200);
      expect(body.by).toBe(by);
      expect(body.total).toMatchObject({
        turns: all.length,
        costUsd: expectedCost,
      });
      expect(body.groups.reduce((s, g) => s + g.turns, 0)).toBe(all.length);
      expect(body.pagination.total).toBe(body.groups.length);
      const costs = body.groups.map((g) => g.costUsd ?? -1);
      expect(costs).toEqual([...costs].sort((a, b) => b - a));
    }
  });

  test("groups are labelled as a person reads them", async () => {
    const runner = await get<SummaryBody>("/costs/summary", universe.luigi, {
      by: "runner",
    });
    expect(runner.body.groups).toEqual([
      expect.objectContaining({
        key: String(laptop.id),
        label: "costs-laptop",
      }),
    ]);
    const owner = await get<SummaryBody>("/costs/summary", universe.luigi, {
      by: "owner",
    });
    expect(owner.body.groups).toEqual([
      expect.objectContaining({
        key: String(universe.mario.userId),
        label: "Mario",
      }),
    ]);
    const day = await get<SummaryBody>("/costs/summary", universe.luigi, {
      by: "day",
    });
    expect(day.body.groups.map((g) => g.key)).toEqual([
      new Date().toISOString().slice(0, 10),
    ]);
    const sessions = await get<SummaryBody>("/costs/summary", universe.luigi, {
      by: "session",
      limit: 1,
    });
    const top = sessions.body.groups[0]!;
    const [row] = await api.db.db
      .select()
      .from(agentSessions)
      .where(eq(agentSessions.id, Number(top.key)));
    expect(top.label).toBe(row!.issueIdentifier);
    // The most expensive session is the manager's: its turn and its review.
    expect(top.costUsd).toBe(1.5);
    expect(sessions.body.pagination.pages).toBe(sessions.body.pagination.total);
  });

  test("an issuer the turn resolved is the issuer group", async () => {
    const { workItemId } = await claimed("Asked by Luigi");
    await setItem(workItemId, { preferredUserId: universe.luigi.userId });
    await laptop.complete(workItemId, "completed", { usage: { costUsd: 2 } });
    const issuer = await get<SummaryBody>("/costs/summary", universe.luigi, {
      by: "issuer",
    });
    // Every other turn had no resolved issuer: one group, keyed null.
    expect(issuer.body.groups.map((g) => [g.key, g.label, g.turns])).toEqual([
      [null, null, issuer.body.total.turns - 1],
      [String(universe.luigi.userId), "Luigi", 1],
    ]);
    expect(issuer.body.groups[1]!.costUsd).toBe(2);
  });
});

describe("a revoked runner", () => {
  test("its held claims are recorded as requeued, under the name it had", async () => {
    const { workItemId } = await claimed("Revoke me");
    await laptop.events(workItemId, [{ type: "usage", costUsd: 0.05 }]);
    const res = await fetch(
      `${universe.url}/api/runner/${laptop.id}?projectId=${universe.projectId}`,
      { method: "DELETE", headers: cookieHeader(universe.mario.sessionId) },
    );
    expect(res.status).toBe(200);
    expect(await recordsOf(workItemId)).toEqual([
      expect.objectContaining({
        ending: "requeued",
        runnerName: "costs-laptop",
        runnerUserId: universe.mario.userId,
        costUsd: 0.05,
      }),
    ]);
    expect((await itemRow(workItemId)).status).toBe("queued");
  });
});
