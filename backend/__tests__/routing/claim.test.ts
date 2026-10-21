import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { agentSessions } from "../../schema/agent_sessions";
import type { Integration } from "../../schema/integrations";
import { workItems } from "../../schema/work_items";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import {
  authHeaders,
  buildTestUniverse,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import {
  ago,
  delegatedSession,
  itemRow,
  itemsOf,
  route,
  ScriptedDaemon,
  sessionById,
  setItem,
  withoutRunnerRateLimits,
} from "./helpers";

/**
 * Offers and claims: only the runner an item is offered to can take it; an
 * offer that lapses goes elsewhere; a repeated claim is harmless; a revoked
 * runner's claim goes back to the queue; and many runners claiming at once
 * never exceed a machine or take one item twice.
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
let integration: Integration;
let mario: ScriptedDaemon;
let luigi: ScriptedDaemon;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  integration = await integrationRow(universe.projectId);
  appUserId = integration.externalAppUserId;
  mario = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    universe.projectId,
    "mario-laptop",
    { limits: { maxParallelJobs: 4 } },
  );
  luigi = await ScriptedDaemon.register(
    universe.url,
    universe.luigi,
    universe.projectId,
    "luigi-laptop",
    { limits: { maxParallelJobs: 4 } },
  );
  await mario.heartbeat();
  await luigi.heartbeat();
}, HOOK_TIMEOUT);

/**
 * The daemon a runner id belongs to, and the other one.
 * @param runnerId - The runner an item was offered to.
 * @returns `[offered, other]`.
 */
function pair(runnerId: number | null): [ScriptedDaemon, ScriptedDaemon] {
  if (runnerId === mario.id) return [mario, luigi];
  if (runnerId === luigi.id) return [luigi, mario];
  throw new Error(`offered to ${runnerId}, not a runner of this file`);
}

describe("claiming an offer", () => {
  test("only the runner it is offered to can claim it", async () => {
    const { session } = await delegatedSession(linear, appUserId, "Offer me");
    const [item] = await itemsOf(session.id);
    expect(item.status).toBe("offered");
    const [offered, other] = pair(item.offeredToRunnerId);

    expect(await other.claim()).toBeNull();
    expect(await other.claim([item.id])).toBeNull();
    expect((await itemRow(item.id)).status).toBe("offered");

    const assignment = await offered.claim();
    expect(assignment?.workItemId).toBe(item.id);
    expect(await itemRow(item.id)).toMatchObject({
      status: "claimed",
      runnerId: offered.id,
    });
    expect((await sessionById(session.id)).runnerId).toBe(offered.id);

    // Asking again for an item it holds answers the same assignment.
    const again = await offered.claim([item.id]);
    const { leaseExpiresAt: _a, ...firstRest } = assignment!;
    const { leaseExpiresAt: _b, ...againRest } = again!;
    expect(againRest).toEqual(firstRest);
    await offered.complete(item.id, "completed");
  });

  test("an offer that lapses goes to the next runner, and the one that let it lapse waits offerTtl × 3", async () => {
    const { session } = await delegatedSession(linear, appUserId, "Lapse me");
    const [item] = await itemsOf(session.id);
    const [first, second] = pair(item.offeredToRunnerId);

    await setItem(item.id, { offerExpiresAt: ago(1000) });
    expect(await first.claim([item.id])).toBeNull();
    const routed = await route();
    expect(routed.lapsed).toContain(item.id);
    expect(await itemRow(item.id)).toMatchObject({
      status: "offered",
      offeredToRunnerId: second.id,
    });
    expect(Object.keys((await itemRow(item.id)).lapsedOffers)).toEqual([
      String(first.id),
    ]);

    // Both let it lapse: nobody is offered it again yet.
    await setItem(item.id, { offerExpiresAt: ago(1000) });
    await route();
    const stalled = await itemRow(item.id);
    expect(stalled.status).toBe("queued");
    expect(stalled.waitingReason).toContain("let an offer lapse");

    // offerTtl × 3 later, they are offered it again.
    const old = Date.now() - 31_000;
    await setItem(item.id, {
      lapsedOffers: { [String(first.id)]: old, [String(second.id)]: old },
    });
    await route();
    expect((await itemRow(item.id)).status).toBe("offered");
    const holder = pair((await itemRow(item.id)).offeredToRunnerId)[0];
    expect((await holder.claim([item.id]))?.workItemId).toBe(item.id);
    await holder.complete(item.id, "completed");
  });

  test("revoking a runner returns its claim to the queue, and routing offers it elsewhere", async () => {
    const { session } = await delegatedSession(linear, appUserId, "Revoke me");
    const [item] = await itemsOf(session.id);
    // Give it to Mario's runner, whatever ranking chose.
    if (item.offeredToRunnerId !== mario.id) {
      await setItem(item.id, { offeredToRunnerId: mario.id });
    }
    expect((await mario.claim([item.id]))?.workItemId).toBe(item.id);
    expect((await sessionById(session.id)).runnerId).toBe(mario.id);

    const res = await fetch(`${universe.url}/api/runner/${mario.id}`, {
      method: "DELETE",
      headers: authHeaders(universe.mario.sessionId),
      body: JSON.stringify({ projectId: universe.projectId }),
    });
    expect(res.status).toBe(200);
    expect(await itemRow(item.id)).toMatchObject({
      status: "queued",
      runnerId: null,
      attempts: 0,
    });
    expect((await sessionById(session.id)).runnerId).toBeNull();

    await route();
    expect(await itemRow(item.id)).toMatchObject({
      status: "offered",
      offeredToRunnerId: luigi.id,
    });
    const moved = await luigi.claim([item.id]);
    expect(moved).toMatchObject({ workItemId: item.id, fresh: true });
    await luigi.complete(item.id, "completed");
  });
});

describe("many runners claiming at once", () => {
  test("no runner exceeds its capacity and no item is claimed twice", async () => {
    // Their own project, so the runners above take no part.
    const projectId = universe.toad.projectId;
    const cap = 2;
    const fleet = await Promise.all(
      ["c1", "c2", "c3"].map((name) =>
        ScriptedDaemon.register(universe.url, universe.toad, projectId, name, {
          limits: { maxParallelJobs: cap },
        }),
      ),
    );
    for (const daemon of fleet) await daemon.heartbeat();

    const itemIds: number[] = [];
    for (let i = 0; i < 10; i++) {
      const [session] = await api.db.db
        .insert(agentSessions)
        .values({
          projectId,
          type: "linear",
          integrationId: integration.id,
          externalSessionId: crypto.randomUUID(),
          externalIssueId: crypto.randomUUID(),
          teamKey: "ENG",
          origin: "delegation",
        })
        .returning();
      const [item] = await api.db.db
        .insert(workItems)
        .values({
          projectId,
          agentSessionId: session.id,
          kind: "session_created",
          role: "worker",
          repository: "github.com/acme/web",
          repositoryResolved: true,
        })
        .returning();
      itemIds.push(item.id);
    }

    /**
     * One round: route, then cap × 4 claims across the fleet at once.
     * @returns The assignments' item ids, by runner.
     */
    const round = async () => {
      await route();
      const claims = await Promise.all(
        Array.from({ length: cap * 4 * fleet.length }, (_, i) =>
          fleet[i % fleet.length].claim().then((a) => ({
            runnerId: fleet[i % fleet.length].id,
            workItemId: a?.workItemId ?? null,
          })),
        ),
      );
      return claims.filter((c) => c.workItemId !== null);
    };

    const taken = await round();
    expect(taken).toHaveLength(cap * fleet.length);
    expect(new Set(taken.map((t) => t.workItemId)).size).toBe(taken.length);

    // A second round finds every machine full.
    expect(await round()).toEqual([]);

    const rows = await Promise.all(itemIds.map(itemRow));
    const held = rows.filter((r) => r.status === "claimed");
    expect(held).toHaveLength(cap * fleet.length);
    for (const daemon of fleet) {
      expect(held.filter((r) => r.runnerId === daemon.id)).toHaveLength(cap);
    }
    expect(held.map((r) => r.id).sort((a, b) => a - b)).toEqual(
      taken.map((t) => t.workItemId!).sort((a, b) => a - b),
    );
    expect(rows.filter((r) => r.status === "queued")).toHaveLength(
      itemIds.length - cap * fleet.length,
    );
  });
});
