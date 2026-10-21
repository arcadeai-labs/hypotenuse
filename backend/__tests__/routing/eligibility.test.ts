import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { type EligibilityQuery, eligibleRunners } from "../../ops/RoutingOps";
import { agentSessions } from "../../schema/agent_sessions";
import type { Integration } from "../../schema/integrations";
import { runners } from "../../schema/runners";
import { type WorkItemStatus, workItems } from "../../schema/work_items";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import {
  authHeaders,
  buildTestUniverse,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import {
  type DaemonShape,
  ScriptedDaemon,
  withoutRunnerRateLimits,
} from "./helpers";

/**
 * `eligibleRunners()` — one query deciding which runners could take a turn
 * now. Each condition is checked in isolation against a fleet that differs
 * from a baseline runner in exactly one way, and every assertion compares the
 * whole set of ids returned.
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

let integration: Integration;

/** The issue every query asks about. */
const ISSUE: EligibilityQuery["issue"] = {
  teamKey: "ENG",
  labels: ["Frontend"],
  project: { id: "p1", name: "Checkout" },
};

/** The agent list of a runner whose one agent plays every role. */
const CLAUDE = [{ id: "claude", preset: "claude", available: true }];

/**
 * A runner's capabilities: the baseline (both roles, `acme/web`, an
 * available agent, no subscriptions) with some fields replaced.
 * @param over - The fields to change.
 * @returns The capabilities.
 */
function capabilities(
  over: Partial<NonNullable<DaemonShape["capabilities"]>> = {},
): NonNullable<DaemonShape["capabilities"]> {
  return {
    roles: ["manager", "worker"],
    agents: CLAUDE,
    repositories: [
      { name: "web", remote: "github.com/acme/web", baseBranch: "main" },
    ],
    subscriptions: { teams: [], projects: [], labels: [] },
    ...over,
  };
}

/**
 * Register a runner as Mario and, unless told not to, bring it online.
 * @param projectId - The project.
 * @param name - Its name.
 * @param shape - What it reports.
 * @param online - Whether to heartbeat.
 * @returns The daemon.
 */
async function runner(
  projectId: number,
  name: string,
  shape: DaemonShape = {},
  online = true,
): Promise<ScriptedDaemon> {
  const daemon = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    projectId,
    name,
    shape,
  );
  if (online) await daemon.heartbeat();
  return daemon;
}

/**
 * The ids eligible for a query, sorted.
 * @param query - The query, over the shared project and issue by default.
 * @returns The ids.
 */
