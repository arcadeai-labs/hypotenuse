import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { api } from "keryx";
import {
  type RoutingFacts,
  ruleMatches,
  selectRole,
  startsWithPrefix,
  stripPrefix,
} from "../../ops/RoutingOps";
import type { RoutingMatch, RoutingRule } from "../../schema/routing_rules";
import { routingRules } from "../../schema/routing_rules";
import {
  FINEAR_FIXTURES,
  FINEAR_PRIMARY_KEY,
  useFinear,
} from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import {
  activityRows,
  delegate,
  recordedEvent,
  sessionRow,
  settle,
} from "../linear/sessions";
import {
  authHeaders,
  buildTestUniverse,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import {
  delegatedSession,
  itemsOf,
  route,
  ScriptedDaemon,
  withoutRunnerRateLimits,
} from "./helpers";

/**
 * Choosing the role: a project's ordered routing rules over facts on the
 * issue and the prompt, the first enabled match deciding and worker the
 * default — tested as pure functions field by field, then through finear.
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

/** Facts no rule field narrows: a plain delegation. */
const BASE: RoutingFacts = {
  labels: ["Bug", "Frontend"],
  teamKey: "ENG",
  projectId: "proj-1",
  hasParent: false,
  projectHasContent: null,
  origin: "delegation",
  text: null,
};

/**
 * A rule row for the pure tests.
 * @param id - Its id (and position).
 * @param match - What it matches.
 * @param role - What it chooses.
 * @param enabled - Whether it is evaluated.
 * @returns The rule.
 */
function rule(
  id: number,
  match: RoutingMatch,
  role: "manager" | "worker",
  enabled = true,
): RoutingRule {
  return {
    id,
    projectId: 1,
    position: id,
    name: `rule ${id}`,
    enabled,
    match,
    role,
    repository: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("matching, field by field", () => {
  test("labels match any of them, case-insensitively", () => {
    expect(ruleMatches({ labels: ["frontend"] }, BASE)).toBe(true);
    expect(ruleMatches({ labels: ["PRD", "BUG"] }, BASE)).toBe(true);
    expect(ruleMatches({ labels: ["PRD"] }, BASE)).toBe(false);
    expect(ruleMatches({ labels: ["PRD"] }, { ...BASE, labels: [] })).toBe(
      false,
    );
  });

  test("team keys, case-insensitively", () => {
    expect(ruleMatches({ teamKeys: ["eng", "OPS"] }, BASE)).toBe(true);
    expect(ruleMatches({ teamKeys: ["OPS"] }, BASE)).toBe(false);
    expect(ruleMatches({ teamKeys: ["ENG"] }, { ...BASE, teamKey: null })).toBe(
      false,
    );
  });

  test("project ids", () => {
    expect(ruleMatches({ projectIds: ["proj-1"] }, BASE)).toBe(true);
    expect(ruleMatches({ projectIds: ["proj-2"] }, BASE)).toBe(false);
    expect(
      ruleMatches({ projectIds: ["proj-1"] }, { ...BASE, projectId: null }),
    ).toBe(false);
  });

  test("a prompt prefix is a whole token, and a delegation has no text", () => {
    const mention = { ...BASE, origin: "mention" as const };
    expect(
      ruleMatches(
        { promptPrefix: "/manage" },
        { ...mention, text: "/manage plan it" },
      ),
    ).toBe(true);
    expect(
      ruleMatches({ promptPrefix: "/manage" }, { ...mention, text: "/MANAGE" }),
    ).toBe(true);
    expect(
      ruleMatches(
        { promptPrefix: "/manage" },
        { ...mention, text: "/manager do it" },
      ),
    ).toBe(false);
    expect(
      ruleMatches(
        { promptPrefix: "/manage" },
        { ...mention, text: "please /manage" },
      ),
    ).toBe(false);
    expect(ruleMatches({ promptPrefix: "/manage" }, BASE)).toBe(false);
    expect(startsWithPrefix("  /work\tnow", "/work")).toBe(true);
    expect(stripPrefix("  /work  fix the bug ", "/work")).toBe("fix the bug");
  });

  test("hasParent, either way", () => {
    expect(ruleMatches({ hasParent: false }, BASE)).toBe(true);
    expect(ruleMatches({ hasParent: true }, BASE)).toBe(false);
    expect(ruleMatches({ hasParent: true }, { ...BASE, hasParent: true })).toBe(
      true,
    );
  });

  test("origin", () => {
    expect(ruleMatches({ origin: "delegation" }, BASE)).toBe(true);
    expect(ruleMatches({ origin: "mention" }, BASE)).toBe(false);
  });

  test("every present field must hold; an empty match holds always", () => {
    expect(ruleMatches({ labels: ["bug"], teamKeys: ["ENG"] }, BASE)).toBe(
      true,
    );
    expect(ruleMatches({ labels: ["bug"], teamKeys: ["OPS"] }, BASE)).toBe(
      false,
    );
    expect(ruleMatches({}, BASE)).toBe(true);
  });
});

describe("selectRole", () => {
  test("the first enabled match wins; a disabled rule is skipped; the default is worker", () => {
    const rules = [
      rule(1, { labels: ["bug"] }, "manager", false),
      rule(2, { teamKeys: ["ENG"] }, "worker"),
      rule(3, { labels: ["bug"] }, "manager"),
    ];
    expect(selectRole(rules, BASE)).toMatchObject({
      role: "worker",
      rule: { id: 2 },
    });
    expect(selectRole(rules.slice(2), BASE)).toMatchObject({
      role: "manager",
      rule: { id: 3 },
    });
    expect(selectRole([rules[0]], BASE)).toEqual({
      role: "worker",
      rule: null,
      text: null,
    });
  });

  test("a matched prefix is stripped from the text", () => {
    const decision = selectRole(
      [rule(1, { promptPrefix: "/manage" }, "manager")],
      {
        ...BASE,
        origin: "mention",
        text: "/manage plan the launch",
      },
    );
    expect(decision).toMatchObject({
      role: "manager",
      text: "plan the launch",
    });
  });
});

describe("through finear", () => {
  test("connecting Linear seeds /manage, /work, the manager label, and the empty-project rule disabled", async () => {
    const rows = await api.db.db
      .select()
      .from(routingRules)
      .where(eq(routingRules.projectId, universe.projectId))
      .orderBy(asc(routingRules.position));
    expect(
      rows.map((r) => [r.position, r.name, r.match, r.role, r.enabled]),
    ).toEqual([
      [0, "/manage", { promptPrefix: "/manage" }, "manager", true],
      [1, "/work", { promptPrefix: "/work" }, "worker", true],
      [
        2,
        "hypotenuse:manager label",
        { labels: ["hypotenuse:manager"] },
        "manager",
        true,
      ],
      [
        3,
        "plan an empty project",
        { hasParent: false, projectHasContent: false },
        "manager",
        false,
      ],
    ]);
  });

  test("a delegation no rule matches is a worker, and the session says so", async () => {
    const { session } = await delegatedSession(linear, appUserId, "Plain");
    expect(session.role).toBe("worker");
    expect(session.instruction).toBeNull();
    const bodies = (await activityRows(session.id)).map(
      (r) => (r.content as { body?: string }).body,
    );
    expect(bodies).toContain(
      "Routing as **worker** (no rule matched; worker is the default).",
    );
  });

  test("a mention starting /manage is a manager, the prefix stripped, and a manager runner with no repositories gets it", async () => {
    const issue = (
      await linear.graphql<{
        issueCreate: { issue: { id: string; identifier: string } };
      }>(
        FINEAR_PRIMARY_KEY,
        `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier } } }`,
        { input: { teamId: FINEAR_FIXTURES.primary.team, title: "Launch" } },
      )
    ).data!.issueCreate.issue;
    const comment = await linear.graphql<{
      commentCreate: { comment: { id: string } };
    }>(
      FINEAR_PRIMARY_KEY,
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { comment { id } } }`,
      { input: { issueId: issue.id, body: "/manage plan the launch" } },
    );
    const mentioned = await linear.control<{ entity: { id: string } }>(
      "/__test/agents/mention",
      {
        issueId: issue.id,
        appUserId,
        commentId: comment.data!.commentCreate.comment.id,
      },
    );
    await recordedEvent(
      (e) =>
        (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
        mentioned.entity.id,
    );
    await settle();

    const session = (await sessionRow(mentioned.entity.id))!;
    expect(session).toMatchObject({
      origin: "mention",
      role: "manager",
      instruction: "plan the launch",
      repository: null,
    });
    const bodies = (await activityRows(session.id)).map(
      (r) => (r.content as { body?: string }).body,
    );
    expect(bodies).toContain("Routing as **manager** (rule: /manage).");
    expect((await itemsOf(session.id))[0]).toMatchObject({
      role: "manager",
      repository: null,
      repositoryResolved: true,
      status: "queued",
    });

    const manager = await ScriptedDaemon.register(
      universe.url,
      universe.peach,
      universe.projectId,
      "manager-box",
      {
        capabilities: {
          roles: ["manager"],
          agents: [{ id: "claude", preset: "claude", available: true }],
          repositories: [],
          subscriptions: { teams: [], projects: [], labels: [] },
        },
      },
    );
    await manager.heartbeat();
    await route();
    const assignment = await manager.claim();
    expect(assignment).toMatchObject({
      agentSessionId: session.id,
      role: "manager",
      repository: null,
      branch: null,
      instruction: "plan the launch",
    });
  });

  test("a label rule an admin adds matches an issue carrying that label", async () => {
    const res = await fetch(`${universe.url}/api/routing-rule`, {
      method: "PUT",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        name: "PRDs",
        role: "manager",
        match: { labels: ["prd"] },
      }),
    });
    expect(res.status).toBe(200);

    const label = await linear.graphql<{
      issueLabelCreate: { issueLabel: { id: string } };
    }>(
      FINEAR_PRIMARY_KEY,
      `mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id } } }`,
      { input: { name: "PRD", teamId: FINEAR_FIXTURES.primary.team } },
    );
    expect(label.errors).toBeUndefined();
    const created = await linear.graphql<{
      issueCreate: { issue: { id: string } };
    }>(
      FINEAR_PRIMARY_KEY,
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id } } }`,
      {
        input: {
          teamId: FINEAR_FIXTURES.primary.team,
          title: "Write the PRD",
          labelIds: [label.data!.issueLabelCreate.issueLabel.id],
        },
      },
    );
    const issueId = created.data!.issueCreate.issue.id;
    const externalSessionId = (
      await linear.control<{ entity: { id: string } }>(
        "/__test/agents/delegate",
        { issueId, appUserId },
      )
    ).entity.id;
    await recordedEvent(
      (e) =>
        (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
        externalSessionId,
    );
    await settle();
    const session = (await sessionRow(externalSessionId))!;
    expect(session.role).toBe("manager");
    expect(session.issueSnapshot?.labels).toEqual(["PRD"]);
    const bodies = (await activityRows(session.id)).map(
      (r) => (r.content as { body?: string }).body,
    );
    expect(bodies).toContain("Routing as **manager** (rule: PRDs).");
  });

  test("LC-SES-24 the seeded empty-project rule, once enabled, makes a top-level issue in a project with no PRD a manager", async () => {
    await api.db.db
      .update(routingRules)
      .set({ enabled: true })
      .where(eq(routingRules.name, "plan an empty project"));
    try {
      const statuses = await linear.graphql<{
        organization: { projectStatuses: { id: string }[] };
      }>(FINEAR_PRIMARY_KEY, `{ organization { projectStatuses { id } } }`);
      const project = (
        await linear.graphql<{ projectCreate: { project: { id: string } } }>(
          FINEAR_PRIMARY_KEY,
          `mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { project { id } } }`,
          {
            input: {
              name: "Saved carts",
              teamIds: [FINEAR_FIXTURES.primary.team],
              statusId: statuses.data!.organization.projectStatuses[0]!.id,
            },
          },
        )
      ).data!.projectCreate.project;

      /**
       * Delegate a new top-level issue in the project and settle it.
       * @param title - The issue's title.
       * @returns The session's role.
       */
      const roleFor = async (title: string) => {
        const issue = (
          await linear.graphql<{ issueCreate: { issue: { id: string } } }>(
            FINEAR_PRIMARY_KEY,
            `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id } } }`,
            {
              input: {
                teamId: FINEAR_FIXTURES.primary.team,
                projectId: project.id,
                title,
              },
            },
          )
        ).data!.issueCreate.issue;
        const externalSessionId = await delegate(linear, issue.id, appUserId);
        await recordedEvent(
          (e) =>
            (e.payload as { agentSession?: { id?: string } }).agentSession
              ?.id === externalSessionId,
        );
        await settle();
        return (await sessionRow(externalSessionId))!;
      };

      const empty = await roleFor("Plan saved carts");
      expect(empty.role).toBe("manager");
      expect(empty.issueSnapshot?.project).toMatchObject({
        id: project.id,
        hasContent: false,
      });
      expect(
        (await activityRows(empty.id)).map(
          (r) => (r.content as { body?: string }).body,
        ),
      ).toContain("Routing as **manager** (rule: plan an empty project).");

      await linear.graphql(
        FINEAR_PRIMARY_KEY,
        `mutation($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { success } }`,
        { id: project.id, input: { content: "## Problem\nCarts vanish." } },
      );
      const written = await roleFor("Build saved carts");
      expect(written.role).toBe("worker");
      expect(written.issueSnapshot?.project?.hasContent).toBe(true);
    } finally {
      await api.db.db
        .update(routingRules)
        .set({ enabled: false })
        .where(eq(routingRules.name, "plan an empty project"));
    }
  });
});
