import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { HeartbeatResponse } from "@hypotenuse/protocol";
import { count, eq } from "drizzle-orm";
import { api, config } from "keryx";
import { runnerSubscriptions } from "../../schema/runner_subscriptions";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import {
  eventually,
  frames,
  heartbeat,
  heartbeatBody,
  openSocket,
  registerRunner,
  runnerRow,
  subscribe,
  type TestRunner,
  type TestSocket,
} from "./helpers";

let universe: TestUniverse;
let url: string;
let runner: TestRunner;
let dashboard: TestSocket;
const machineId = `sha256:${"c0".repeat(16)}`;
const channel = () => `project:${universe.projectId}:runners`;

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
  runner = await registerRunner(
    url,
    universe.mario,
    universe.projectId,
    "beating",
  );
  dashboard = await openSocket(url, universe.toad.sessionId);
  expect((await subscribe(dashboard, channel())).ok).toBe(true);
}, HOOK_TIMEOUT);

afterAll(async () => {
  dashboard.socket.close();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * How many subscription rows the runner has, and their ids — a rewrite
 * replaces ids even when the values are the same.
 * @returns The ids.
 */
async function subscriptionIds(): Promise<number[]> {
  const rows = await api.db.db
    .select({ id: runnerSubscriptions.id })
    .from(runnerSubscriptions)
    .where(eq(runnerSubscriptions.runnerId, runner.id));
  return rows.map((r) => r.id).sort();
}

/**
 * How many `{ event: "runners" }` frames the dashboard has had. Keryx's own
 * presence frames (`join`, `leave`) share the channel and are not counted.
 * @returns The count.
 */
function runnerFrames(): number {
  return frames(dashboard, channel()).filter((e) => e === "runners").length;
}

/**
 * Wait for the dashboard's frame count to settle, then return it.
 * @returns How many `runners` frames have arrived.
 */
async function dashboardFrames(): Promise<number> {
  await Bun.sleep(150);
  return runnerFrames();
}

describe("daemon:heartbeat", () => {
  test("the response has the final shape", async () => {
    const res = await heartbeat(
      url,
      runner.token,
      heartbeatBody({ machineId }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    const parsed = HeartbeatResponse.parse(body);
    expect(parsed).toMatchObject({
      heartbeatIntervalMs: config.runners.heartbeatIntervalMs,
      leaseMs: config.runners.leaseMs,
      offers: [],
      cancels: [],
      unknownActive: [],
    });
    expect(Math.abs(parsed.serverTime - Date.now())).toBeLessThan(5_000);
  });

  test("records the reported facts and normalized capabilities", async () => {
    const row = await runnerRow(runner.id);
    expect(row).toMatchObject({
      status: "online",
      platform: "darwin-arm64",
      hostname: "test-host",
      daemonVersion: "0.4.0",
      protocolVersion: 1,
      machineId,
      roles: ["worker"],
      limits: { maxParallelJobs: 2 },
      activeCount: 0,
    });
    expect(row.repositories).toEqual([
      { name: "web", remote: "github.com/acme/web", baseBranch: "main" },
    ]);
    expect(row.lastHeartbeatAt).not.toBeNull();

    const view = (await (
      await fetch(
        `${url}/api/runner/${runner.id}?projectId=${universe.projectId}`,
        {
          headers: {
            Cookie: `${config.session.cookieName}=${universe.toad.sessionId}`,
          },
        },
      )
    ).json()) as { runner: { subscriptions: unknown } };
    expect(view.runner.subscriptions).toEqual({
      teams: ["ENG"],
      projects: [],
      labels: ["frontend"],
    });
  });

  test("unchanged capabilities write no subscription rows and publish nothing", async () => {
    const before = await subscriptionIds();
    const framesBefore = await dashboardFrames();
    // Same capabilities, keys in a different order.
    const body = heartbeatBody({ machineId });
    const reordered = {
      ...body,
      capabilities: {
        subscriptions: body.capabilities.subscriptions,
        repositories: body.capabilities.repositories,
        agents: body.capabilities.agents,
        roles: body.capabilities.roles,
      },
    };
    for (let i = 0; i < 3; i++) {
      expect((await heartbeat(url, runner.token, reordered)).status).toBe(200);
    }
    expect(await subscriptionIds()).toEqual(before);
    expect(await dashboardFrames()).toBe(framesBefore);
  });

  test("changed capabilities replace the subscriptions and tell the dashboard", async () => {
    const framesBefore = await dashboardFrames();
    const body = heartbeatBody({ machineId });
    const res = await heartbeat(url, runner.token, {
      ...body,
      capabilities: {
        ...body.capabilities,
        roles: ["manager", "worker"],
        subscriptions: { teams: ["OPS", "ENG"], projects: ["p1"], labels: [] },
      },
    });
    expect(res.status).toBe(200);
    const [{ total }] = await api.db.db
      .select({ total: count() })
      .from(runnerSubscriptions)
      .where(eq(runnerSubscriptions.runnerId, runner.id));
    expect(total).toBe(3);
    expect((await runnerRow(runner.id)).roles).toEqual(["manager", "worker"]);
    expect(await eventually(() => runnerFrames() > framesBefore)).toBe(true);
  });

  test("draining sets the status and tells the dashboard; a normal beat clears it", async () => {
    const framesBefore = await dashboardFrames();
    const body = heartbeatBody({ machineId });
    await heartbeat(url, runner.token, {
      ...body,
      draining: true,
      capabilities: (await runnerRowCapabilities()) ?? body.capabilities,
    });
    expect((await runnerRow(runner.id)).status).toBe("draining");
    expect(await eventually(() => runnerFrames() > framesBefore)).toBe(true);
    await heartbeat(url, runner.token, {
      ...body,
      capabilities: (await runnerRowCapabilities()) ?? body.capabilities,
    });
    expect((await runnerRow(runner.id)).status).toBe("online");
  });

  test("unknownActive echoes held items the server does not know", async () => {
    const res = await heartbeat(
      url,
      runner.token,
      heartbeatBody({
        machineId,
        active: [
          {
            workItemId: 812,
            agentSessionId: 91,
            role: "worker",
            agentId: "claude",
            state: "running",
          },
        ],
      }),
    );
    const body = HeartbeatResponse.parse(await res.json());
    expect(body.unknownActive).toEqual([812]);
    expect((await runnerRow(runner.id)).activeCount).toBe(1);
  });

  test("a body with an unknown field is refused", async () => {
    const res = await heartbeat(url, runner.token, {
      ...heartbeatBody({ machineId }),
      surprise: true,
    });
    expect(res.status).toBe(406);
  });
});

/**
 * The capabilities the row holds now, in the request's shape, so a beat can
 * change only its status.
 * @returns The capabilities, or null before the first beat.
 */
async function runnerRowCapabilities() {
  const row = await runnerRow(runner.id);
  const view = (await (
    await fetch(
      `${url}/api/runner/${runner.id}?projectId=${universe.projectId}`,
      {
        headers: {
          Cookie: `${config.session.cookieName}=${universe.toad.sessionId}`,
        },
      },
    )
  ).json()) as {
    runner: {
      subscriptions: { teams: string[]; projects: string[]; labels: string[] };
    };
  };
  return {
    roles: row.roles,
    agents: row.agents,
    repositories: row.repositories,
    subscriptions: view.runner.subscriptions,
  };
}
