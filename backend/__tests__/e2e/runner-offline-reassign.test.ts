import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DaemonHome } from "../daemon/helpers";
import { signed } from "../daemon/helpers";
import { ago, itemsOf, setItem } from "../routing/helpers";
import { HOOK_TIMEOUT } from "../setup";
import { bodies, useE2E } from "./harness";

/**
 * A session's runner goes away between turns, across real daemons: the
 * follow-up waits for the runner holding the worktree, and says so in
 * Linear; once the sticky timeout has passed (moved by writing the item's
 * `queuedAt`, not by waiting), the other runner takes it in a fresh worktree
 * of its own, with the conversation so far replayed into the agent's prompt
 * from the session's activities, and its response is signed with the new
 * runner's name.
 */

const e2e = useE2E();

let first: DaemonHome;
let second: DaemonHome;
beforeAll(async () => {
  // Registered first, so it wins the first turn on a tie.
  first = await e2e.daemon(e2e.universe.mario, "first-laptop");
  second = await e2e.daemon(e2e.universe.mario, "second-laptop");
}, HOOK_TIMEOUT);

/**
 * The prompts a home's agent received for one session.
 * @param home - The home.
 * @param agentSessionId - The session.
 * @returns Each `session/prompt`'s text, in order.
 */
function promptsFor(home: DaemonHome, agentSessionId: number): string[] {
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

describe("the sticky runner goes offline", () => {
  test("the follow-up waits for it, then moves to another runner in a fresh worktree", async () => {
    const { externalSessionId, agentSessionId, issue } = await e2e.delegate(
      "Fix checkout rounding",
    );
    await e2e.linearSession(externalSessionId, (s) => s.status === "complete");
    expect((await itemsOf(agentSessionId))[0]?.runnerId).toBe(first.runner.id);

    // The runner holding the worktree stops; its daemon tells the server.
    await first.kill();

    await e2e.say(externalSessionId, "Also round the tax");
    const waiting = await e2e.linearSession(externalSessionId, (s) =>
      bodies(s, "AgentActivityThoughtContent").some((b) =>
        b.includes("Waiting for **first-laptop**"),
      ),
    );
    expect(bodies(waiting, "AgentActivityThoughtContent")).toContain(
      "Waiting for **first-laptop**, which has this session's worktree.",
    );
    const [, followUp] = await itemsOf(agentSessionId);
    expect(followUp).toMatchObject({
      status: "queued",
      waitingCode: "sticky_runner",
    });

    // Past the sticky timeout, anyone may take it.
    await setItem(followUp.id, { queuedAt: ago(11 * 60_000) });
    const view = await e2e.linearSession(
      externalSessionId,
      (s) => bodies(s, "AgentActivityResponseContent").length === 2,
    );
    expect(bodies(view, "AgentActivityResponseContent")[1]).toBe(
      signed("Fixed the rounding in `src/a.ts`.", "second-laptop"),
    );
    const items = await itemsOf(agentSessionId);
    expect(items.map((i) => [i.kind, i.status, i.runnerId])).toEqual([
      ["session_created", "completed", first.runner.id],
      ["prompt", "completed", second.runner.id],
    ]);

    // A fresh worktree on the new runner, and a new agent session there with
    // the conversation replayed into its prompt.
    expect(
      existsSync(join(second.root, "worktrees", "web", issue.identifier)),
    ).toBe(true);
    expect(second.received().map((r) => r.method)).not.toContain(
      "session/load",
    );
    const [prompt] = promptsFor(second, agentSessionId);
    // The prior turn reaches the new agent as the conversation so far.
    expect(prompt).toContain(
      `<conversation>\n<turn role="agent">\n${signed("Fixed the rounding in \`src/a.ts\`.", "first-laptop")}\n</turn>\n</conversation>`,
    );
    expect(prompt).toContain("<request>\nAlso round the tax\n</request>");
    expect(prompt).toContain("Runner: second-laptop");
  }, 60_000);
});
