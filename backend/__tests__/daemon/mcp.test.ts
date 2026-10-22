import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { agentSessions } from "../../schema/agent_sessions";
import { useFinear } from "../linear/finear";
import { appToken, integrationRow } from "../linear/helpers";
import { finearSession, settle } from "../linear/sessions";
import {
  delegatedSession,
  itemsOf,
  personSays,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import { DaemonHome, outbound, until } from "./helpers";

/**
 * The Hypotenuse MCP server end to end: the real daemon hands the fake ACP
 * agent `hypotenuse mcp` in `session/new`; the agent calls `linear_get_issue`
 * and reads finear's issue back through the daemon and the server, and on
 * the follow-up calls `linear_ask_user`, which leaves the session in
 * `awaitingInput` with nothing after the question. Throughout, the MCP
 * server's argv holds a session id and a nonce — never the runner token.
 */

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await home?.kill();
  delete process.env.FAKE_ACP_HOLD_MS;
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();
withoutRunnerRateLimits();

let appUserId: string;
let home: DaemonHome;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  // The first turn holds its MCP server open long enough to read `ps`.
  process.env.FAKE_ACP_HOLD_MS = "3000";
  home = await DaemonHome.create(
    universe.url,
    universe.mario,
    universe.projectId,
    "mcp-laptop",
    { scenario: "mcp-probe" },
  );
  await home.startForeground();
}, HOOK_TIMEOUT);

/**
 * The command lines of every `hypotenuse mcp` process running now.
 * @returns Their argv, one string each.
 */
function mcpProcesses(): string[] {
  const ps = Bun.spawnSync(["ps", "-eo", "args"], { stdout: "pipe" });
  return ps.stdout
    .toString()
    .split("\n")
    .filter((line) => / mcp --session \d+ --nonce [0-9a-f]{32}/.test(line));
}

describe("hypotenuse mcp end to end", () => {
  test("LC-MCP-01 the agent reads its issue through the tools, and no token is in the MCP server's argv", async () => {
    const { session, issue } = await delegatedSession(
      linear,
      appUserId,
      "Retry the webhook with backoff",
    );

    const lines = await until(async () => {
      const found = mcpProcesses();
      return found.length > 0 ? found : null;
    }, 30_000);
    const token = home.runner.token;
    for (const line of lines) {
      expect(line).toContain(`--session ${session.id}`);
      expect(line).not.toContain("hyp_rt_");
      expect(line).not.toContain(token.slice(-4));
    }

    await until(async () => {
      const [item] = await itemsOf(session.id);
      return item?.status === "completed" ? item : null;
    }, 30_000);
    const result = home.received().find((r) => r.method === "mcp/result");
    expect(result?.params).toMatchObject({
      tool: "linear_get_issue",
      isError: false,
    });
    expect(String(result?.params.text)).toContain(
      `# ${issue.identifier}: Retry the webhook with backoff`,
    );

    await settle();
    const response = (await outbound(session.id)).find(
      (r) => r.contentType === "response",
    );
    expect((response?.content as { body: string }).body).toContain(
      `linear_get_issue: # ${issue.identifier}`,
    );
    // The agent was handed the server first, by name, with only a nonce.
    const created = home.received().find((r) => r.method === "session/new");
    const servers = created?.params.mcpServers as {
      name: string;
      args: string[];
      env: { name: string; value: string }[];
    }[];
    expect(servers[0]?.name).toBe("hypotenuse");
    expect(JSON.stringify(servers)).not.toContain(token);
  });

  test("LC-SIG-02 linear_ask_user ends the turn in awaitingInput with no response after the question", async () => {
    const sessions = await onlySession();
    await personSays(linear, sessions.externalSessionId, "Go on.");
    await until(async () => {
      const items = await itemsOf(sessions.id);
      return items.length === 2 && items[1]?.status === "completed"
        ? items
        : null;
    }, 30_000);
    await settle();

    const asked = home
      .received()
      .filter((r) => r.method === "mcp/result")
      .at(-1);
    expect(asked?.params).toMatchObject({
      tool: "linear_ask_user",
      isError: false,
    });

    const seen = await finearSession(
      linear,
      await appToken(universe.projectId),
      sessions.externalSessionId,
    );
    expect(seen.status).toBe("awaitingInput");
    const last = seen.activities.at(-1);
    expect(last?.content.__typename).toBe("AgentActivityElicitationContent");
    expect(last?.signal).toBe("select");
    expect(last?.content.body).toBe("Keep the old retry header?");

    const rows = await outbound(sessions.id);
    const question = rows.findIndex((r) => r.contentType === "elicitation");
    expect(question).toBeGreaterThan(-1);
    expect(
      rows.slice(question + 1).filter((r) => r.contentType !== null),
    ).toEqual([]);
    expect(JSON.stringify(rows)).not.toContain("I asked about the header.");
  });
});

/**
 * The session the first test started (the only one in this file).
 * @returns Its mirror row's id and Linear id.
 */
async function onlySession(): Promise<{
  id: number;
  externalSessionId: string;
}> {
  const [row] = await api.db.db.select().from(agentSessions);
  if (!row) throw new Error("no session");
  return { id: row.id, externalSessionId: row.externalSessionId };
}
