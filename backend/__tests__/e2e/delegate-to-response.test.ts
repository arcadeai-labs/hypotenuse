import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { dashboardSessionUrl } from "../../ops/WorkItemOps";
import type { DaemonHome } from "../daemon/helpers";
import { signed } from "../daemon/helpers";
import { itemsOf, sessionById } from "../routing/helpers";
import { HOOK_TIMEOUT } from "../setup";
import { bodies, useE2E } from "./harness";

/**
 * A delegation, end to end, as the person in Linear sees it: the real server,
 * finear, the real daemon, the fake agent playing `plan-edit-pr`, and a real
 * git origin. The session is acknowledged within Linear's ten seconds, the
 * issue moves to started, the plan ends all completed, the edit and the
 * push are actions with results, the pull request is linked, and the answer
 * is a signed response on a complete session. A follow-up goes back to the
 * same runner and the same worktree, and so does one after the daemon
 * restarts, continuing the agent's own session with `session/load`.
 */

const e2e = useE2E();

let home: DaemonHome;
beforeAll(async () => {
  home = await e2e.daemon(e2e.universe.mario, "e2e-laptop", {
    scenario: "plan-edit-pr",
  });
}, HOOK_TIMEOUT);

/** An activity with every content shape's fields, as finear holds it. */
interface FullActivity {
  createdAt: string;
  content: {
    __typename: string;
    body?: string;
    action?: string;
    parameter?: string;
    result?: string | null;
  };
}

/**
 * Read what the per-file harness does not: the session's creation time,
 * links, and every action's fields, and the issue's workflow state.
 * @param externalSessionId - Linear's session id.
 * @returns The session as the app reads it.
 */
async function linearDetail(externalSessionId: string) {
  const reply = await e2e.linear.graphql<{
    agentSession: {
      createdAt: string;
      externalLinks: { label: string; url: string }[];
      issue: { identifier: string; state: { type: string } };
      activities: { nodes: FullActivity[] };
    };
  }>(
    `Bearer ${e2e.token}`,
    `query($id: String!) { agentSession(id: $id) {
      createdAt
      externalLinks { label url }
      issue { identifier state { type } }
      activities(first: 100) { nodes { createdAt content { __typename
        ... on AgentActivityThoughtContent { body }
        ... on AgentActivityResponseContent { body }
        ... on AgentActivityActionContent { action parameter result }
      } } }
    } }`,
    { id: externalSessionId },
  );
  if (!reply.data) throw new Error(JSON.stringify(reply.errors));
  return reply.data.agentSession;
}

/**
 * The prompts the agent received for one Hypotenuse session.
 * @param agentSessionId - The session.
 * @returns Each `session/prompt`'s text, in order.
 */
function promptsFor(agentSessionId: number): string[] {
  return home
    .received()
    .filter(
      (r) =>
        r.method === "session/prompt" && r.session === String(agentSessionId),
    )
    .map((r) =>
      (r.params.prompt as { type: string; text?: string }[])
        .map((p) => p.text ?? "")
        .join("\n"),
    );
}

let externalSessionId: string;
let agentSessionId: number;
let identifier: string;

