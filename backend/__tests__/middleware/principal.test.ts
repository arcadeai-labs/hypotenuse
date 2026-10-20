import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, HTTP_METHOD } from "keryx";
import { principalRefusal } from "../../middleware/session";
import { INVALID_TOKEN_MESSAGE } from "../../ops/CliTokenOps";
import {
  bearerHeaders,
  buildTestUniverse,
  type CliSignIn,
  cliSignIn,
  cookieHeader,
  getMcpAccessToken,
  HOOK_TIMEOUT,
  TEST_PASSWORD,
  type TestUniverse,
} from "../setup";

let universe: TestUniverse;
let url: string;
let peachCli: CliSignIn;

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
  peachCli = await cliSignIn(url, universe.peach);
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("one principal per request", () => {
  test("every read answers a CLI token exactly as it answers its person's session", async () => {
    // Iterated over the live registry, not a sample: a read that forgot to go
    // through the session (or read a cookie directly) would differ here.
    const reads = api.actions.actions.filter(
      (a) =>
        typeof a.name === "string" &&
        typeof a.web?.route === "string" &&
        a.web.method === HTTP_METHOD.GET &&
        !a.web.route.includes(":"),
    );
    expect(reads.length).toBeGreaterThan(10);

    const differences: string[] = [];
    for (const action of reads) {
      const query = `?projectId=${universe.projectId}`;
      const target = `${url}/api${action.web!.route}${query}`;
      // A browser hop answers a redirect to the dashboard; its status is the
      // answer, and the dashboard is not running here.
      const [asSession, asCli] = await Promise.all([
        fetch(target, {
          headers: cookieHeader(universe.peach.sessionId),
          redirect: "manual",
        }),
        fetch(target, {
          headers: bearerHeaders(peachCli.token),
          redirect: "manual",
        }),
      ]);
      if (asSession.status !== asCli.status) {
        differences.push(
          `${action.name}: session ${asSession.status}, cli ${asCli.status}`,
        );
      }
    }
    expect(differences).toEqual([]);
  });

  test("a runner-shaped token is refused on a human action", async () => {
    const res = await fetch(`${url}/api/projects`, {
      headers: bearerHeaders(`hyp_rt_${"a".repeat(43)}`),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe(INVALID_TOKEN_MESSAGE);
  });

  test("a CLI token is refused on every daemon action", () => {
    const cli = { kind: "cli" as const, userId: 1, cliTokenId: 1 };
    for (const name of ["daemon:heartbeat", "daemon:connect", "daemon:x"]) {
      expect(principalRefusal(cli, name)?.message, name).toBe(
        "A CLI sign-in cannot call daemon actions",
      );
    }
    // The human runner ledger is not the daemon family.
    expect(principalRefusal(cli, "runner:list")).toBeNull();
    expect(principalRefusal(cli, "project:list")).toBeNull();
    expect(
      principalRefusal({ kind: "session", userId: 1 }, "project:list"),
    ).toBeNull();
  });

  test("Keryx's own OAuth bearer tokens are not judged as CLI tokens", async () => {
    // A human MCP client's token is Keryx's to verify on /mcp; on the HTTP API
    // it is simply not a credential, so the caller is signed out — not told
    // their CLI sign-in is bad.
    const oauth = await getMcpAccessToken(
      url,
      universe.toad.email,
      TEST_PASSWORD,
    );
    const res = await fetch(`${url}/api/me`, {
      headers: bearerHeaders(oauth),
    });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("Session not found");
  });
});
