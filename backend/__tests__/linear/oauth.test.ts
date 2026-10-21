import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, desc, eq } from "drizzle-orm";
import { type ActionResponse, api } from "keryx";
import type { IntegrationConnect } from "../../actions/integration/integration-connect";
import type { IntegrationView } from "../../actions/integration/integration-view";
import { LINEAR_SCOPES } from "../../config/linear";
import { sha256Hex } from "../../ops/CliTokenOps";
import { parseScopes } from "../../ops/LinearOAuthOps";
import { auditLogs } from "../../schema/audit_logs";
import {
  authHeaders,
  buildTestUniverse,
  cookieHeader,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import { FINEAR_FIXTURES, useFinear } from "./finear";
import { appToken, integrationRow, refreshTokenOf } from "./helpers";

let universe: TestUniverse;
let url: string;
beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

/**
 * `integration:connect` as someone, answered raw.
 * @param projectId - The project.
 * @param sessionId - Who asks.
 * @returns Status and body.
 */
async function connect(projectId: number, sessionId: string) {
  const res = await fetch(
    `${url}/api/integration/connect?projectId=${projectId}&type=linear`,
    {
      headers: cookieHeader(sessionId),
    },
  );
  return {
    status: res.status,
    body: (await res.json()) as Record<string, any>,
  };
}

/**
 * `integration:view` for a project.
 * @param projectId - The project.
 * @param sessionId - Who asks.
 * @returns The response body.
 */
async function integrationView(projectId: number, sessionId: string) {
  const res = await fetch(
    `${url}/api/integration?projectId=${projectId}&type=linear`,
    { headers: cookieHeader(sessionId) },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ActionResponse<IntegrationView>;
}

/**
 * Whether an access token still works at finear.
 * @param token - The token.
 * @returns True when `viewer` answers.
 */
async function tokenWorks(token: string): Promise<boolean> {
  const reply = await linear.graphql(`Bearer ${token}`, "{ viewer { id } }");
  return reply.status === 200 && !reply.errors;
}

describe("integration:connect", () => {
  test("LC-OAUTH-01 LC-OAUTH-02 LC-OAUTH-10 LC-OAUTH-11 LC-BP-09 an admin gets an actor=app authorize URL with PKCE and prompt=consent", async () => {
    const { status, body } = await connect(
      universe.projectId,
      universe.peach.sessionId,
    );
    expect(status).toBe(200);
    const { authorizeUrl, expiresIn } =
      body as ActionResponse<IntegrationConnect>;
    expect(expiresIn).toBe(600);
    const authorize = new URL(authorizeUrl);
    expect(authorize.origin + authorize.pathname).toBe(
      `${linear.url()}/oauth/authorize`,
    );
    const q = authorize.searchParams;
    expect(Object.fromEntries(q)).toEqual({
      client_id: "hypotenuse-test-client",
      redirect_uri: `${url}/api/linear/callback`,
      response_type: "code",
      scope:
        "read,write,app:assignable,app:mentionable,issues:create,comments:create",
      state: q.get("state")!,
      actor: "app",
      prompt: "consent",
      code_challenge: q.get("code_challenge")!,
      code_challenge_method: "S256",
    });
    expect(q.get("state")!.length).toBeGreaterThanOrEqual(43);
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  test("LC-OAUTH-04 LC-OAUTH-05 LC-OAUTH-06 LC-OAUTH-07 LC-OAUTH-08 LC-OAUTH-09 the six scopes, and none Hypotenuse does not need", () => {
    expect([...LINEAR_SCOPES]).toEqual([
      "read",
      "write",
      "app:assignable",
      "app:mentionable",
      "issues:create",
      "comments:create",
    ]);
    // `admin` cannot be combined with actor=app; the rest are least privilege.
    for (const scope of [
      "admin",
      "timeSchedule:write",
      "customer:read",
      "customer:write",
      "initiative:read",
      "initiative:write",
    ]) {
      expect(LINEAR_SCOPES as readonly string[]).not.toContain(scope);
    }
  });

  test("LC-OAUTH-18 no client_credentials grant is ever requested", async () => {
    // Every token request in this file's life is authorization_code or
    // refresh_token; the deployment never asks for an app-wide token.
    await linear.install(universe.mario.projectId, universe.mario.sessionId, {
      fixture: "secondary",
    });
    const grants = linear
      .requests()
      .filter((r) => r.path === "/oauth/token")
      .map((r) => r.grantType);
    expect(grants.length).toBeGreaterThan(0);
    expect(grants.every((g) => g === "authorization_code")).toBe(true);
  });

  test("a member without the admin tag is refused, and an outsider is refused exactly as for a missing project", async () => {
    expect(
      (await connect(universe.projectId, universe.mario.sessionId)).status,
    ).toBe(403);
    const outsider = await connect(
      universe.projectId,
      universe.bowser.sessionId,
    );
    const missing = await connect(999_999, universe.bowser.sessionId);
    expect(outsider.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(outsider.body.error.message).toBe(missing.body.error.message);
    expect(outsider.body.error.type).toBe(missing.body.error.type);
  });

  test("a signed-out caller is 401", async () => {
    const res = await fetch(
      `${url}/api/integration/connect?projectId=${universe.projectId}&type=linear`,
    );
    expect(res.status).toBe(401);
  });
});

describe("linear:callback", () => {
  test("a declined consent redirects with error=denied and stores nothing", async () => {
    const callbackUrl = await linear.authorize(
      universe.projectId,
      universe.peach.sessionId,
      { decision: "deny" },
    );
    const landed = await linear.callback(callbackUrl, universe.peach.sessionId);
    expect(landed.searchParams.get("error")).toBe("denied");
    expect(
      (await integrationView(universe.projectId, universe.peach.sessionId))
        .integration,
    ).toBeNull();
  });

  test("LC-OAUTH-12 LC-OAUTH-19 LC-OAUTH-20 LC-DEL-06 LC-WH-08 the full flow stores an active integration as the app user", async () => {
    linear.clearRequests();
    const landed = await linear.install(
      universe.projectId,
      universe.peach.sessionId,
    );
    expect(landed.toString()).toBe(
      `http://localhost:3000/settings/integrations?type=linear&connected=1&projectId=${universe.projectId}`,
    );
    const sentByServer = linear
      .requests()
      .filter((r) => r.path === "/graphql")
      .map((r) => r.operationName);

    const token = await appToken(universe.projectId);
    const viewer = await linear.graphql<{ viewer: { id: string } }>(
      `Bearer ${token}`,
      "{ viewer { id } }",
    );
    const { integration: view, configured } = await integrationView(
      universe.projectId,
      universe.toad.sessionId,
    );
    expect(configured).toBe(true);
    expect(view).toMatchObject({
      projectId: universe.projectId,
      type: "linear",
      externalWorkspaceId: FINEAR_FIXTURES.primary.organization,
      workspaceName: "Workspace 1",
      workspaceUrlKey: "eng",
      externalAppUserId: viewer.data!.viewer.id,
      appUserName: "Hypotenuse",
      details: {
        appUserCapabilities: {
          app: true,
          isAssignable: true,
          isMentionable: true,
          supportsAgentSessions: true,
        },
        teamIds: [FINEAR_FIXTURES.primary.team],
        canAccessAllPublicTeams: false,
      },
      status: "active",
      connectedByUserId: universe.peach.userId,
      refreshError: null,
    });
    expect([...view!.scopes].sort()).toEqual([...LINEAR_SCOPES].sort());
    expect(view!.externalAppUserId).not.toBe(FINEAR_FIXTURES.primary.user);
    expect(view!.accessTokenLastFour).toBe(token.slice(-4));
    // Linear's 24-hour token, give or take the request.
    expect(view!.accessTokenExpiresAt! - Date.now()).toBeGreaterThan(
      23 * 60 * 60 * 1000,
    );

    // Webhooks come from the app's own configuration, never from a
    // webhookCreate on install.
    expect(sentByServer).toEqual(["GetInstallationIdentity"]);
  });

  test("tokens are sealed at rest, and no API answer has a field one fits in", async () => {
    const row = await integrationRow(universe.projectId);
    const access = await appToken(universe.projectId);
    const refresh = await refreshTokenOf(universe.projectId);
    expect(JSON.stringify(row.accessTokenEncrypted)).not.toContain(access);
    expect(JSON.stringify(row.refreshTokenEncrypted)).not.toContain(refresh);

    const body = await integrationView(
      universe.projectId,
      universe.peach.sessionId,
    );
    const text = JSON.stringify(body);
    expect(text).not.toContain(access);
    expect(text).not.toContain(refresh);
    expect(Object.keys(body.integration!).sort()).toEqual(
      [
        "id",
        "projectId",
        "type",
        "externalWorkspaceId",
        "workspaceName",
        "workspaceUrlKey",
        "externalAppUserId",
        "appUserName",
        "details",
        "scopes",
        "status",
        "accessTokenLastFour",
        "accessTokenExpiresAt",
        "connectedAt",
        "lastRefreshedAt",
        "refreshFailedAt",
        "refreshError",
        "rateLimit",
        "connectedByUserId",
        "createdAt",
        "updatedAt",
      ].sort(),
    );
  });

  test("the audit row records the decision and none of the secrets", async () => {
    const [row] = await api.db.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "linear:callback"),
          eq(auditLogs.projectId, universe.projectId),
        ),
      )
      .orderBy(desc(auditLogs.id))
      .limit(1);
    expect(row).toBeDefined();
    expect(row.userId).toBe(universe.peach.userId);
    expect(row.targetType).toBe("integration");
    expect(row.targetPath).toBe("linear:eng");
    expect(row.metadata).toEqual({
      type: "linear",
      externalWorkspaceId: FINEAR_FIXTURES.primary.organization,
      reconnect: false,
      seededRoutingRules: ["/manage", "/work"],
    });
    const text = JSON.stringify(row);
    expect(text).not.toContain(await appToken(universe.projectId));
    expect(text).not.toContain(await refreshTokenOf(universe.projectId));
    expect(text).not.toContain("ciphertext");
  });

  test("a replayed callback is refused: state is single-use", async () => {
    const callbackUrl = await linear.authorize(
      universe.projectId,
      universe.peach.sessionId,
    );
    const first = await linear.callback(callbackUrl, universe.peach.sessionId);
    expect(first.searchParams.get("connected")).toBe("1");
    const again = await linear.callback(callbackUrl, universe.peach.sessionId);
    expect(again.searchParams.get("error")).toBe("state_expired");
  });

  test("a callback lured into another person's browser attaches nothing, and burns the state", async () => {
    const before = await integrationRow(universe.projectId);
    const callbackUrl = await linear.authorize(
      universe.projectId,
      universe.peach.sessionId,
    );
    const lured = await linear.callback(callbackUrl, universe.bowser.sessionId);
    expect(lured.searchParams.get("error")).toBe("state_mismatch");
    const signedOut = await linear.callback(callbackUrl, null);
    expect(signedOut.searchParams.get("error")).toBe("state_expired");
    const after = await integrationRow(universe.projectId);
    expect(after.accessTokenEncrypted).toEqual(before.accessTokenEncrypted);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  test("an expired state redirects with error=state_expired", async () => {
    const callbackUrl = await linear.authorize(
      universe.projectId,
      universe.peach.sessionId,
    );
    const state = new URL(callbackUrl).searchParams.get("state")!;
    // EXPIRE 0 is Redis expiring the key now: the TTL, not a wait.
    await api.redis.redis.expire(`linear:oauth:state:${sha256Hex(state)}`, 0);
    const landed = await linear.callback(callbackUrl, universe.peach.sessionId);
    expect(landed.searchParams.get("error")).toBe("state_expired");
  });

  test("reconnecting replaces the tokens on the same row", async () => {
    const before = await integrationRow(universe.projectId);
    const landed = await linear.install(
      universe.projectId,
      universe.peach.sessionId,
    );
    expect(landed.searchParams.get("connected")).toBe("1");
    const after = await integrationRow(universe.projectId);
    expect(after.id).toBe(before.id);
    expect(after.externalAppUserId).toBe(before.externalAppUserId);
    // Only a completed install moves connectedAt; a client waiting on a
    // connect watches it.
    expect(after.connectedAt.getTime()).toBeGreaterThan(
      before.connectedAt.getTime(),
    );
    expect(after.accessTokenEncrypted).not.toEqual(before.accessTokenEncrypted);
    expect(after.status).toBe("active");
  });

  test("a different workspace on reconnect is refused until the project disconnects", async () => {
    const landed = await linear.install(
      universe.projectId,
      universe.peach.sessionId,
      { fixture: "secondary" },
    );
    expect(landed.searchParams.get("error")).toBe("workspace_changed");
    expect((await integrationRow(universe.projectId)).externalWorkspaceId).toBe(
      FINEAR_FIXTURES.primary.organization,
    );
  });

  test("a second project connecting the same workspace is refused, and the first keeps working", async () => {
    const token = await appToken(universe.projectId);
    const landed = await linear.install(
      universe.bowser.projectId,
      universe.bowser.sessionId,
    );
    expect(landed.searchParams.get("error")).toBe("workspace_taken");
    // The redirect names the condition, never the other project.
    expect([...landed.searchParams.keys()]).toEqual(["type", "error"]);
    expect(
      (
        await integrationView(
          universe.bowser.projectId,
          universe.bowser.sessionId,
        )
      ).integration,
    ).toBeNull();
    expect(await tokenWorks(token)).toBe(true);
    expect((await integrationRow(universe.projectId)).status).toBe("active");
  });

  test("LC-OAUTH-17 granted scopes parse from a string or an array", () => {
    expect(parseScopes("read write app:assignable")).toEqual([
      "read",
      "write",
      "app:assignable",
    ]);
    expect(parseScopes("read,write")).toEqual(["read", "write"]);
    expect(parseScopes(["read", "write", "read"])).toEqual(["read", "write"]);
    expect(parseScopes(undefined)).toEqual([]);
  });
});

describe("integration:view", () => {
  test("answers null for a project that never connected; an outsider is refused", async () => {
    const res = await fetch(
      `${url}/api/integration?projectId=${universe.toad.projectId}&type=linear`,
      { headers: cookieHeader(universe.toad.sessionId) },
    );
    expect(await res.json()).toEqual({ integration: null, configured: true });
    const outsider = await fetch(
      `${url}/api/integration?projectId=${universe.projectId}&type=linear`,
      { headers: cookieHeader(universe.bowser.sessionId) },
    );
    expect(outsider.status).toBe(403);
  });
});

describe("integration:disconnect", () => {
  /**
   * `integration:disconnect` as someone.
   * @param projectId - The project.
   * @param sessionId - Who asks.
   * @returns The response.
   */
  const disconnect = (projectId: number, sessionId: string) =>
    fetch(`${url}/api/integration`, {
      method: "DELETE",
      headers: authHeaders(sessionId),
      body: JSON.stringify({ projectId, type: "linear" }),
    });

  test("a member without the admin tag is refused", async () => {
    expect(
      (await disconnect(universe.projectId, universe.mario.sessionId)).status,
    ).toBe(403);
  });

  test("LC-OAUTH-16 revokes both tokens at Linear, forgets them, and frees the workspace", async () => {
    const access = await appToken(universe.projectId);
    const before = await integrationRow(universe.projectId);
    linear.clearRequests();

    const res = await disconnect(universe.projectId, universe.peach.sessionId);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { integration: { status: string } };
    expect(body.integration.status).toBe("revoked");

    // Both were sent; the second one finds the install already revoked (400),
    // which is success.
    expect(
      linear.requests().filter((r) => r.path === "/oauth/revoke").length,
    ).toBe(2);
    expect(await tokenWorks(access)).toBe(false);

    const row = await integrationRow(universe.projectId);
    expect(row.id).toBe(before.id);
    expect(row.status).toBe("revoked");
    expect(row.accessTokenEncrypted).toBeNull();
    expect(row.refreshTokenEncrypted).toBeNull();
    expect(row.accessTokenLastFour).toBe("");

    // The partial unique index lets the workspace connect elsewhere now.
    const landed = await linear.install(
      universe.bowser.projectId,
      universe.bowser.sessionId,
    );
    expect(landed.searchParams.get("connected")).toBe("1");
    const moved = await integrationRow(universe.bowser.projectId);
    expect(moved.externalWorkspaceId).toBe(
      FINEAR_FIXTURES.primary.organization,
    );
    expect(moved.externalAppUserId).not.toBe(before.externalAppUserId);
  });

  test("disconnecting a project that is not connected is a 404", async () => {
    expect(
      (await disconnect(universe.projectId, universe.peach.sessionId)).status,
    ).toBe(404);
  });

  test("the revoked row can reconnect to a free workspace and keeps its id", async () => {
    const before = await integrationRow(universe.projectId);
    // Mario's project holds the secondary workspace; free it first.
    expect(
      (await disconnect(universe.mario.projectId, universe.mario.sessionId))
        .status,
    ).toBe(200);
    const landed = await linear.install(
      universe.projectId,
      universe.peach.sessionId,
      { fixture: "secondary" },
    );
    expect(landed.searchParams.get("connected")).toBe("1");
    const after = await integrationRow(universe.projectId);
    expect(after.id).toBe(before.id);
    expect(after.status).toBe("active");
    expect(after.externalWorkspaceId).toBe(
      FINEAR_FIXTURES.secondary.organization,
    );
  });
});
