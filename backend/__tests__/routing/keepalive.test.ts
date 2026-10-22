import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { agentActivities } from "../../schema/agent_activities";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import { activityRows } from "../linear/sessions";
import {
  buildTestUniverse,
  HOOK_TIMEOUT,
  runAction,
  type TestUniverse,
} from "../setup";
import {
  ago,
  delegatedSession,
  itemsOf,
  personSays,
  ScriptedDaemon,
  withoutRunnerRateLimits,
} from "./helpers";

/**
 * `sessions:keepalive`: a session waiting on Hypotenuse that has gone quiet
 * for 25 minutes gets an ephemeral thought before Linear marks it stale; one
 * waiting on a person, or with a turn running, is left alone.
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
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
}, HOOK_TIMEOUT);

const WEB = { name: "web", remote: "github.com/acme/web", baseBranch: "main" };
const API = { name: "api", remote: "github.com/acme/api", baseBranch: "main" };

/**
 * Make a session's every activity look `minutes` old.
 * @param agentSessionId - The session.
 * @param minutes - How old.
 */
async function quiet(agentSessionId: number, minutes = 26): Promise<void> {
  await api.db.db
    .update(agentActivities)
    .set({ createdAt: ago(minutes * 60_000) })
    .where(eq(agentActivities.agentSessionId, agentSessionId));
}

/**
 * Run the keepalive clock once.
 * @returns The sessions it kept alive.
 */
async function keepalive(): Promise<number[]> {
  return (await runAction<{ kept: number[] }>("sessions:keepalive")).kept;
}

describe("sessions:keepalive", () => {
  let daemon: ScriptedDaemon;

  test("LC-BP-03 LC-SES-09 a queued session quiet for 25 minutes gets an ephemeral thought; a recent one does not", async () => {
    const { session: waiting } = await delegatedSession(
      linear,
      appUserId,
      "Waiting quietly",
    );
    const { session: recent } = await delegatedSession(
      linear,
      appUserId,
      "Just asked",
    );
    await quiet(waiting.id);

    const kept = await keepalive();
    expect(kept).toContain(waiting.id);
    expect(kept).not.toContain(recent.id);
    const last = (await activityRows(waiting.id)).at(-1)!;
    expect(last).toMatchObject({
      direction: "outbound",
      contentType: "thought",
      ephemeral: true,
    });
    expect(
      (last.content as { body: string }).body.startsWith("Still queued."),
    ).toBe(true);
    // Now it is not quiet any more.
    expect(await keepalive()).not.toContain(waiting.id);
  });

  test("LC-BP-03 a session waiting on a person's answer is left to go stale", async () => {
    daemon = await ScriptedDaemon.register(
      universe.url,
      universe.mario,
      universe.projectId,
      "two-repos",
      { limits: { maxParallelJobs: 20 } },
    );
    await daemon.heartbeat({
      capabilities: { ...daemon.shape.capabilities, repositories: [WEB, API] },
    });
    const { session } = await delegatedSession(linear, appUserId, "Asking");
    expect(session.pendingRepositoryChoice).not.toBeNull();
    await quiet(session.id);
    expect(await keepalive()).not.toContain(session.id);
  });

  test("LC-BP-03 a session whose turn is running is the daemon's to keep alive, follow-ups queued or not", async () => {
    await daemon.heartbeat({
      capabilities: { ...daemon.shape.capabilities, repositories: [WEB] },
    });
    const { session, externalSessionId } = await delegatedSession(
      linear,
      appUserId,
      "Running",
    );
    const assignment = await daemon.claim();
    expect(assignment?.agentSessionId).toBe(session.id);
    await daemon.events(assignment!.workItemId, [
      { type: "thought", body: "Working", ephemeral: false },
    ]);
    expect((await itemsOf(session.id))[0].status).toBe("running");
    await quiet(session.id);
    expect(await keepalive()).not.toContain(session.id);

    // A follow-up queued behind the running turn is the daemon's too.
    await personSays(linear, externalSessionId, "And the docs");
    expect((await itemsOf(session.id)).map((i) => i.status)).toEqual([
      "running",
      "queued",
    ]);
    await quiet(session.id);
    expect(await keepalive()).not.toContain(session.id);
  });
});