describe("delegate to response", () => {
  test("LC-SES-01 a delegation is acknowledged, worked, linked, and answered in Linear", async () => {
    const started = await e2e.delegate("Fix checkout rounding");
    ({ externalSessionId, agentSessionId } = started);
    identifier = started.issue.identifier;

    const view = await e2e.linearSession(
      externalSessionId,
      (s) => s.status === "complete",
    );
    const detail = await linearDetail(externalSessionId);

    // Acknowledged on Linear's own clock, well inside its ten seconds.
    const first = detail.activities.nodes[0];
    expect(first?.content.__typename).toBe("AgentActivityThoughtContent");
    expect(
      Date.parse(first?.createdAt as string) - Date.parse(detail.createdAt),
    ).toBeLessThan(10_000);

    // The delegation moved the issue to started.
    expect(detail.issue.state.type).toBe("started");

    // The edit and the push are actions with their results.
    const actions = detail.activities.nodes
      .filter((a) => a.content.__typename === "AgentActivityActionContent")
      .map((a) => a.content);
    expect(actions).toContainEqual({
      __typename: "AgentActivityActionContent",
      action: "Edited",
      parameter: "src/a.ts",
      result:
        "+1 −1 in src/a.ts\n\n+++ Diff\n```diff\n-round(x)\n+roundHalfEven(x)\n```\n+++",
    });
    // finear keeps the ephemeral "Running" it was replaced by; the finished
    // call is the "Ran".
    const push = actions.find(
      (a) => a.action === "Ran" && a.parameter?.includes("git push"),
    );
    expect(push?.result).toContain("https://github.com/acme/web/pull/7");

    // The pull request is linked beside the dashboard.
    expect(detail.externalLinks).toEqual([
      { label: "Hypotenuse", url: dashboardSessionUrl(agentSessionId) },
      { label: "Pull Request", url: "https://github.com/acme/web/pull/7" },
    ]);

    // The plan ended with every step completed.
    const mirror = await sessionById(agentSessionId);
    expect(mirror.plan?.map((p) => p.status)).toEqual([
      "completed",
      "completed",
      "completed",
    ]);

    // One signed response, last.
    expect(bodies(view, "AgentActivityResponseContent")).toEqual([
      signed(
        "Fixed the rounding in `src/a.ts` and opened https://github.com/acme/web/pull/7.",
        "e2e-laptop",
      ),
    ]);
    expect(view.activities.at(-1)?.content.__typename).toBe(
      "AgentActivityResponseContent",
    );

    // The work happened in a worktree of its own, on its own branch.
    const dir = join(home.root, "worktrees", "web", identifier);
    expect(existsSync(join(dir, "fix.txt"))).toBe(true);
    const [item] = await itemsOf(agentSessionId);
    expect(item.status).toBe("completed");
    expect(item.runnerId).toBe(home.runner.id);
    expect(item.outcome?.branch).toStartWith(
      `hypotenuse/${identifier.toLowerCase()}-fix-checkout-rounding`,
    );
  }, 60_000);

  test("a follow-up is sticky: the same runner, the same worktree, the agent's own session", async () => {
    await e2e.say(externalSessionId, "Is the fix still there?");
    const view = await e2e.linearSession(
      externalSessionId,
      (s) => bodies(s, "AgentActivityResponseContent").length === 2,
    );
    expect(bodies(view, "AgentActivityResponseContent")[1]).toBe(
      signed("Still on the same branch, fix.txt intact.", "e2e-laptop"),
    );
    const items = await itemsOf(agentSessionId);
    expect(items.map((i) => [i.kind, i.status, i.runnerId])).toEqual([
      ["session_created", "completed", home.runner.id],
      ["prompt", "completed", home.runner.id],
    ]);
    // The follow-up's request reached the agent, which continued its session.
    expect(promptsFor(agentSessionId)[1]).toContain("Is the fix still there?");
    expect(home.received().map((r) => r.method)).toContain("session/load");
    // Still one worktree.
    expect(readdirSync(join(home.root, "worktrees", "web"))).toEqual([
      identifier,
    ]);
  }, 60_000);

  test("after a daemon restart a follow-up still loads the agent's session in the same worktree", async () => {
    const loadsBefore = home
      .received()
      .filter((r) => r.method === "session/load").length;
    home = await e2e.restart(home);
    await e2e.say(externalSessionId, "And once more?");
    await e2e.linearSession(
      externalSessionId,
      (s) => bodies(s, "AgentActivityResponseContent").length === 3,
    );
    const loads = home.received().filter((r) => r.method === "session/load");
    expect(loads.length).toBe(loadsBefore + 1);
    expect(loads.at(-1)?.params.cwd).toBe(
      join(home.root, "worktrees", "web", identifier),
    );
    expect(readdirSync(join(home.root, "worktrees", "web"))).toEqual([
      identifier,
    ]);
    expect((await itemsOf(agentSessionId)).length).toBe(3);
  }, 60_000);
});
