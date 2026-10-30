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
  buildTestUniverse,
  call,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";

/**
 * Every action's RBAC level, as a whole. A new action changes this map in the
 * same commit, which is the point: its level is a decision a reviewer sees.
 */
const EXPECTED_LEVELS: Record<string, RbacLevel> = {
  // A project's member level: a membership, or owning its organization.
  "project:view": "member",
  "project:settings-view": "member",
  "membership:list": "member",
  "tag:list": "member",
  "model-connection:view": "member",
  "model-connection:list": "member",
  "model-alias:list": "member",
  // Bots are member-level; each one's access lists decide the rest inside
  // the action (`canReadBot` / `canWriteBot`).
  "bot:create": "member",
  "bot:view": "member",
  "bot:list": "member",
  "bot:edit": "member",
  "bot:delete": "member",
  "bot:avatar": "member",
  "bot:rotate-callback-secret": "member",
  // Conversations are member-level; the bot's read list decides the rest
  // inside the action. Talking to a bot asks no more than reading it.
  "conversation:create": "member",
  "conversation:message": "member",
  "conversation:list": "member",
  "conversation:view": "member",
  "conversation:entries": "member",
  "conversation:cancel": "member",

  // A project's admin level: managing people, tags, invites, the project.
  "project:edit": "admin",
  "project:delete": "admin",
  "membership:create": "admin",
  "membership:delete": "admin",
  "tag:create": "admin",
  "tag:edit": "admin",
  "tag:delete": "admin",
  "user-tag:assign": "admin",
  "user-tag:remove": "admin",
  "invite:list": "admin",
  "audit:list": "admin",
  // Which models the project pays for.
  "model-connection:create": "admin",
  "model-connection:edit": "admin",
  "model-connection:delete": "admin",
  "model-connection:test": "admin",
  "model-connection:models": "admin",
  "model-alias:create": "admin",
  "model-alias:edit": "admin",
  "model-alias:delete": "admin",

  // Organization members. Two of these decide more inside the action:
  // removing someone else needs an owner (leaving does not), and an invite
  // needs project admin standing or, for an organization invite, an owner.
  "organization:view": "org-member",
  "organization-membership:list": "org-member",
  "organization-membership:delete": "org-member",
  "invite:create": "org-member",

  // Organization owners: the organization itself, its owners, its projects.
  "organization:edit": "org-owner",
  "organization:delete": "org-owner",
  "organization:invite-list": "org-owner",
  "organization:audit-list": "org-owner",
  "organization-membership:edit": "org-owner",
  "project:create": "org-owner",

  // Session-scoped, public, or a clock: `none` is correct, not an omission.
  status: "none",
  health: "none",
  swagger: "none",
  "actions:permissions": "none",
  "user:create": "none",
  "user:edit": "none",
  "session:create": "none",
  "session:destroy": "none",
  "me:view": "none",
  "organization:create": "none",
  "organization:list": "none",
  "project:list": "none",
  "invite:list-pending": "none",
  "invite:accept": "none",
  "invite:reject": "none",
  "email-verification:confirm": "none",
  "email-verification:resend": "none",
  "notification:list": "none",
  "notification:unread-count": "none",
  "notification:mark-read": "none",
  "notifications:dispatch": "none",
  "notifications:sweep": "none",
  "invites:sweep": "none",
  "audit:sweep": "none",
  // The agent loop's machine work: task-only, no route, no caller.
  "agent:tick": "none",
  "agents:reap": "none",
  "agents:wake-due": "none",
  "conversation:compact": "none",
  "outbox:deliver": "none",
  "outbox:deliver-due": "none",
  // The CLI's sign-in: a person's own browser hops, its unauthenticated
  // ingress, and their own sign-ins.
  "cli-auth:approve": "none",
  "cli-auth:activate": "none",
  "cli-auth:device": "none",
  "cli-auth:exchange": "none",
  "cli-token:list": "none",
  "cli-token:revoke": "none",
};

/**
 * Actions that accept a tenant id and correctly declare `none`: each takes it
 * as a **filter** over rows that are already the caller's own, never as the
 * thing that decides whose rows they are. An explicit list, so adding one is a
 * deliberate act with a reviewer attached.
 */
const SESSION_SCOPED_TENANT_FILTERS = new Set([
  "notification:list",
  "notification:unread-count",
  "notification:mark-read",
  "project:list",
]);

/** Every clock: task-only, never an HTTP route. */
const CLOCKS = [
  "agents:reap",
  "agents:wake-due",
  "outbox:deliver-due",
  "notifications:dispatch",
  "notifications:sweep",
  "invites:sweep",
  "audit:sweep",
];

