import { beforeAll, describe, expect, test } from "bun:test";
import type { DaemonHome } from "../daemon/helpers";
import { itemsOf } from "../routing/helpers";
import { HOOK_TIMEOUT } from "../setup";
import { bodies, useE2E } from "./harness";

/**
 * The nightly run against a real coding agent: the same system as every
 * other end-to-end file, with the daemon's agent the `claude` preset
 * (`claude-agent-acp` from npm, logged in by `ANTHROPIC_API_KEY`) instead of
 * the scripted fake. It runs only when `HYPOTENUSE_E2E_AGENT=claude`, which
 * the nightly workflow sets; everywhere else it is skipped.
 *
 * It is not a test of the model. Its assertions are about shape — the
 * session completes with at least one action and one response and no error,
 * and a Stop ends a running turn with the stop response last — so that what
 * it catches is the ACP adapter or SDK changing under the agent host.
 */

const REAL = process.env.HYPOTENUSE_E2E_AGENT === "claude";

const e2e = useE2E();

let home: DaemonHome;
beforeAll(async () => {
  if (!REAL) return;
  home = await e2e.daemon(e2e.universe.mario, "nightly", {
    agent: ['preset = "claude"', 'startup_timeout = "300s"'].join("\n"),
  });
}, HOOK_TIMEOUT * 10);

/** A view's activity type names. */
const kinds = (view: { activities: { content: { __typename: string } }[] }) =>
  view.activities.map((a) => a.content.__typename);

describe.skipIf(!REAL)("a real coding agent", () => {
  test("a one-line change: actions, a response, no error, complete", async () => {
    const { externalSessionId } = await e2e.delegate(
      "Add the line 'Maintained with Hypotenuse.' to the end of README.md and commit it. Do not push.",
    );
    const view = await e2e.linearSession(
      externalSessionId,
      (s) => s.status === "complete" || s.status === "error",
      600_000,
    );
    expect(view.status).toBe("complete");
    expect(kinds(view)).toContain("AgentActivityActionContent");
    expect(kinds(view)).not.toContain("AgentActivityErrorContent");
    expect(bodies(view, "AgentActivityResponseContent").length).toBe(1);
    expect(home.runner.id).toBeGreaterThan(0);
  }, 660_000);

  test("a Stop mid-turn ends the turn with the stop response last", async () => {
    const { externalSessionId, agentSessionId } = await e2e.delegate(
      "Read every file in this repository one at a time and summarise each in a separate paragraph.",
    );
    await e2e.linearSession(
      externalSessionId,
      (s) => kinds(s).includes("AgentActivityActionContent"),
      600_000,
    );
    await e2e.say(externalSessionId, "Stop", "stop");
    const view = await e2e.linearSession(
      externalSessionId,
      (s) =>
        bodies(s, "AgentActivityResponseContent").some((b) =>
          b.startsWith("Stopped at your request."),
        ),
      120_000,
    );
    expect(view.activities.at(-1)?.content.body).toStartWith(
      "Stopped at your request.",
    );
    const [item] = await itemsOf(agentSessionId);
    expect(item.status).toBe("cancelled");
  }, 780_000);
});
