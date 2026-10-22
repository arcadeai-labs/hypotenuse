import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HYPOTENUSE_TOOLS } from "@hypotenuse/protocol";
import { api } from "keryx";
import { ackBody } from "../../ops/WorkItemOps";
import {
  delegatedSession,
  itemsOf,
  route,
  ScriptedDaemon,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import {
  authHeaders,
  buildTestUniverse,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import { useFinear } from "./finear";
import { appToken, integrationRow } from "./helpers";
import { activityRows, finearSession, settle } from "./sessions";

/**
 * Linear's Agent Interaction Guidelines, one principle at a time, each held
 * by an assertion about the whole system rather than one function. The
 * fifth — respect disengagement — lives in `disengagement.test.ts`.
 */

const ROOT = join(import.meta.dir, "..", "..", "..");

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
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  token = await appToken(universe.projectId);
}, HOOK_TIMEOUT);

describe("Agent Interaction Guidelines", () => {
  test("LC-AIG-01 both roles' prompts tell the model it is an AI agent and to say so", () => {
    for (const role of ["worker", "manager"]) {
      const template = readFileSync(
        join(ROOT, "cli", "src", "acp", "templates", `${role}.md`),
        "utf8",
      );
      expect(template, role).toMatch(
        /You are an AI agent[^.]*; say so if anyone asks/,
      );
    }
  });

  test("LC-AIG-02 an agent works through delegation and activities: its history is activities, and no tool assigns or merges", async () => {
    const laptop = await ScriptedDaemon.register(
      universe.url,
      universe.mario,
      universe.projectId,
      "aig-laptop",
    );
    await laptop.heartbeat();
    const { session } = await delegatedSession(linear, appUserId, "Native");
    const [item] = await itemsOf(session.id);
    if (item.status !== "offered") await route();
    const assignment = await laptop.claim([item.id]);
    const activityIds = new Set(
      (await activityRows(session.id)).map((r) => r.id),
    );
    expect(assignment?.history.length).toBeGreaterThan(0);
    for (const entry of assignment?.history ?? []) {
      expect(activityIds.has(entry.activityId)).toBe(true);
    }
    await laptop.complete(item.id, "completed");
    await settle();

    const names = HYPOTENUSE_TOOLS.map((t) => t.name);
    for (const name of names) {
      expect(name).not.toMatch(/merge|approve|assign/);
    }
    // A pull request is a session link, reported by the agent, not a comment.
    expect(names).toContain("linear_report_pr");
  });

  test("LC-AIG-03 the server acknowledges a delegation in Linear with no runner at all, at once", async () => {
    const started = Date.now();
    const { externalSessionId, session } = await delegatedSession(
      linear,
      appUserId,
      "Instant feedback",
    );
    const inLinear = await finearSession(linear, token, externalSessionId);
    expect(inLinear.activities[0]?.content.body).toBe(
      ackBody(session.issueIdentifier),
    );
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("LC-AIG-04 ephemeral activities Linear replaces stay in the dashboard's transcript", async () => {
    const laptop = await ScriptedDaemon.register(
      universe.url,
      universe.mario,
      universe.projectId,
      "aig-laptop-2",
    );
    await laptop.heartbeat();
    const { session } = await delegatedSession(
      linear,
      appUserId,
      "Transparent",
    );
    const [item] = await itemsOf(session.id);
    if (item.status !== "offered") await route();
    await laptop.claim([item.id]);
    await laptop.events(item.id, [
      { type: "thought", body: "Reading the code", ephemeral: true },
      { type: "action", action: "Ran", parameter: "bun test", result: "ok" },
      { type: "response", body: "Done." },
    ]);
    await laptop.complete(item.id, "completed");
    await settle();
    const res = await fetch(
      `${universe.url}/api/agent-session/${session.id}/activities?projectId=${universe.projectId}`,
      { headers: authHeaders(universe.mario.sessionId) },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      activities: { content: { body?: string }; deliveryStatus: string }[];
    };
    const thought = body.activities.find(
      (a) => a.content.body === "Reading the code",
    );
    expect(thought, JSON.stringify(body).slice(0, 2000)).toBeDefined();
    expect(thought?.deliveryStatus).toBe("superseded");
  });

  test("LC-AIG-06 a person stays accountable: workers never complete issues, hygiene never assigns", () => {
    const setState = HYPOTENUSE_TOOLS.find(
      (t) => t.name === "linear_set_issue_state",
    );
    expect(setState?.description).toContain(
      "A worker cannot complete or cancel an issue",
    );
    const hygiene = readFileSync(
      join(ROOT, "backend", "ops", "IssueHygieneOps.ts"),
      "utf8",
    );
    expect(hygiene).not.toMatch(/assigneeId\s*:/);
  });
});
