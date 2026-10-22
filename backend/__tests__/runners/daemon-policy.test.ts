import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PROTOCOL_HEADER, PROTOCOL_VERSION } from "@hypotenuse/protocol";
import { api } from "keryx";
import { principalRefusal } from "../../middleware/session";
import {
  DAEMON_ONLY_ACTION_NAMES,
  DAEMON_ROUTE_PREFIX,
} from "../../ops/DaemonPolicyOps";
import {
  bearerHeaders,
  buildTestUniverse,
  cliSignIn,
  cookieHeader,
  getMcpAccessToken,
  HOOK_TIMEOUT,
  TEST_PASSWORD,
  type TestUniverse,
} from "../setup";
import {
  connect,
  daemonHeaders,
  heartbeatBody,
  openSocket,
  registerRunner,
  sessionCookie,
  type TestRunner,
  TOOL_EXAMPLES,
} from "./helpers";

/**
 * The wall between the daemon's surface and the human one, asserted in both
 * directions over the **whole registry**, not a sample: a new action is on
 * the right side of it the day it lands, or this file fails.
 */

let universe: TestUniverse;
let url: string;
let runner: TestRunner;

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
  runner = await registerRunner(
    url,
    universe.peach,
    universe.projectId,
    "wall",
  );
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/** Every registered action with a name. */
function named() {
  return api.actions.actions.filter((a) => typeof a?.name === "string");
}

/**
 * Params that satisfy every human action's required inputs, so a request
 * reaches the principal hook — Keryx validates params before `beforeAct`.
 * Unknown keys are ignored by the non-strict human schemas.
 */
const SUPERSET = {
  name: "wall-check",
  email: "wall@mushroom.kingdom",
  password: "password123",
  inviteId: 1,
  inviteeEmail: "wall@mushroom.kingdom",
  tagId: 1,
  userId: 1,
  since: 0,
  type: "linear",
  codeChallenge: "a".repeat(43),
  userCode: "BCDF-GHJK",
  device: "wall",
  code: "code",
  codeVerifier: "a".repeat(43),
  deviceCode: "code",
  role: "worker",
  ids: [1],
  externalUserId: "wall",
  issue: "WALL-1",
};

/**
 * The body a daemon action needs to pass validation.
 * @param name - The daemon action.
 * @returns A valid body for it.
 */
function daemonBody(name: string): unknown {
  switch (name) {
    case "daemon:connect":
      return { machineId: heartbeatBody().machineId };
    case "daemon:claim":
      return {};
    case "daemon:events":
      return {
        workItemId: 1,
        events: [
          {
            eventId: crypto.randomUUID(),
            seq: 1,
            at: Date.now(),
            type: "thought",
            body: "wall",
          },
        ],
      };
    case "daemon:complete":
      return { workItemId: 1, outcome: "completed" };
    default:
      if (TOOL_EXAMPLES[name])
        return { ...TOOL_EXAMPLES[name], agentSessionId: 1 };
      return heartbeatBody();
  }
}

/**
 * An action's route with its path parameters filled in.
 * @param route - The route, e.g. `/runner/:id`.
 * @returns A concrete path.
 */
function concrete(route: string): string {
  return route.replace(/:[A-Za-z]+/g, "1");
}

describe("DAEMON_ONLY_ACTION_NAMES", () => {
  test("is exactly the registered daemon: actions", () => {
    const prefixed = named()
      .map((a) => a.name)
      .filter((n) => n.startsWith("daemon:"))
      .sort();
    expect([...DAEMON_ONLY_ACTION_NAMES].sort()).toEqual(prefixed);
  });

  test("every daemon action routes under /daemon/, and nothing else does", () => {
    for (const action of named()) {
      const route = action.web?.route;
      if (typeof route !== "string") continue;
      expect(
        route.startsWith(DAEMON_ROUTE_PREFIX),
        `${action.name} ${route}`,
      ).toBe(DAEMON_ONLY_ACTION_NAMES.has(action.name));
    }
  });

  test("the human runner ledger is not the daemon family", () => {
    for (const name of ["runner:list", "runner:revoke", "runner:register"]) {
      expect(DAEMON_ONLY_ACTION_NAMES.has(name)).toBe(false);
    }
  });
});

