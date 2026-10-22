import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "keryx";
import type { DaemonHome } from "../daemon/helpers";
import { outbound, signed, until } from "../daemon/helpers";
import { itemsOf, sessionById } from "../routing/helpers";
import { runnerRow } from "../runners/helpers";
import { HOOK_TIMEOUT } from "../setup";
import { bodies, useE2E } from "./harness";

/**
 * A coding agent that is not logged in, end to end: the turn ends on an
 * `auth` elicitation linking the runner's auth page, and Linear holds the
 * session awaiting input. The runner's owner logs the agent in with
 * `hypotenuse agents login` (which reloads the running daemon); the person
 * says "done" in Linear; and the next turn opens with the "Signed in —
 * continuing." thought, which dismisses the login prompt, before the agent
 * answers normally on the same runner.
 */

const e2e = useE2E();

const marker = join(mkdtempSync(join(tmpdir(), "hypa-")), "logged-in");
let home: DaemonHome;
beforeAll(async () => {
  home = await e2e.daemon(e2e.universe.mario, "auth-laptop", {
    scenario: "auth-login",
    env: { FAKE_ACP_LOGIN_MARKER: marker },
  });
}, HOOK_TIMEOUT);

describe("an agent that needs a login", () => {
  test("LC-SIG-02 asks with an auth elicitation, and continues on the same runner after the login", async () => {
    const { externalSessionId, agentSessionId } = await e2e.delegate(
      "Needs a login first",
    );

    // The question ends the turn, and Linear waits for the person.
    const asked = await e2e.linearSession(
      externalSessionId,
      (s) => s.status === "awaitingInput",
    );
    const last = asked.activities.at(-1);
    expect(last?.content.__typename).toBe("AgentActivityElicitationContent");
    expect(last?.signal).toBe("auth");
    expect(last?.content.body).toStartWith(
      "Fake Agent on runner auth-laptop is not logged in.",
    );
    const session = await sessionById(agentSessionId);
    const elicitation = (await outbound(agentSessionId)).at(-1);
    expect(elicitation?.signalMetadata).toEqual({
      url: `${config.notifications.appUrl}/runners/${home.runner.id}/auth/claude`,
      userId: session.creatorExternalUserId,
      providerName: "Fake Agent",
    });
    expect((await itemsOf(agentSessionId)).map((i) => i.status)).toEqual([
      "completed",
    ]);

    // The owner logs the agent in on the runner; the daemon is reloaded.
    const login = await home.run(["agents", "login", "claude", "--json"]);
    expect(login.code).toBe(0);
    // The agent's own login shares the terminal and prints first.
    expect(login.stdout).toStartWith("Logged in to the fake agent.\n");
    const result = login.stdout.slice(login.stdout.indexOf("{"));
    expect(JSON.parse(result)).toMatchObject({
      loggedIn: true,
      daemonReloaded: true,
    });
    await until(async () => {
      const row = await runnerRow(home.runner.id);
      return row.agents?.[0]?.available === true ? row : null;
    });

    // The person says so, and the agent continues.
    await e2e.say(externalSessionId, "done");
    const view = await e2e.linearSession(
      externalSessionId,
      (s) => s.status === "complete",
    );
    const thoughts = bodies(view, "AgentActivityThoughtContent");
    const responses = bodies(view, "AgentActivityResponseContent");
    expect(thoughts).toContain("Signed in — continuing.");
    expect(responses).toEqual([
      signed("Signed in and finished.", "auth-laptop"),
    ]);
    // The thought comes after the question and before the answer.
    const order = view.activities.map((a) => a.content.body);
    expect(order.indexOf("Signed in — continuing.")).toBeGreaterThan(
      order.indexOf(last?.content.body),
    );
    const items = await itemsOf(agentSessionId);
    expect(items.map((i) => [i.kind, i.status, i.runnerId])).toEqual([
      ["session_created", "completed", home.runner.id],
      ["prompt", "completed", home.runner.id],
    ]);
  }, 60_000);
});
