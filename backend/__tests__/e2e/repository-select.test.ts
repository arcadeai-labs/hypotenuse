import { beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DaemonHome } from "../daemon/helpers";
import { outbound, signed, until } from "../daemon/helpers";
import { createIssue, delegate, sessionRow } from "../linear/sessions";
import { itemsOf } from "../routing/helpers";
import { runnerRow } from "../runners/helpers";
import { HOOK_TIMEOUT } from "../setup";
import { bodies, useE2E } from "./harness";

/**
 * Choosing a repository with a person, across real daemons: one runner has
 * `acme/web` checked out and another `acme/api`. Linear's only suggestion is
 * below the project's confidence, so the session asks with a `select` whose
 * values are the repositories' GitHub URLs and waits in Linear; the person's
 * answer settles it, and the runner that has that repository does the work.
 */

const e2e = useE2E();

let web: DaemonHome;
let api: DaemonHome;
beforeAll(async () => {
  web = await e2e.daemon(e2e.universe.mario, "web-laptop");
  api = await e2e.daemon(e2e.universe.mario, "api-laptop");
  // Point the second home's clone at acme/api (git still sends it to the
  // home's local bare origin), and restart so the daemon reports it.
  const clone = join(api.root, "web");
  const origin = join(api.root, "origin.git");
  for (const args of [
    ["remote", "set-url", "origin", "git@github.com:acme/api.git"],
    ["config", "--unset", `url.${origin}.insteadOf`],
    ["config", `url.${origin}.insteadOf`, "git@github.com:acme/api.git"],
  ]) {
    const run = Bun.spawnSync(["git", ...args], { cwd: clone });
    if (run.exitCode !== 0) throw new Error(run.stderr.toString());
  }
  api = await e2e.restart(api);
  // The restarted daemon's own heartbeat, not the row its predecessor left.
  await until(async () => {
    const row = await runnerRow(api.runner.id);
    return row.repositories?.[0]?.remote === "github.com/acme/api";
  });
}, HOOK_TIMEOUT);

describe("a repository a person chooses", () => {
  test("LC-SIG-03 a select of GitHub URLs, and the answer routes to the runner with that repository", async () => {
    const issue = await createIssue(e2e.linear, "Which repository?");
    await e2e.linear.control("/__test/repository-suggestions", {
      issueId: issue.id,
      suggestions: [
        {
          hostname: "github.com",
          repositoryFullName: "acme/api",
          confidence: 0.5,
        },
      ],
    });
    const externalSessionId = await delegate(
      e2e.linear,
      issue.id,
      e2e.appUserId,
    );

    const asked = await e2e.linearSession(
      externalSessionId,
      (s) => s.status === "awaitingInput",
    );
    const question = asked.activities.at(-1);
    expect(question?.content.__typename).toBe(
      "AgentActivityElicitationContent",
    );
    expect(question?.signal).toBe("select");
    const session = await sessionRow(externalSessionId);
    if (!session) throw new Error("no mirror row");
    const elicitation = (await outbound(session.id)).at(-1);
    expect(elicitation?.signalMetadata).toEqual({
      options: [
        { label: "acme/api", value: "https://github.com/acme/api" },
        { label: "acme/web", value: "https://github.com/acme/web" },
      ],
    });
    // Nobody has started an agent while the person decides.
    expect(web.received()).toEqual([]);
    expect(api.received()).toEqual([]);

    await e2e.say(externalSessionId, "https://github.com/acme/api");
    const view = await e2e.linearSession(
      externalSessionId,
      (s) => s.status === "complete",
    );
    expect(bodies(view, "AgentActivityResponseContent")).toEqual([
      signed("Fixed the rounding in `src/a.ts`.", "api-laptop"),
    ]);
    const items = await itemsOf(session.id);
    expect(items.map((i) => [i.status, i.repository, i.runnerId])).toEqual([
      ["completed", "github.com/acme/api", api.runner.id],
    ]);
    expect(
      existsSync(join(api.root, "worktrees", "api", issue.identifier)),
    ).toBe(true);
    expect(web.received()).toEqual([]);
  }, 60_000);
});
