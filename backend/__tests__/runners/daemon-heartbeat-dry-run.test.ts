import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { useFinear } from "../linear/finear";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import {
  heartbeat,
  heartbeatBody,
  registerRunner,
  runnerRow,
  type TestRunner,
} from "./helpers";

/**
 * A dry-run heartbeat (`config validate --online`, `doctor`): it answers who
 * the token is and which subscribed team keys the project's Linear connection
 * cannot see, and writes nothing — the runner stays offline with no
 * capabilities, and no work is offered.
 */

let universe: TestUniverse;
let runner: TestRunner;
beforeAll(async () => {
  universe = await buildTestUniverse();
  runner = await registerRunner(
    universe.url,
    universe.mario,
    universe.projectId,
    "dry",
  );
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

/**
 * Send a dry run with these subscribed teams.
 * @param teams - Team keys.
 * @returns Status and body.
 */
async function dryRun(teams: string[]) {
  const body = heartbeatBody({ dryRun: true });
  body.capabilities.subscriptions.teams = teams;
  const res = await heartbeat(universe.url, runner.token, body);
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>,
  };
}

describe("daemon:heartbeat dryRun", () => {
  test("without a Linear connection: who the token is, team keys unchecked, nothing written", async () => {
    const { status, body } = await dryRun(["ENG"]);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      offers: [],
      cancels: [],
      unknownActive: [],
      runner: {
        id: runner.id,
        name: "dry",
        projectId: universe.projectId,
        projectSlug: expect.any(String),
      },
      unknownSubscriptions: null,
    });
    const row = await runnerRow(runner.id);
    expect(row.status).toBe("offline");
    expect(row.lastHeartbeatAt).toBeNull();
    expect(row.limits).toBeNull();
  });

  test("with one: the subscribed keys the workspace does not have", async () => {
    await linear.install(universe.projectId, universe.peach.sessionId);
    const { status, body } = await dryRun(["ENG", "NOPE"]);
    expect(status).toBe(200);
    expect(body.unknownSubscriptions).toEqual({ teams: ["NOPE"] });
    expect((await runnerRow(runner.id)).status).toBe("offline");
  });
});