/** Every action published as an MCP tool for a person's client. */
const EXPECTED_MCP_TOOLS = [
  "audit:list",
  "bot:create",
  "bot:delete",
  "bot:edit",
  "bot:list",
  "bot:rotate-callback-secret",
  "bot:view",
  "cli-token:list",
  "cli-token:revoke",
  "conversation:cancel",
  "conversation:create",
  "conversation:entries",
  "conversation:list",
  "conversation:message",
  "conversation:view",
  "email-verification:resend",
  "invite:accept",
  "invite:create",
  "invite:list",
  "invite:list-pending",
  "invite:reject",
  "me:view",
  "membership:create",
  "membership:delete",
  "membership:list",
  "model-alias:create",
  "model-alias:delete",
  "model-alias:edit",
  "model-alias:list",
  "model-connection:create",
  "model-connection:delete",
  "model-connection:edit",
  "model-connection:list",
  "model-connection:models",
  "model-connection:test",
  "model-connection:view",
  "notification:list",
  "notification:mark-read",
  "notification:unread-count",
  "organization-membership:delete",
  "organization-membership:edit",
  "organization-membership:list",
  "organization:audit-list",
  "organization:create",
  "organization:delete",
  "organization:edit",
  "organization:invite-list",
  "organization:list",
  "organization:view",
  "project:create",
  "project:delete",
  "project:edit",
  "project:list",
  "project:settings-view",
  "project:view",
  "tag:create",
  "tag:delete",
  "tag:edit",
  "tag:list",
  "user-tag:assign",
  "user-tag:remove",
  "user:edit",
];

let u: TestUniverse;

