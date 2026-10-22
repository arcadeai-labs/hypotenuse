import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import type { RoutingRulePreview } from "../../actions/routing-rule/routing-rule-preview";
import {
  eligibleRunners,
  evaluateRunners,
  RUNNER_REASON_CODES,
} from "../../ops/RoutingOps";
import { runners } from "../../schema/runners";
import { workItems } from "../../schema/work_items";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import { createIssue } from "../linear/sessions";
import {
  authHeaders,
  buildTestUniverse,
  cookieHeader,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import {
  delegatedSession,
  itemsOf,
  ScriptedDaemon,
  withoutRunnerRateLimits,
} from "./helpers";

/**
 * `routing-rule:preview` judges every runner with the conditions `work:route`
 * uses, gives each one it rules out a reason code, and agrees with the code
 * routing records on a turn that cannot be placed.
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

type Preview = Awaited<ReturnType<RoutingRulePreview["run"]>>["preview"];

/** One runner per reason code, plus one that can take the work. */
const fleet: Record<string, ScriptedDaemon> = {};
let appUserId: string;
let issueIdentifier: string;

/**
 * Ask for a preview as a person.
 * @param sessionId - Who asks.
 * @param query - The query string's fields.
 * @returns The status and body.
 */
async function preview(
  sessionId: string,
  query: Record<string, string | number | boolean>,
): Promise<{
  status: number;
  body: { preview: Preview } & Record<string, unknown>;
}> {
  const qs = new URLSearchParams(
    Object.entries({ projectId: universe.projectId, ...query }).map(
      ([k, v]): [string, string] => [k, String(v)],
    ),
  );
  const res = await fetch(`${universe.url}/api/routing-rule/preview?${qs}`, {
    headers: cookieHeader(sessionId),
  });
  return { status: res.status, body: (await res.json()) as never };
}

/**
 * The reasons the preview gave one runner.
 * @param p - The preview.
 * @param name - The runner.
 * @returns Its codes.
 */
function reasonsOf(p: Preview, name: string): string[] {
  const c = p.candidates.find((x) => x.name === name);
  if (!c) throw new Error(`no candidate ${name}`);
  return c.reasons.map((r) => r.code);
}

beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  issueIdentifier = (await createIssue(linear, "Preview me")).identifier;
  const make = async (
    name: string,
    shape: Parameters<typeof ScriptedDaemon.register>[4] = {},
  ) => {
    fleet[name] = await ScriptedDaemon.register(
      universe.url,
      universe.mario,
      universe.projectId,
      `preview-${name}`,
      shape,
    );
  };
  await make("ok");
  await make("offline");
  await make("draining");
  await make("paused");
  await make("busy", { limits: { maxParallelJobs: 1 } });
  await make("roleless");
  await make("norepo");
  await make("subscribed");
  await make("never");
  const caps = fleet.ok.shape.capabilities;
  fleet.roleless.shape.capabilities = { ...caps, roles: ["manager"] };
  fleet.norepo.shape.capabilities = { ...caps, repositories: [] };
  fleet.subscribed.shape.capabilities = {
    ...caps,
    subscriptions: { teams: ["NOPE"], projects: [], labels: [] },
  };
  fleet.draining.shape.draining = true;
  for (const [name, daemon] of Object.entries(fleet)) {
    if (name !== "never") await daemon.heartbeat();
  }
  await api.db.db
    .update(runners)
    .set({ status: "offline" })
    .where(eq(runners.id, fleet.offline.id));
  const paused = await fetch(`${universe.url}/api/runner/${fleet.paused.id}`, {
    method: "POST",
    headers: authHeaders(universe.mario.sessionId),
    body: JSON.stringify({ projectId: universe.projectId, enabled: false }),
  });
  expect(paused.status).toBe(200);
}, HOOK_TIMEOUT);

/**
 * Fill the busy runner's only slot with a running turn.
 * @param agentSessionId - Any session of the project.
 */
async function occupyBusy(agentSessionId: number): Promise<void> {
  await api.db.db.insert(workItems).values({
    projectId: universe.projectId,
    agentSessionId,
    kind: "prompt",
    role: "worker",
    status: "running",
    repositoryResolved: true,
    runnerId: fleet.busy.id,
    claimedAt: new Date(),
    leaseExpiresAt: new Date(Date.now() + 3_600_000),
  });
}

