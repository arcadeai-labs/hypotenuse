import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ActionResponse, api } from "keryx";
import type { ActionsPermissions } from "../../actions/actions-permissions";
import type { ProjectView } from "../../actions/project/project-view";
import { RBAC_LEVELS, type RbacLevel } from "../../middleware/rbac";
import { SessionMiddleware } from "../../middleware/session";
import {
  NEVER_MCP_ACTION_NAMES,
  NEVER_MCP_PREFIXES,
  shouldPublishAsMcpTool,
} from "../../ops/McpToolPolicyOps";
import { ADMIN_TAG } from "../../ops/TagOps";
import {
  authHeaders,
  buildTestUniverse,
  cookieHeader,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";

/**
 * The actions that accept a `projectId` and correctly declare `none`.
 *
 * A notification belongs to a **user**, not to a project: the bell spans every
 * project the caller is in, and somebody removed from a project still holds the
 * rows they were sent while they were in it. So the gate is a session, and
 * `projectId` here is a filter that narrows an already-user-scoped set — it
 * cannot widen one. `ProjectMemberMiddleware` would additionally require it,
 * which would make an unscoped bell impossible.
 *
 * An explicit list rather than a pattern, so adding a fourth is a deliberate
 * act with a reviewer attached.
 */
const SESSION_SCOPED_PROJECT_FILTERS = new Set([
  "notification:list",
  "notification:unread-count",
  "notification:mark-read",
]);

/**
 * Every action's RBAC level, as a whole. A new action changes this map in the
 * same commit, which is the point: its level is a decision a reviewer sees.
 */
const EXPECTED_LEVELS: Record<string, RbacLevel> = {
  // Member-gated reads.
  "project:view": "member",
  "project:settings-view": "member",
  "membership:list": "member",
  "tag:list": "member",
  "integration:view": "member",
  "integration:list": "member",
  "integration:catalog": "member",
  "agent-session:list": "member",
  "agent-session:view": "member",
  "agent-session:activities": "member",
  "routing-rule:list": "member",
  // Any member may ask how an issue would route: it reads, and names only
  // the project's own runners.
  "routing-rule:preview": "member",
  "project:overview": "member",
  "external-identity:list": "member",
  // Cancelling a session's work is any member's call, as Stop in Linear is.
  "agent-session:cancel": "member",
  // Your own link or, for an admin, anyone's — decided inside the action.
  "external-identity:unlink": "member",
  // Runners: any member registers their own and reads the fleet; editing and
  // revoking are owner-or-admin, decided inside the action on the row.
  "runner:register": "member",
  "runner:list": "member",
  "runner:view": "member",
  "runner:edit": "member",
  "runner:revoke": "member",

  // Admin-gated: managing people, tags, invites, the project itself, and
  // reading the audit log, which names who did what.
  "project:edit": "admin",
  "project:delete": "admin",
  "membership:create": "admin",
  "membership:delete": "admin",
  "tag:create": "admin",
  "tag:edit": "admin",
  "tag:delete": "admin",
  "user-tag:assign": "admin",
  "user-tag:remove": "admin",
  "invite:create": "admin",
  "invite:list": "admin",
  "audit:list": "admin",
  // Connecting and disconnecting an integration attach or detach a whole
  // workspace.
  "integration:connect": "admin",
  "integration:disconnect": "admin",
  // Which role answers a session, and how long work waits, are the project's.
  "routing-rule:create": "admin",
  "routing-rule:edit": "admin",
  "routing-rule:delete": "admin",
  "routing-rule:reorder": "admin",
  "project:settings-edit": "admin",
  "external-identity:link": "admin",

  // Not project-scoped: session-scoped, public, or a clock. `none` is correct
  // rather than an omission.
  status: "none",
  swagger: "none",
  "actions:permissions": "none",
  "user:create": "none",
  "user:edit": "none",
  "session:create": "none",
  "session:destroy": "none",
  "me:view": "none",
  "project:create": "none",
  "project:list": "none",
  "invite:list-pending": "none",
  "invite:accept": "none",
  "invite:reject": "none",
  "notification:list": "none",
  "notification:unread-count": "none",
  "notification:mark-read": "none",
  "cli-auth:approve": "none",
  "cli-auth:activate": "none",
  "cli-auth:device": "none",
  "cli-auth:exchange": "none",
  "cli-token:list": "none",
  "cli-token:revoke": "none",
  "notifications:dispatch": "none",
  "notifications:sweep": "none",
  "invites:sweep": "none",
  "audit:sweep": "none",
  // The browser hop is bound to the session that started it, not to a
  // projectId param; it re-checks admin itself before writing.
  "linear:callback": "none",
  "integrations:refresh-tokens": "none",
  "linear:manifest-url": "none",
  // Machine ingress: Linear is the caller, and the signature is the gate.
  "webhooks:linear": "none",
  "triggers:process-event": "none",
  "triggers:process-pending": "none",
  "trigger-events:sweep": "none",
  "activities:deliver": "none",
  "activities:deliver-due": "none",
  "sessions:broadcast": "none",
  // The daemon's surface: the runner token is the gate, and it carries its
  // project — no `projectId` param.
  "daemon:connect": "none",
  "daemon:heartbeat": "none",
  "daemon:claim": "none",
  "daemon:events": "none",
  "daemon:complete": "none",
  // The agent tools: the runner token, then the session's live turn, are the gate.
  "daemon:linear-get-issue": "none",
  "daemon:linear-list-comments": "none",
  "daemon:linear-comment": "none",
  "daemon:linear-set-issue-state": "none",
  "daemon:linear-set-plan": "none",
  "daemon:linear-ask-user": "none",
  "daemon:linear-report-pr": "none",
  "daemon:linear-search-issues": "none",
  "daemon:linear-create-issue": "none",
  "daemon:linear-update-issue": "none",
  "daemon:linear-create-sub-issue": "none",
  "daemon:linear-create-relation": "none",
  "daemon:linear-get-project": "none",
  "daemon:linear-update-project": "none",
  "daemon:linear-create-document": "none",
  "daemon:linear-update-document": "none",
  "daemon:linear-list-labels": "none",
  "daemon:dispatch": "none",
  "work:reap": "none",
  "work:route": "none",
  "sessions:keepalive": "none",
};

/** Every clock: task-only, never an HTTP route. */
const CLOCKS = [
  "notifications:dispatch",
  "notifications:sweep",
  "invites:sweep",
  "audit:sweep",
  "integrations:refresh-tokens",
  "triggers:process-pending",
  "trigger-events:sweep",
  "activities:deliver-due",
  "work:reap",
  "work:route",
  "sessions:keepalive",
];

let universe: TestUniverse;
let url: string;

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * The live action registry's named actions.
 *
 * `String(...)` rather than `a.name`: the action glob loads every export in
 * `actions/**`, and a helper exported alongside an action class lands in the
 * registry with no name at all.
 * @returns Every registered action that has a name.
 */
function namedActions() {
  return api.actions.actions.filter((a) => typeof a?.name === "string");
}

describe("actions:permissions", () => {
  test("needs no auth and reports a known level for every action", async () => {
    const res = await fetch(`${url}/api/actions/permissions`);
    expect(res.status).toBe(200);

    const { permissions } =
      (await res.json()) as ActionResponse<ActionsPermissions>;

    expect(Object.keys(permissions).length).toBeGreaterThan(0);
    for (const [name, requirement] of Object.entries(permissions)) {
      expect(
        RBAC_LEVELS.includes(requirement.type as RbacLevel),
        `${name} reported an unknown level: ${requirement.type}`,
      ).toBe(true);
    }
  });

  test("reports exactly the expected level for every action", async () => {
    const res = await fetch(`${url}/api/actions/permissions`);
    const { permissions } =
      (await res.json()) as ActionResponse<ActionsPermissions>;

    const reported = Object.fromEntries(
      Object.entries(permissions).map(([name, r]) => [name, r.type]),
    );
    expect(reported).toEqual(EXPECTED_LEVELS);
  });

  test("clocks are task-only — no public HTTP routes", () => {
    for (const name of CLOCKS) {
      const action = api.actions.actions.find((a) => a.name === name);
      expect(action, name).toBeDefined();
      expect(action?.web?.route, name).toBeUndefined();
      expect(action?.task?.frequency, name).toBeGreaterThan(0);
    }
    // And the converse, from the registry: anything with a frequency is a
    // clock, so it is in the list above.
    const recurring = namedActions()
      .filter((a) => (a.task?.frequency ?? 0) > 0)
      .map((a) => a.name)
      .sort();
    expect(recurring).toEqual([...CLOCKS].sort());
  });

  test("every action taking a projectId declares member or admin", async () => {
    const res = await fetch(`${url}/api/actions/permissions`);
    const { permissions } =
      (await res.json()) as ActionResponse<ActionsPermissions>;

    // Derived from the live registry, so an action added later that accepts a
    // `projectId` but forgets its RBAC middleware fails this test rather than
    // shipping unguarded.
    for (const action of api.actions.actions) {
      const shape = (
        action.inputs as unknown as { shape?: Record<string, unknown> }
      )?.shape;
      if (!shape || !("projectId" in shape)) continue;
      if (SESSION_SCOPED_PROJECT_FILTERS.has(action.name)) continue;
      expect(
        permissions[action.name]?.type,
        `${action.name} accepts projectId but declares no RBAC requirement`,
      ).not.toBe("none");
    }
  });

  test("the session-scoped exceptions really are scoped to the session", () => {
    // The carve-out above is only sound because these three take `projectId` as
    // a **narrowing filter** over rows that are already the caller's own, never
    // as the thing that decides whose rows they are. That is the property worth
    // asserting rather than the absence of middleware: they must be behind
    // `SessionMiddleware`, and they must not accept a `userId` — because the
    // moment one did, a param would be choosing the tenant.
    for (const name of SESSION_SCOPED_PROJECT_FILTERS) {
      const action = api.actions.actions.find((a) => a.name === name);
      expect(action, name).toBeDefined();
      expect(action?.middleware ?? [], name).toContain(SessionMiddleware);

      const shape = (
        action?.inputs as unknown as { shape?: Record<string, unknown> }
      )?.shape;
      expect(shape && "userId" in shape, name).toBe(false);
    }
  });
});

describe("MCP publish policy", () => {
  test("every action's mcp.tool flag matches the publish policy", () => {
    // Human MCP ≈ HTTP: almost every action with a web route is a tool.
    // Class-level `mcp.tool` is the boot default; `applyMcpToolPolicy`
    // overwrites it, so this is the assertion that the live registry matches
    // the function.
    for (const action of api.actions.actions) {
      expect(action.mcp?.tool ?? false, action.name).toBe(
        shouldPublishAsMcpTool(action),
      );
    }
  });

  test("publishes exactly the human HTTP surface, minus the never-list", () => {
    const published = namedActions()
      .filter((a) => a.mcp?.tool)
      .map((a) => a.name)
      .sort();
    expect(published).toEqual(
      [
        "agent-session:activities",
        "agent-session:cancel",
        "agent-session:list",
        "agent-session:view",
        "audit:list",
        "cli-token:list",
        "external-identity:link",
        "external-identity:list",
        "external-identity:unlink",
        "cli-token:revoke",
        "invite:accept",
        "invite:create",
        "invite:list",
        "invite:list-pending",
        "invite:reject",
        "integration:catalog",
        "integration:connect",
        "integration:disconnect",
        "integration:list",
        "integration:view",
        "me:view",
        "membership:create",
        "membership:delete",
        "membership:list",
        "notification:list",
        "notification:mark-read",
        "notification:unread-count",
        "project:create",
        "project:delete",
        "project:edit",
        "project:list",
        "project:overview",
        "project:settings-edit",
        "project:settings-view",
        "project:view",
        "routing-rule:create",
        "routing-rule:delete",
        "routing-rule:edit",
        "routing-rule:list",
        "routing-rule:preview",
        "routing-rule:reorder",
        "runner:edit",
        "runner:list",
        "runner:revoke",
        "runner:view",
        "tag:create",
        "tag:delete",
        "tag:edit",
        "tag:list",
        "user-tag:assign",
        "user-tag:remove",
        "user:edit",
      ].sort(),
    );
  });

  test("the never-list is exactly the declared set", () => {
    // Declared before some of its members exist, so the change that adds
    // `runner:register` cannot forget it.
    expect([...NEVER_MCP_ACTION_NAMES].sort()).toEqual(
      [
        "actions:permissions",
        "cli-auth:activate",
        "cli-auth:approve",
        "cli-auth:device",
        "cli-auth:exchange",
        "linear:callback",
        "runner:register",
        "session:create",
        "session:destroy",
        "status",
        "swagger",
        "user:create",
      ].sort(),
    );
    expect([...NEVER_MCP_PREFIXES].sort()).toEqual(["daemon:", "webhooks:"]);
  });

  test("machine families are refused by prefix, and the human runner ledger is not", () => {
    const routed = (name: string) => ({ name, web: { route: "/x" } });
    for (const name of [
      "daemon:connect",
      "daemon:heartbeat",
      "daemon:linear-comment",
      "webhooks:linear",
      "linear:callback",
      "runner:register",
    ]) {
      expect(shouldPublishAsMcpTool(routed(name)), name).toBe(false);
    }
    // `runner:*` is the human ledger, named apart from `daemon:*` on purpose.
    for (const name of ["runner:list", "runner:revoke"]) {
      expect(shouldPublishAsMcpTool(routed(name)), name).toBe(true);
    }
  });

  test("no live daemon:* or webhooks:* action is a tool", () => {
    for (const action of namedActions()) {
      if (NEVER_MCP_PREFIXES.some((p) => action.name.startsWith(p))) {
        expect(action.mcp?.tool, action.name).toBe(false);
      }
    }
  });

  test("a clock or a route-less action is never a tool", () => {
    expect(
      shouldPublishAsMcpTool({
        name: "x:tick",
        web: { route: "/x" },
        task: { frequency: 1000 },
      }),
    ).toBe(false);
    expect(shouldPublishAsMcpTool({ name: "x:job" })).toBe(false);
  });
});

describe("RBAC enforcement", () => {
  test("an outsider is refused a member-level action", async () => {
    const res = await fetch(
      `${url}/api/project?projectId=${universe.projectId}`,
      { headers: cookieHeader(universe.bowser.sessionId) },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toContain("not a member");
  });

  test("a member is allowed a member-level action", async () => {
    const res = await fetch(
      `${url}/api/project?projectId=${universe.projectId}`,
      { headers: cookieHeader(universe.toad.sessionId) },
    );
    expect(res.status).toBe(200);
  });

  test("a member without the admin tag is refused an admin-level action", async () => {
    const res = await fetch(`${url}/api/tag`, {
      method: "PUT",
      headers: authHeaders(universe.mario.sessionId),
      body: JSON.stringify({ projectId: universe.projectId, name: "plumbers" }),
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { message: string } };
    expect(body.error?.message).toContain("admin");
  });

  test("an admin is allowed the same admin-level action", async () => {
    const res = await fetch(`${url}/api/tag`, {
      method: "PUT",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({ projectId: universe.projectId, name: "plumbers" }),
    });
    expect(res.status).toBe(200);
  });

  test("a signed-out caller is 401, not 403", async () => {
    const res = await fetch(
      `${url}/api/project?projectId=${universe.projectId}`,
    );
    expect(res.status).toBe(401);
  });

  test("tags do not leak across projects: an admin of one is an outsider to another", async () => {
    // Bowser administers his own bootstrap project, which must not grant him
    // anything in Peach's.
    const own = await fetch(`${url}/api/tag`, {
      method: "PUT",
      headers: authHeaders(universe.bowser.sessionId),
      body: JSON.stringify({
        projectId: universe.bowser.projectId,
        name: "koopas",
      }),
    });
    expect(own.status).toBe(200);

    const theirs = await fetch(`${url}/api/tag`, {
      method: "PUT",
      headers: authHeaders(universe.bowser.sessionId),
      body: JSON.stringify({ projectId: universe.projectId, name: "koopas" }),
    });
    expect(theirs.status).toBe(403);
  });

  test("project:view answers standing, so no client has to know the tag is called 'admin'", async () => {
    const asAdmin = await fetch(
      `${url}/api/project?projectId=${universe.projectId}`,
      { headers: cookieHeader(universe.peach.sessionId) },
    );
    const adminBody = (await asAdmin.json()) as ActionResponse<ProjectView>;
    expect(adminBody.standing).toEqual({ isMember: true, isAdmin: true });
    // Reserved-ness is reported per tag too, for the same reason.
    expect(
      adminBody.callerTags.find((t) => t.name === ADMIN_TAG)?.reserved,
    ).toBe(true);

    const asMember = await fetch(
      `${url}/api/project?projectId=${universe.projectId}`,
      { headers: cookieHeader(universe.toad.sessionId) },
    );
    const memberBody = (await asMember.json()) as ActionResponse<ProjectView>;
    expect(memberBody.standing).toEqual({ isMember: true, isAdmin: false });
    expect(memberBody.callerTags).toEqual([]);
  });

  test("a missing projectId is a validation error, not a 500", async () => {
    const res = await fetch(`${url}/api/tags`, {
      headers: cookieHeader(universe.peach.sessionId),
    });
    expect(res.status).toBe(406);
  });
});
