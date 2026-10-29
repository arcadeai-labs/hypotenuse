import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { api } from "keryx";
import { sha256Hex } from "../../ops/CliTokenOps";
import { auditLogs } from "../../schema/audit_logs";
import { cliTokens } from "../../schema/cli_tokens";
import {
  authHeaders,
  bearerHeaders,
  buildTestUniverse,
  cliSignIn,
  computeS256Challenge,
  cookieHeader,
  HOOK_TIMEOUT,
  randomString,
  type TestUniverse,
} from "../setup";

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
 * Approve a fresh PKCE challenge as a user.
 * @param sessionId - The approving browser session.
 * @param device - The device name.
 * @returns The verifier, and the parsed response with its status.
 */
async function approve(sessionId: string, device = "peach-mbp") {
  const codeVerifier = randomString(64);
  const codeChallenge = await computeS256Challenge(codeVerifier);
  const res = await fetch(`${url}/api/cli-auth/approve`, {
    method: "PUT",
    headers: authHeaders(sessionId),
    body: JSON.stringify({ codeChallenge, device }),
  });
  const body = (await res.json()) as { code: string; expiresIn: number };
  return { codeVerifier, status: res.status, ...body };
}

/**
 * POST to `cli-auth:exchange`.
 * @param body - The exchange body.
 * @returns Status and parsed JSON.
 */