describe("a runner token is refused every human action", () => {
  test("over HTTP, for every routed action in the registry", async () => {
    const routed = named().filter(
      (a) =>
        typeof a.web?.route === "string" &&
        !DAEMON_ONLY_ACTION_NAMES.has(a.name),
    );
    expect(routed.length).toBeGreaterThan(40);

    const leaks: string[] = [];
    for (const action of routed) {
      const method = action.web!.method;
      const target = `${url}/api${concrete(action.web!.route as string)}`;
      const params = { ...SUPERSET, projectId: universe.projectId };
      const res = await fetch(
        method === "GET"
          ? `${target}?${new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]))}`
          : target,
        {
          method,
          headers: daemonHeaders(runner.token),
          body: method === "GET" ? undefined : JSON.stringify(params),
          redirect: "manual",
        },
      );
      const body = (await res.json().catch(() => ({}))) as {
        error?: { message?: string };
      };
      if (
        res.status !== 403 ||
        body.error?.message !== "A runner token can only call daemon actions"
      ) {
        leaks.push(`${action.name}: ${res.status} ${JSON.stringify(body)}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  test("and every task-only action, by the same policy", () => {
    const runnerPrincipal = {
      kind: "runner" as const,
      runnerId: runner.id,
      projectId: universe.projectId,
    };
    for (const action of named()) {
      const refusal = principalRefusal(runnerPrincipal, action.name);
      expect(refusal === null, action.name).toBe(
        DAEMON_ONLY_ACTION_NAMES.has(action.name),
      );
    }
  });

  test("over the runner's own WebSocket session too", async () => {
    const machineId = `sha256:${"ab".repeat(8)}`;
    const res = await connect(url, runner.token, machineId);
    expect(res.status).toBe(200);
    const s = await openSocket(url, sessionCookie(res));
    try {
      s.socket.send(
        JSON.stringify({
          messageType: "action",
          action: "project:list",
          messageId: "m1",
          params: {},
        }),
      );
      const deadline = Date.now() + 5_000;
      let answer: Record<string, unknown> | undefined;
      while (!answer && Date.now() < deadline) {
        answer = s.messages.find((m) => m.messageId === "m1");
        await Bun.sleep(20);
      }
      expect((answer?.error as { message?: string } | undefined)?.message).toBe(
        "A runner token can only call daemon actions",
      );
    } finally {
      s.socket.close();
    }
  });
});

describe("every daemon action is refused to anything but a runner", () => {
  const daemonRoutes = () =>
    named().filter((a) => DAEMON_ONLY_ACTION_NAMES.has(a.name));

  test("Peach's browser session", async () => {
    for (const action of daemonRoutes()) {
      const res = await fetch(`${url}/api${action.web!.route}`, {
        method: "POST",
        headers: {
          ...cookieHeader(universe.peach.sessionId),
          "Content-Type": "application/json",
          [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        },
        body: JSON.stringify(daemonBody(action.name)),
      });
      expect(res.status, action.name).toBe(403);
    }
  });

  test("Peach's CLI token", async () => {
    const cli = await cliSignIn(url, universe.peach);
    for (const action of daemonRoutes()) {
      const res = await fetch(`${url}/api${action.web!.route}`, {
        method: "POST",
        headers: {
          ...bearerHeaders(cli.token),
          [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        },
        body: JSON.stringify(daemonBody(action.name)),
      });
      expect(res.status, action.name).toBe(403);
    }
  });

  test("Peach's MCP token: not a tool, and not a credential over HTTP", async () => {
    const token = await getMcpAccessToken(
      url,
      universe.peach.email,
      TEST_PASSWORD,
    );
    for (const action of daemonRoutes()) {
      expect(action.mcp?.tool, action.name).toBe(false);
      const res = await fetch(`${url}/api${action.web!.route}`, {
        method: "POST",
        headers: {
          ...bearerHeaders(token),
          [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        },
        body: JSON.stringify(daemonBody(action.name)),
      });
      expect(res.status, action.name).toBe(401);
    }
    const tools = await fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });
    const text = await tools.text();
    expect(text).not.toContain("daemon");
  });

  test("nobody at all", async () => {
    for (const action of daemonRoutes()) {
      const res = await fetch(`${url}/api${action.web!.route}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
        },
        body: JSON.stringify(daemonBody(action.name)),
      });
      expect(res.status, action.name).toBe(401);
    }
  });
});