beforeAll(async () => {
  u = await buildTestUniverse();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * The live registry's named actions. The action glob loads every export under
 * `actions/`, and a stray helper export would land with no name.
 * @returns Every registered action that has a name.
 */
function namedActions() {
  return api.actions.actions.filter((a) => typeof a?.name === "string");
}

/**
 * The live `actions:permissions` answer, flattened to name → level.
 * @returns The reported levels.
 */
async function reportedLevels(): Promise<Record<string, string>> {
  const { status, body } = await call<ActionResponse<ActionsPermissions>>(
    u.url,
    null,
    "GET",
    "/actions/permissions",
  );
  expect(status).toBe(200);
  return Object.fromEntries(
    Object.entries(body.permissions).map(([name, r]) => [name, r.type]),
  );
}

describe("actions:permissions", () => {
  test("needs no auth, and reports exactly the five levels", async () => {
    const levels = new Set(Object.values(await reportedLevels()));
    expect([...levels].sort()).toEqual([...RBAC_LEVELS].sort());
  });

  test("reports exactly the expected level for every action", async () => {
    expect(await reportedLevels()).toEqual(EXPECTED_LEVELS);
  });

  test("clocks are task-only, and every recurring task is a listed clock", () => {
    for (const name of CLOCKS) {
      const action = api.actions.actions.find((a) => a.name === name);
      expect(action?.web?.route, name).toBeUndefined();
      expect(action?.task?.frequency, name).toBeGreaterThan(0);
    }
    const recurring = namedActions()
      .filter((a) => (a.task?.frequency ?? 0) > 0)
      .map((a) => a.name)
      .sort();
    expect(recurring).toEqual([...CLOCKS].sort());
  });

  test("every action taking a projectId or organizationId declares a level", async () => {
    // Derived from the live registry, so an action added later that accepts a
    // tenant id but forgets its RBAC middleware fails here rather than ships.
    const levels = await reportedLevels();
    for (const action of namedActions()) {
      const shape = (
        action.inputs as unknown as { shape?: Record<string, unknown> }
      )?.shape;
      if (!shape || !("projectId" in shape || "organizationId" in shape)) {
        continue;
      }
      if (SESSION_SCOPED_TENANT_FILTERS.has(action.name)) continue;
      expect(levels[action.name], action.name).not.toBe("none");
    }
  });

  test("the session-scoped exceptions really are scoped to the session", () => {
    // Sound only because the tenant id narrows the caller's own rows: they sit
    // behind `SessionMiddleware`, and none accepts a `userId` — the moment one
    // did, a param would be choosing whose rows they are.
    for (const name of SESSION_SCOPED_TENANT_FILTERS) {
      const action = api.actions.actions.find((a) => a.name === name);
      expect(action?.middleware ?? [], name).toContain(SessionMiddleware);
      const shape = (
        action?.inputs as unknown as { shape?: Record<string, unknown> }
      )?.shape;
      expect(shape && "userId" in shape, name).toBe(false);
    }
  });
});

describe("MCP publish policy", () => {
  test("every action's live mcp.tool flag equals the policy function", () => {
    for (const action of namedActions()) {
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
    expect(published).toEqual([...EXPECTED_MCP_TOOLS].sort());
  });

  test("the never-lists are exactly the declared sets", () => {
    expect([...NEVER_MCP_ACTION_NAMES].sort()).toEqual(
      [
        "actions:permissions",
        "bot:avatar",
        "cli-auth:activate",
        "cli-auth:approve",
        "cli-auth:device",
        "cli-auth:exchange",
        "email-verification:confirm",
        "health",
        "sandbox:git-credential",
        "session:create",
        "session:destroy",
        "status",
        "swagger",
        "user:create",
      ].sort(),
    );
    expect([...NEVER_MCP_PREFIXES].sort()).toEqual([
      "proxy:",
      "sandbox:",
      "webhooks:",
    ]);
  });

  test("machine families are refused by prefix, before any member exists", () => {
    const routed = (name: string) => ({ name, web: { route: "/x" } });
    for (const name of [
      "webhooks:slack",
      "sandbox:heartbeat",
      "proxy:model",
      "cli-auth:exchange",
    ]) {
      expect(shouldPublishAsMcpTool(routed(name)), name).toBe(false);
    }
    expect(shouldPublishAsMcpTool(routed("bot:list"))).toBe(true);
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
  test("an outsider is refused a member-level action, a member is not", async () => {
    const outsider = await call(
      u.url,
      u.bowser,
      "GET",
      `/project/${u.projectId}`,
    );
    expect(outsider.status).toBe(403);
    const member = await call(u.url, u.toad, "GET", `/project/${u.projectId}`);
    expect(member.status).toBe(200);
  });

  test("a member without the admin tag is refused an admin-level action", async () => {
    const res = await call(
      u.url,
      u.mario,
      "PUT",
      `/project/${u.projectId}/tag`,
      {
        name: "plumbers",
      },
    );
    expect(res.status).toBe(403);
    expect(res.body.error?.message).toContain("admin");
    const admin = await call(
      u.url,
      u.peach,
      "PUT",
      `/project/${u.projectId}/tag`,
      {
        name: "plumbers",
      },
    );
    expect(admin.status).toBe(200);
  });

  test("a signed-out caller is 401, not 403", async () => {
    const res = await call(u.url, null, "GET", `/project/${u.projectId}`);
    expect(res.status).toBe(401);
  });

  test("standing in one project grants nothing in another", async () => {
    // Bowser administers his own project and owns his own organization; neither
    // reaches into the Mushroom Kingdom.
    const own = await call(
      u.url,
      u.bowser,
      "PUT",
      `/project/${u.bowser.projectId}/tag`,
      {
        name: "koopas",
      },
    );
    expect(own.status).toBe(200);
    const theirs = await call(
      u.url,
      u.bowser,
      "PUT",
      `/project/${u.projectId}/tag`,
      {
        name: "koopas",
      },
    );
    expect(theirs.status).toBe(403);
  });

  test("project:view answers standing, so no client has to know the tag is called 'admin'", async () => {
    const admin = await call<ActionResponse<ProjectView>>(
      u.url,
      u.peach,
      "GET",
      `/project/${u.projectId}`,
    );
    expect(admin.body.standing).toEqual({
      isMember: true,
      isAdmin: true,
      viaOrganizationOwner: false,
    });
    expect(
      admin.body.callerTags.find((t) => t.name === ADMIN_TAG)?.reserved,
    ).toBe(true);

    const member = await call<ActionResponse<ProjectView>>(
      u.url,
      u.toad,
      "GET",
      `/project/${u.projectId}`,
    );
    expect(member.body.standing).toEqual({
      isMember: true,
      isAdmin: false,
      viaOrganizationOwner: false,
    });
    expect(member.body.callerTags).toEqual([]);
  });

  test("an id past what a serial column holds is a validation error, not a 500", async () => {
    for (const path of ["/project/3000000000", "/organization/3000000000"]) {
      const res = await call(u.url, u.bowser, "GET", path);
      expect(res.status, path).toBe(406);
      expect(res.body.error?.message, path).not.toContain("select");
    }
  });

  test("a non-numeric projectId is a validation error, not a 500", async () => {
    const res = await call(u.url, u.peach, "GET", "/project/castle/tags");
    expect(res.status).toBe(406);
  });
});

describe("one refusal for 'no such tenant' and 'not yours'", () => {
  /**
   * A refusal with its per-request noise removed.
   * @param res - What `call` returned.
   * @returns Status, message, and type.
   */
  function refusal(res: { status: number; body: { error?: unknown } }) {
    const { message, type } = res.body.error as {
      message: string;
      type: string;
    };
    return { status: res.status, message, type };
  }

  test("a project that does not exist and one you are not in read the same", async () => {
    const missing = await call(u.url, u.bowser, "GET", "/project/999999");
    const notYours = await call(
      u.url,
      u.bowser,
      "GET",
      `/project/${u.projectId}`,
    );
    expect(refusal(missing)).toEqual(refusal(notYours));
    expect(missing.status).toBe(403);
  });

  test("an organization that does not exist and one you are not in read the same", async () => {
    const missing = await call(u.url, u.bowser, "GET", "/organization/999999");
    const notYours = await call(
      u.url,
      u.bowser,
      "GET",
      `/organization/${u.organizationId}`,
    );
    expect(refusal(missing)).toEqual(refusal(notYours));
    expect(missing.status).toBe(403);
  });
});