async function exchange(body: Record<string, unknown>) {
  const res = await fetch(`${url}/api/cli-auth/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as {
      status?: string;
      token?: string | null;
      cliToken?: { id: number; device: string; expiresAt: number } | null;
      error?: { message: string; type: string; key?: string };
    },
  };
}

/**
 * An error body without its timestamp, which Keryx makes differ between two
 * otherwise identical refusals, and without the stack it adds outside
 * production.
 * @param res - The response.
 * @returns Status and the error minus `timestamp`.
 */
async function refusal(res: Response) {
  const body = (await res.json()) as { error: Record<string, unknown> };
  const { timestamp: _t, stack: _s, ...rest } = body.error;
  return { status: res.status, error: rest };
}

describe("loopback + PKCE", () => {
  test("approve → exchange issues a token that is its person", async () => {
    const approved = await approve(universe.peach.sessionId);
    expect(approved.status).toBe(200);
    expect(approved.expiresIn).toBe(60);

    const { status, body } = await exchange({
      code: approved.code,
      codeVerifier: approved.codeVerifier,
    });
    expect(status).toBe(200);
    expect(body.status).toBe("approved");
    expect(body.token).toMatch(/^hyp_cli_[0-9A-Za-z]{43}$/);
    expect(body.cliToken?.device).toBe("peach-mbp");

    const me = await fetch(`${url}/api/me`, {
      headers: bearerHeaders(body.token!),
    });
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as { user: { email: string } };
    expect(meBody.user.email).toBe(universe.peach.email);
  });

  test("the plaintext is never stored: only its sha256 and last four", async () => {
    const { token, cliTokenId } = await cliSignIn(url, universe.peach);
    const [row] = await api.db.db
      .select()
      .from(cliTokens)
      .where(eq(cliTokens.id, cliTokenId));
    expect(row.tokenHash).toBe(sha256Hex(token));
    expect(row.lastFour).toBe(token.slice(-4));
    expect(JSON.stringify(row)).not.toContain(token);
    // 90 days out, give or take the test's own runtime.
    const days = (row.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89.9);
    expect(days).toBeLessThanOrEqual(90);
  });

  test("a code is single-use", async () => {
    const approved = await approve(universe.peach.sessionId);
    const first = await exchange({
      code: approved.code,
      codeVerifier: approved.codeVerifier,
    });
    expect(first.status).toBe(200);
    const second = await exchange({
      code: approved.code,
      codeVerifier: approved.codeVerifier,
    });
    expect(second.status).toBe(406);
  });

  test("a wrong verifier, an unknown code, and a reused code are one refusal", async () => {
    const approved = await approve(universe.peach.sessionId);
    const wrong = await exchange({
      code: approved.code,
      codeVerifier: randomString(64),
    });
    // The wrong verifier burned the code: the right one is now refused too.
    const burned = await exchange({
      code: approved.code,
      codeVerifier: approved.codeVerifier,
    });
    const unknown = await exchange({
      code: "nope",
      codeVerifier: randomString(64),
    });
    for (const r of [wrong, burned, unknown]) {
      expect(r.status).toBe(406);
      const {
        timestamp: _t,
        stack: _s,
        ...rest
      } = r.body.error as Record<string, unknown>;
      expect(rest).toEqual({
        message: "This sign-in code is invalid or expired",
        type: "CONNECTION_ACTION_PARAM_VALIDATION",
        key: "code",
      });
    }
  });

  test("a code lives 60 seconds", async () => {
    const approved = await approve(universe.peach.sessionId);
    const key = `cli-auth:code:${sha256Hex(approved.code)}`;
    const ttl = await api.redis.redis.ttl(key);
    expect(ttl).toBeGreaterThan(55);
    expect(ttl).toBeLessThanOrEqual(60);

    // Expire it by writing the TTL, not by waiting a minute.
    await api.redis.redis.pexpire(key, 1);
    await Bun.sleep(5);
    const { status } = await exchange({
      code: approved.code,
      codeVerifier: approved.codeVerifier,
    });
    expect(status).toBe(406);
  });

  test("Redis holds the code's hash, never the code", async () => {
    const approved = await approve(universe.peach.sessionId);
    const keys = await api.redis.redis.keys("cli-auth:*");
    expect(keys.join(" ")).not.toContain(approved.code);
    const stored = await Promise.all(
      keys.map((k) => api.redis.redis.get(k).catch(() => "")),
    );
    expect(stored.join(" ")).not.toContain(approved.code);
  });

  test("approving needs a browser session: 401 signed out, 403 from a CLI token", async () => {
    const codeChallenge = await computeS256Challenge(randomString(64));
    const signedOut = await fetch(`${url}/api/cli-auth/approve`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ codeChallenge, device: "x" }),
    });
    expect(signedOut.status).toBe(401);

    const { token } = await cliSignIn(url, universe.peach);
    const fromCli = await fetch(`${url}/api/cli-auth/approve`, {
      method: "PUT",
      headers: bearerHeaders(token),
      body: JSON.stringify({ codeChallenge, device: "x" }),
    });
    expect(fromCli.status).toBe(403);
  });

  test("approve is audited, without the challenge-bound code", async () => {
    const approved = await approve(universe.mario.sessionId, "mario-desktop");
    const rows = await api.db.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "cli-auth:approve"),
          eq(auditLogs.userId, universe.mario.userId),
        ),
      );
    expect(rows.length).toBeGreaterThan(0);
    const row = rows.at(-1)!;
    expect(row.targetPath).toBe("mario-desktop");
    expect(JSON.stringify(row)).not.toContain(approved.code);
  });

  test("a malformed exchange is a validation error", async () => {
    expect((await exchange({})).status).toBe(406);
    expect(
      (await exchange({ code: "a", codeVerifier: "b", deviceCode: "c" }))
        .status,
    ).toBe(406);
  });
});

describe("device code", () => {
  /**
   * Start a device flow.
   * @returns The device code, user code, and the rest of the answer.
   */
  async function start() {
    const res = await fetch(`${url}/api/cli-auth/device`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device: "build-box" }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as {
      deviceCode: string;
      userCode: string;
      verificationUrl: string;
      expiresIn: number;
      interval: number;
    };
  }

  test("pending until activated, then a token exactly once", async () => {
    const started = await start();
    expect(started.userCode).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
    expect(started.userCode).not.toMatch(/[AEIOULY]/);
    expect(started.verificationUrl).toEndWith("/cli/activate");
    expect(started.expiresIn).toBe(600);
    expect(started.interval).toBe(5);

    const pending = await exchange({ deviceCode: started.deviceCode });
    expect(pending.status).toBe(200);
    expect(pending.body).toEqual({
      status: "pending",
      token: null,
      cliToken: null,
    });

    // Typed lower-case and without the dash, as people do.
    const activate = await fetch(`${url}/api/cli-auth/activate`, {
      method: "POST",
      headers: authHeaders(universe.luigi.sessionId),
      body: JSON.stringify({
        userCode: started.userCode.replace("-", "").toLowerCase(),
      }),
    });
    expect(activate.status).toBe(200);
    expect(await activate.json()).toEqual({ device: "build-box" });

    const approved = await exchange({ deviceCode: started.deviceCode });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe("approved");
    const me = await fetch(`${url}/api/me`, {
      headers: bearerHeaders(approved.body.token!),
    });
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(
      universe.luigi.email,
    );

    // The grant is consumed.
    expect((await exchange({ deviceCode: started.deviceCode })).status).toBe(
      406,
    );
  });

  test("a user code activates once", async () => {
    const started = await start();
    const first = await fetch(`${url}/api/cli-auth/activate`, {
      method: "POST",
      headers: authHeaders(universe.luigi.sessionId),
      body: JSON.stringify({ userCode: started.userCode }),
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${url}/api/cli-auth/activate`, {
      method: "POST",
      headers: authHeaders(universe.bowser.sessionId),
      body: JSON.stringify({ userCode: started.userCode }),
    });
    expect(second.status).toBe(406);
    // And it was Luigi's approval that counted.
    const approved = await exchange({ deviceCode: started.deviceCode });
    const me = await fetch(`${url}/api/me`, {
      headers: bearerHeaders(approved.body.token!),
    });
    expect(((await me.json()) as { user: { email: string } }).user.email).toBe(
      universe.luigi.email,
    );
  });

  test("an unapproved device code times out", async () => {
    const started = await start();
    const key = `cli-auth:device:${sha256Hex(started.deviceCode)}`;
    const ttl = await api.redis.redis.ttl(key);
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);

    await api.redis.redis.pexpire(key, 1);
    await api.redis.redis.pexpire(`cli-auth:user-code:${started.userCode}`, 1);
    await Bun.sleep(5);
    expect((await exchange({ deviceCode: started.deviceCode })).status).toBe(
      406,
    );
    const activate = await fetch(`${url}/api/cli-auth/activate`, {
      method: "POST",
      headers: authHeaders(universe.luigi.sessionId),
      body: JSON.stringify({ userCode: started.userCode }),
    });
    expect(activate.status).toBe(406);
  });

  test("activate is audited and needs a browser session", async () => {
    const started = await start();
    const signedOut = await fetch(`${url}/api/cli-auth/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userCode: started.userCode }),
    });
    expect(signedOut.status).toBe(401);

    const { token } = await cliSignIn(url, universe.toad);
    const fromCli = await fetch(`${url}/api/cli-auth/activate`, {
      method: "POST",
      headers: bearerHeaders(token),
      body: JSON.stringify({ userCode: started.userCode }),
    });
    expect(fromCli.status).toBe(403);

    const ok = await fetch(`${url}/api/cli-auth/activate`, {
      method: "POST",
      headers: authHeaders(universe.toad.sessionId),
      body: JSON.stringify({ userCode: started.userCode }),
    });
    expect(ok.status).toBe(200);
    const rows = await api.db.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "cli-auth:activate"),
          eq(auditLogs.userId, universe.toad.userId),
        ),
      );
    expect(rows.map((r) => r.targetPath)).toContain("build-box");
  });
});

describe("the token", () => {
  test("respects membership: Bowser's token is refused Peach's project", async () => {
    const bowser = await cliSignIn(url, universe.bowser);
    const theirs = await fetch(`${url}/api/project/${universe.projectId}`, {
      headers: bearerHeaders(bowser.token),
    });
    expect(theirs.status).toBe(403);
    const own = await fetch(`${url}/api/project/${universe.bowser.projectId}`, {
      headers: bearerHeaders(bowser.token),
    });
    expect(own.status).toBe(200);

    const peach = await cliSignIn(url, universe.peach);
    const shared = await fetch(`${url}/api/project/${universe.projectId}`, {
      headers: bearerHeaders(peach.token),
    });
    expect(shared.status).toBe(200);
  });

  test("writes through a token are audited as its person", async () => {
    const { token } = await cliSignIn(url, universe.peach);
    const res = await fetch(`${url}/api/project/${universe.projectId}/tag`, {
      method: "PUT",
      headers: bearerHeaders(token),
      body: JSON.stringify({ name: "from-cli" }),
    });
    expect(res.status).toBe(200);
    const [row] = await api.db.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "tag:create"),
          eq(auditLogs.targetPath, "from-cli"),
        ),
      );
    expect(row.userId).toBe(universe.peach.userId);
  });

  test("unknown, revoked, and expired tokens get one identical 401", async () => {
    const revoked = await cliSignIn(url, universe.mario);
    const revoke = await fetch(`${url}/api/cli-token`, {
      method: "DELETE",
      headers: bearerHeaders(revoked.token),
      body: "{}",
    });
    expect(revoke.status).toBe(200);

    const expired = await cliSignIn(url, universe.mario);
    await api.db.db
      .update(cliTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(cliTokens.id, expired.cliTokenId));

    const unknown = `hyp_cli_${randomString(43).replace(/[-._~]/g, "a")}`;

    const refusals = await Promise.all(
      [revoked.token, expired.token, unknown].map(async (token) =>
        refusal(
          await fetch(`${url}/api/me`, { headers: bearerHeaders(token) }),
        ),
      ),
    );
    expect(refusals[0].status).toBe(401);
    expect(refusals[1]).toEqual(refusals[0]);
    expect(refusals[2]).toEqual(refusals[0]);
  });

  test("a bad token is refused even on a public action, so a stale CLI learns it", async () => {
    const res = await fetch(`${url}/api/status`, {
      headers: bearerHeaders("hyp_cli_nope"),
    });
    expect(res.status).toBe(401);
  });

  test("a session cookie wins over a bearer token", async () => {
    const res = await fetch(`${url}/api/me`, {
      headers: {
        ...cookieHeader(universe.toad.sessionId),
        Authorization: "Bearer hyp_cli_nope",
      },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { user: { email: string } }).user.email).toBe(
      universe.toad.email,
    );
  });

  test("expiry slides forward on use at most once a day", async () => {
    const { token, cliTokenId } = await cliSignIn(url, universe.luigi);
    const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000);
    const soon = new Date(Date.now() + 86_400_000);
    await api.db.db
      .update(cliTokens)
      .set({ lastUsedAt: twoDaysAgo, expiresAt: soon })
      .where(eq(cliTokens.id, cliTokenId));

    await fetch(`${url}/api/me`, { headers: bearerHeaders(token) });
    const [slid] = await api.db.db
      .select()
      .from(cliTokens)
      .where(eq(cliTokens.id, cliTokenId));
    expect(slid.expiresAt.getTime()).toBeGreaterThan(
      Date.now() + 89 * 86_400_000,
    );
    expect(slid.lastUsedAt!.getTime()).toBeGreaterThan(twoDaysAgo.getTime());

    // Within the day, a use writes nothing.
    await api.db.db
      .update(cliTokens)
      .set({ expiresAt: soon })
      .where(eq(cliTokens.id, cliTokenId));
    await fetch(`${url}/api/me`, { headers: bearerHeaders(token) });
    const [unchanged] = await api.db.db
      .select()
      .from(cliTokens)
      .where(eq(cliTokens.id, cliTokenId));
    expect(unchanged.expiresAt.getTime()).toBe(soon.getTime());
  });

  test("a bearer request writes no userId into any Redis session", async () => {
    const { token } = await cliSignIn(url, universe.toad);
    const res = await fetch(`${url}/api/me`, {
      headers: bearerHeaders(token),
    });
    expect(res.status).toBe(200);
    // Keryx answers a cookie-less request with a fresh anonymous session; the
    // token must not have turned it into a signed-in one.
    const cookie = res.headers.get("set-cookie") ?? "";
    const sessionId = /__session=([^;]+)/.exec(cookie)?.[1];
    expect(sessionId).toBeDefined();
    const stored = await api.redis.redis.get(`session:${sessionId}`);
    expect(stored === null || !JSON.parse(stored).data.userId).toBe(true);
    const asCookie = await fetch(`${url}/api/me`, {
      headers: cookieHeader(sessionId!),
    });
    expect(asCookie.status).toBe(401);
  });
});

describe("managing sign-ins", () => {
  test("list shows only the caller's own live sign-ins, marking the current one", async () => {
    const a = await cliSignIn(url, universe.toad, "toad-a");
    const b = await cliSignIn(url, universe.toad, "toad-b");
    await cliSignIn(url, universe.bowser, "bowser-x");

    const res = await fetch(`${url}/api/cli-tokens`, {
      headers: bearerHeaders(b.token),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cliTokens: {
        id: number;
        device: string;
        current: boolean;
        status: string;
        lastFour: string;
      }[];
      pagination: { page: number; limit: number; total: number };
    };
    const devices = body.cliTokens.map((t) => t.device);
    expect(devices).toContain("toad-a");
    expect(devices).toContain("toad-b");
    expect(devices).not.toContain("bowser-x");
    expect(body.cliTokens.find((t) => t.id === b.cliTokenId)?.current).toBe(
      true,
    );
    expect(body.cliTokens.find((t) => t.id === a.cliTokenId)?.current).toBe(
      false,
    );
    expect(body.pagination.limit).toBe(25);
    expect(JSON.stringify(body)).not.toContain("tokenHash");
    expect(JSON.stringify(body)).not.toContain(a.token);
  });

  test("revoke by id is own-only; someone else's is indistinguishable from none", async () => {
    const bowser = await cliSignIn(url, universe.bowser);
    const peachRevokesBowser = await fetch(`${url}/api/cli-token`, {
      method: "DELETE",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({ cliTokenId: bowser.cliTokenId }),
    });
    const peachRevokesNothing = await fetch(`${url}/api/cli-token`, {
      method: "DELETE",
      headers: authHeaders(universe.peach.sessionId),
      body: JSON.stringify({ cliTokenId: 999_999 }),
    });
    const first = await refusal(peachRevokesBowser);
    expect(first.status).toBe(404);
    expect(await refusal(peachRevokesNothing)).toEqual(first);

    // Bowser's token still works.
    const me = await fetch(`${url}/api/me`, {
      headers: bearerHeaders(bowser.token),
    });
    expect(me.status).toBe(200);

    // The dashboard revokes by id, and that is audited.
    const own = await fetch(`${url}/api/cli-token`, {
      method: "DELETE",
      headers: authHeaders(universe.bowser.sessionId),
      body: JSON.stringify({ cliTokenId: bowser.cliTokenId }),
    });
    expect(own.status).toBe(200);
    const after = await fetch(`${url}/api/me`, {
      headers: bearerHeaders(bowser.token),
    });
    expect(after.status).toBe(401);
    const rows = await api.db.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.action, "cli-token:revoke"),
          eq(auditLogs.userId, universe.bowser.userId),
        ),
      );
    expect(rows.length).toBe(1);
    expect(JSON.stringify(rows[0])).not.toContain(bowser.token);
  });

  test("logout (revoke with no id) revokes the calling token; a browser must name one", async () => {
    const { token } = await cliSignIn(url, universe.luigi);
    const res = await fetch(`${url}/api/cli-token`, {
      method: "DELETE",
      headers: bearerHeaders(token),
      body: "{}",
    });
    expect(res.status).toBe(200);
    expect(
      (await fetch(`${url}/api/me`, { headers: bearerHeaders(token) })).status,
    ).toBe(401);

    const browser = await fetch(`${url}/api/cli-token`, {
      method: "DELETE",
      headers: authHeaders(universe.luigi.sessionId),
      body: "{}",
    });
    expect(browser.status).toBe(406);
  });
});