async function eligible(
  query: Partial<EligibilityQuery> = {},
): Promise<number[]> {
  const rows = await eligibleRunners(api.db.db, {
    projectId: universe.projectId,
    role: "worker",
    repository: "github.com/acme/web",
    issue: ISSUE,
    ...query,
  });
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

/**
 * Sorted ids.
 * @param daemons - The daemons.
 * @returns Their runner ids, sorted.
 */
function ids(...daemons: ScriptedDaemon[]): number[] {
  return daemons.map((d) => d.id).sort((a, b) => a - b);
}

/**
 * Insert a bare session row of the installed integration, so a live work
 * item has a session of its own (one live turn per session).
 * @returns The session id.
 */
async function bareSession(): Promise<number> {
  const [row] = await api.db.db
    .insert(agentSessions)
    .values({
      projectId: integration.projectId,
      type: "linear",
      integrationId: integration.id,
      externalSessionId: crypto.randomUUID(),
      externalIssueId: crypto.randomUUID(),
      teamKey: "ENG",
      origin: "delegation",
    })
    .returning();
  return row.id;
}

/**
 * Insert a live work item against a runner.
 * @param runnerId - The runner it is offered to or held by.
 * @param status - `offered`, `claimed`, or `running`.
 * @param role - Its role.
 */
async function liveItem(
  runnerId: number,
  status: Extract<WorkItemStatus, "offered" | "claimed" | "running">,
  role: "manager" | "worker" = "worker",
): Promise<void> {
  const offered = status === "offered";
  await api.db.db.insert(workItems).values({
    projectId: integration.projectId,
    agentSessionId: await bareSession(),
    kind: "prompt",
    role,
    status,
    repository: "github.com/acme/web",
    repositoryResolved: true,
    agentId: "claude",
    ...(offered
      ? {
          offeredToRunnerId: runnerId,
          offerExpiresAt: new Date(Date.now() + 60_000),
        }
      : {
          runnerId,
          claimedAt: new Date(),
          leaseExpiresAt: new Date(Date.now() + 60_000),
        }),
  });
}

describe("each condition, in isolation", () => {
  let base: ScriptedDaemon;
  let offline: ScriptedDaemon;
  let paused: ScriptedDaemon;
  let managerOnly: ScriptedDaemon;
  let apiOnly: ScriptedDaemon;
  let agentDown: ScriptedDaemon;
  let agentManagerOnly: ScriptedDaemon;
  let teamOps: ScriptedDaemon;
  let teamEng: ScriptedDaemon;
  let projectOther: ScriptedDaemon;
  let projectMatch: ScriptedDaemon;
  let labelBackend: ScriptedDaemon;
  let labelFrontend: ScriptedDaemon;

  beforeAll(async () => {
    await linear.install(universe.projectId, universe.peach.sessionId);
    integration = await integrationRow(universe.projectId);
    const p = universe.projectId;
    const subs = (
      s: Partial<{ teams: string[]; projects: string[]; labels: string[] }>,
    ) =>
      capabilities({
        subscriptions: { teams: [], projects: [], labels: [], ...s },
      });

    base = await runner(p, "base");
    offline = await runner(p, "offline", {}, false);
    paused = await runner(p, "paused");
    const edit = await fetch(`${universe.url}/api/runner/${paused.id}`, {
      method: "POST",
      headers: authHeaders(universe.mario.sessionId),
      body: JSON.stringify({ projectId: p, enabled: false }),
    });
    expect(edit.status).toBe(200);
    managerOnly = await runner(p, "manager-only", {
      capabilities: capabilities({ roles: ["manager"] }),
    });
    apiOnly = await runner(p, "api-only", {
      capabilities: capabilities({
        repositories: [
          { name: "api", remote: "github.com/acme/api", baseBranch: "main" },
        ],
      }),
    });
    agentDown = await runner(p, "agent-down", {
      capabilities: capabilities({
        agents: [{ id: "claude", preset: "claude", available: false }],
      }),
    });
    agentManagerOnly = await runner(p, "agent-manager-only", {
      capabilities: capabilities({
        agents: [
          {
            id: "claude",
            preset: "claude",
            available: true,
            roles: ["manager"],
          },
        ],
      }),
    });
    teamOps = await runner(p, "team-ops", {
      capabilities: subs({ teams: ["OPS"] }),
    });
    teamEng = await runner(p, "team-eng", {
      capabilities: subs({ teams: ["ENG"] }),
    });
    projectOther = await runner(p, "project-other", {
      capabilities: subs({ projects: ["p2"] }),
    });
    projectMatch = await runner(p, "project-match", {
      capabilities: subs({ projects: ["p1"] }),
    });
    labelBackend = await runner(p, "label-backend", {
      capabilities: subs({ labels: ["Backend"] }),
    });
    labelFrontend = await runner(p, "label-frontend", {
      capabilities: subs({ labels: ["frontend"] }),
    });
  }, HOOK_TIMEOUT);

  /** Everything that passes every condition for a worker in acme/web. */
  const workers = () => ids(base, teamEng, projectMatch, labelFrontend);

  test("a worker in acme/web: only the runners meeting every condition", async () => {
    expect(await eligible()).toEqual(workers());
    // Never heartbeated, paused, wrong role, wrong repository, no usable
    // agent, or subscribed elsewhere — each excluded on its own.
    for (const excluded of [
      offline,
      paused,
      managerOnly,
      apiOnly,
      agentDown,
      agentManagerOnly,
      teamOps,
      projectOther,
      labelBackend,
    ]) {
      expect(await eligible()).not.toContain(excluded.id);
    }
  });

  test("the role: a manager turn takes manager runners and agents that play it", async () => {
    expect(await eligible({ role: "manager" })).toEqual(
      ids(
        base,
        managerOnly,
        agentManagerOnly,
        teamEng,
        projectMatch,
        labelFrontend,
      ),
    );
  });

  test("the repository: undefined ignores it, null needs none", async () => {
    const anyRepository = ids(
      base,
      apiOnly,
      teamEng,
      projectMatch,
      labelFrontend,
    );
    expect(await eligible({ repository: undefined })).toEqual(anyRepository);
    expect(await eligible({ repository: null })).toEqual(anyRepository);
    expect(await eligible({ repository: "github.com/acme/api" })).toEqual(
      ids(apiOnly),
    );
  });

  test("subscriptions: an empty kind matches everything, and kinds intersect", async () => {
    // An issue with no team, project, or labels only matches runners with no
    // rows of a kind.
    expect(
      await eligible({ issue: { teamKey: null, labels: [], project: null } }),
    ).toEqual(ids(base));
    expect(
      await eligible({
        issue: {
          teamKey: "OPS",
          labels: ["backend"],
          project: { id: "p2", name: "X" },
        },
      }),
    ).toEqual(ids(base, teamOps, projectOther, labelBackend));
  });

  test("a runner that goes offline drops out", async () => {
    await api.db.db
      .update(runners)
      .set({ status: "offline" })
      .where(eq(runners.id, teamEng.id));
    expect(await eligible()).toEqual(ids(base, projectMatch, labelFrontend));
    await teamEng.heartbeat();
    expect(await eligible()).toEqual(workers());
  });
});

describe("capacity, counted on the server at three levels", () => {
  test("the machine, the role, and the agent; an offered item already counts", async () => {
    // A separate project, so the fleet above does not appear.
    const p = universe.mario.projectId;
    const machine = await runner(p, "cap-machine", {
      limits: { maxParallelJobs: 1 },
    });
    const role = await runner(p, "cap-role", {
      limits: { maxParallelJobs: 3, roles: { worker: 1 } },
    });
    const agent = await runner(p, "cap-agent", {
      limits: { maxParallelJobs: 3, agents: { claude: 1 } },
    });
    const offered = await runner(p, "cap-offered", {
      limits: { maxParallelJobs: 1 },
    });
    const roomy = await runner(p, "cap-roomy", {
      limits: { maxParallelJobs: 3 },
    });
    const query = (r: "manager" | "worker") =>
      eligible({ projectId: p, role: r });

    expect(await query("worker")).toEqual(
      ids(machine, role, agent, offered, roomy),
    );

    await liveItem(machine.id, "claimed");
    await liveItem(role.id, "running");
    await liveItem(agent.id, "claimed", "manager");
    await liveItem(offered.id, "offered");
    await liveItem(roomy.id, "claimed");

    // Machine full; worker role full (manager room left); the only agent
    // full for either role; the offer fills its machine; one of three used.
    expect(await query("worker")).toEqual(ids(roomy));
    expect(await query("manager")).toEqual(ids(role, roomy));

    // The heartbeat's own count is display only: it does not free a slot.
    await machine.heartbeat();
    expect((await query("worker")).includes(machine.id)).toBe(false);
  });
});