describe("routing-rule:preview", () => {
  test("LC-CTX-06 every reason code, each from the runner state that produces it", async () => {
    // A finished session to hang the busy runner's turn on.
    const { session } = await delegatedSession(linear, appUserId, "Host");
    await fetch(`${universe.url}/api/agent-session/${session.id}/cancel`, {
      method: "POST",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({ projectId: universe.projectId }),
    });
    await occupyBusy(session.id);

    const { status, body } = await preview(universe.luigi.sessionId, {
      issue: issueIdentifier,
    });
    expect(status).toBe(200);
    const p = body.preview;
    expect(p.issue.identifier).toBe(issueIdentifier);
    expect(p.origin).toBe("delegation");
    expect(p.role).toBe("worker");
    expect(p.matchedRuleId).toBeNull();
    expect(p.repository).toMatchObject({
      candidates: ["github.com/acme/web"],
      repository: "github.com/acme/web",
      wouldElicit: false,
    });
    expect(
      Object.fromEntries(
        Object.keys(fleet).map((name) => [
          name,
          reasonsOf(p, `preview-${name}`),
        ]),
      ),
    ).toEqual({
      ok: [],
      offline: ["offline"],
      draining: ["draining"],
      paused: ["paused"],
      busy: ["no_capacity"],
      roleless: ["role_not_served"],
      norepo: ["repository_missing"],
      subscribed: ["subscription_mismatch"],
      never: ["offline"],
    });
    const covered = new Set(
      p.candidates.flatMap((c) => c.reasons.map((r) => r.code)),
    );
    expect([...covered].sort()).toEqual([...RUNNER_REASON_CODES].sort());
    for (const c of p.candidates) {
      expect(c.eligible).toBe(c.reasons.length === 0);
      for (const r of c.reasons) expect(r.message.length).toBeGreaterThan(10);
      expect(c.owner?.name).toBe(universe.mario.name);
    }
    expect(p.waitingCode).toBeNull();
  });

  test("eligibility is eligibleRunners', one for one", async () => {
    const issue = {
      teamKey: "ENG",
      labels: ["Frontend"],
      project: null,
    };
    for (const repository of [
      null,
      "github.com/acme/web",
      "github.com/acme/api",
    ]) {
      for (const role of ["worker", "manager"] as const) {
        const query = {
          projectId: universe.projectId,
          role,
          repository,
          issue,
        };
        const judged = await evaluateRunners(api.db.db, query);
        const eligible = await eligibleRunners(api.db.db, query);
        expect(
          judged
            .filter((e) => e.eligible)
            .map((e) => e.runnerId)
            .sort(),
        ).toEqual(eligible.map((e) => e.id).sort());
      }
    }
  });

  test("a prompt routes as a mention: /manage picks the manager by its rule", async () => {
    const { body } = await preview(universe.luigi.sessionId, {
      issue: issueIdentifier,
      prompt: "/manage plan the launch",
    });
    expect(body.preview).toMatchObject({
      origin: "mention",
      role: "manager",
      matchedRuleName: "/manage",
    });
    // The manager role is served by every runner with an agent for it.
    expect(reasonsOf(body.preview, "preview-roleless")).toEqual([]);
  });

  test("the preview's waiting code is the one work:route records", async () => {
    // Nobody can take work now: the one healthy runner is paused too.
    await api.db.db
      .update(runners)
      .set({ enabled: false })
      .where(eq(runners.id, fleet.ok.id));
    try {
      const { issue, session } = await delegatedSession(
        linear,
        appUserId,
        "Nobody can take this",
      );
      const [item] = await itemsOf(session.id);
      expect(item.status).toBe("queued");
      expect(item.waitingCode).not.toBeNull();
      const { body } = await preview(universe.luigi.sessionId, {
        issue: issue.identifier,
      });
      expect(body.preview.waitingCode as string | null).toBe(item.waitingCode);
      expect(body.preview.candidates.every((c) => !c.eligible)).toBe(true);
    } finally {
      await api.db.db
        .update(runners)
        .set({ enabled: true })
        .where(eq(runners.id, fleet.ok.id));
    }
  });

  test("withRepository asks Linear to rank several candidates; without it, it does not", async () => {
    fleet.norepo.shape.capabilities = {
      ...fleet.ok.shape.capabilities,
      repositories: [
        { name: "api", remote: "github.com/acme/api", baseBranch: "main" },
      ],
    };
    await fleet.norepo.heartbeat();
    const asked = () =>
      linear
        .requests()
        .filter((r) => r.operationName === "IssueRepositorySuggestions").length;
    const before = asked();
    const quiet = await preview(universe.luigi.sessionId, {
      issue: issueIdentifier,
    });
    expect(quiet.body.preview.repository).toMatchObject({
      candidates: ["github.com/acme/api", "github.com/acme/web"],
      repository: null,
      wouldElicit: null,
      askedLinear: false,
    });
    expect(asked()).toBe(before);

    const ranked = await preview(universe.luigi.sessionId, {
      issue: issueIdentifier,
      withRepository: true,
    });
    expect(ranked.status).toBe(200);
    expect(ranked.body.preview.repository.askedLinear).toBe(true);
    expect(asked()).toBe(before + 1);
  });

  test("refusals: an outsider, an unconnected project, an unknown issue", async () => {
    expect(
      (await preview(universe.bowser.sessionId, { issue: issueIdentifier }))
        .status,
    ).toBe(403);
    const unconnected = await fetch(
      `${universe.url}/api/routing-rule/preview?projectId=${universe.toad.projectId}&issue=${issueIdentifier}`,
      { headers: cookieHeader(universe.toad.sessionId) },
    );
    expect(unconnected.status).toBe(406);
    expect(
      (await preview(universe.luigi.sessionId, { issue: "NOPE-99999" })).status,
    ).toBe(404);
  });
});
