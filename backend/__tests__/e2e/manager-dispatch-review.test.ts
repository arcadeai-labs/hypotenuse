import { beforeAll, describe, expect, test } from "bun:test";
import { changesThought, dispatchedThought } from "../../ops/DispatchOps";
import { childrenOf, reviewsOf } from "../actions/dispatch-helpers";
import type { DaemonHome } from "../daemon/helpers";
import { outbound, signed, until } from "../daemon/helpers";
import { FINEAR_FIXTURES, FINEAR_PRIMARY_KEY } from "../linear/finear";
import { delegate, sessionRow } from "../linear/sessions";
import { itemsOf } from "../routing/helpers";
import { HOOK_TIMEOUT } from "../setup";
import { bodies, useE2E } from "./harness";

/**
 * The manager and its workers, end to end, on one real daemon that plays
 * both roles, with the fake agent playing `manager-dispatch` through the real
 * `hypotenuse mcp` server. An issue labelled `hypotenuse:manager` gets a
 * manager, which breaks it into two sub-issues and dispatches both; each
 * becomes a worker session that opens by linking the planning issue, and
 * each worker's finished turn comes back to the manager as a review turn.
 * Reviewing the first, the manager requests changes, which sends that worker
 * back to its own session and branch with the "requested changes" thought;
 * the later reviews accept.
 *
 * Workers run one at a time here (`[roles.worker] max_parallel = 1`), so the
 * reviews arrive in a known order: ENG-2, ENG-3, then ENG-2 again.
 */

const e2e = useE2E();

let home: DaemonHome;
beforeAll(async () => {
  home = await e2e.daemon(e2e.universe.mario, "plan-box", {
    scenario: "manager-dispatch",
    roles: ["manager", "worker"],
    worker: "max_parallel = 1",
  });
}, HOOK_TIMEOUT);

/**
 * Create an issue carrying the `hypotenuse:manager` label in finear.
 * @param title - The title.
 * @returns The issue.
 */
async function managedIssue(
  title: string,
): Promise<{ id: string; identifier: string; url: string }> {
  const label = await e2e.linear.graphql<{
    issueLabelCreate: { issueLabel: { id: string } };
  }>(
    FINEAR_PRIMARY_KEY,
    `mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { issueLabel { id } } }`,
    {
      input: {
        name: "hypotenuse:manager",
        teamId: FINEAR_FIXTURES.primary.team,
      },
    },
  );
  if (!label.data) throw new Error(JSON.stringify(label.errors));
  const created = await e2e.linear.graphql<{
    issueCreate: { issue: { id: string; identifier: string; url: string } };
  }>(
    FINEAR_PRIMARY_KEY,
    `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id identifier url } } }`,
    {
      input: {
        teamId: FINEAR_FIXTURES.primary.team,
        title,
        description: "Totals are off by a cent.",
        labelIds: [label.data.issueLabelCreate.issueLabel.id],
      },
    },
  );
  if (!created.data) throw new Error(JSON.stringify(created.errors));
  return created.data.issueCreate.issue;
}

/**
 * An issue's sub-issues as finear holds them.
 * @param id - The parent issue's id.
 * @returns Their identifiers and titles.
 */
async function subIssuesOf(id: string) {
  const reply = await e2e.linear.graphql<{
    issue: { children: { nodes: { identifier: string; title: string }[] } };
  }>(
    `Bearer ${e2e.token}`,
    `query($id: String!) { issue(id: $id) { children { nodes { identifier title } } } }`,
    { id },
  );
  if (!reply.data) throw new Error(JSON.stringify(reply.errors));
  return reply.data.issue.children.nodes
    .map((n) => [n.identifier, n.title])
    .sort();
}

let sentBackSessionId = "";
let managerSessionId = "";

describe("a manager dispatches and reviews", () => {
  test("sub-issues, two workers, three reviews, and one round of changes", async () => {
    const parent = await managedIssue("Fix checkout rounding everywhere");
    // The scenario names the sub-issues it will create: ENG-2 and ENG-3.
    expect(parent.identifier).toBe("ENG-1");
    const externalSessionId = await delegate(
      e2e.linear,
      parent.id,
      e2e.appUserId,
    );
    const manager = await until(() => sessionRow(externalSessionId));

    // Turn, three reviews; every one finished.
    const managerItems = await until(async () => {
      const items = await itemsOf(manager.id);
      return items.length === 4 && items.every((i) => i.status === "completed")
        ? items
        : null;
    }, 60_000);
    expect(managerItems.map((i) => [i.kind, i.role])).toEqual([
      ["session_created", "manager"],
      ["review", "manager"],
      ["review", "manager"],
      ["review", "manager"],
    ]);
    const reviews = await reviewsOf(manager.id);
    expect(
      reviews.map((r) => {
        const review = (
          r.payload as {
            review: { childIssueIdentifier: string; reviewRound: number };
          }
        ).review;
        return [review.childIssueIdentifier, review.reviewRound];
      }),
    ).toEqual([
      ["ENG-2", 0],
      ["ENG-3", 0],
      ["ENG-2", 1],
    ]);

    // Two sub-issues under the planning issue, in Linear.
    expect(await subIssuesOf(parent.id)).toEqual([
      ["ENG-2", "Round the subtotal"],
      ["ENG-3", "Round the tax"],
    ]);

    // Two worker sessions, each opening by linking the planning issue.
    const children = await childrenOf(manager.id);
    sentBackSessionId = children[0]?.externalSessionId ?? "";
    expect(children.map((c) => [c.issueIdentifier, c.role])).toEqual([
      ["ENG-2", "worker"],
      ["ENG-3", "worker"],
    ]);
    // Linear catches up through the outbox: wait for each first answer.
    const views = await Promise.all(
      children.map((c) =>
        e2e.linearSession(
          c.externalSessionId,
          (s) => bodies(s, "AgentActivityResponseContent").length >= 1,
        ),
      ),
    );
    for (const view of views) {
      const thoughts = bodies(view, "AgentActivityThoughtContent");
      expect(thoughts[0]).toBe(dispatchedThought(parent.url));
      expect(bodies(view, "AgentActivityResponseContent")[0]).toBe(
        signed("Rounded it.", "plan-box"),
      );
    }

    // ENG-2 was sent back once: the same session, runner, and branch, with
    // the "requested changes" thought and a second answer.
    const sentBack = (await outbound(children[0].id))
      .filter(
        (r) => r.contentType === "thought" || r.contentType === "response",
      )
      .map((r) => (r.content as { body: string }).body);
    expect(sentBack).toContain(changesThought("Also cover negative totals."));
    expect(sentBack.at(-1)).toBe(
      signed("Covered negative totals too.", "plan-box"),
    );
    const sentBackItems = await itemsOf(children[0].id);
    expect(sentBackItems.map((i) => [i.kind, i.status, i.runnerId])).toEqual([
      ["dispatch", "completed", home.runner.id],
      ["prompt", "completed", home.runner.id],
    ]);
    expect(sentBackItems[1].fresh).toBe(false);
    expect(sentBackItems[1].outcome?.branch).toBe(
      sentBackItems[0].outcome?.branch,
    );
    expect(sentBackItems[0].outcome?.branch).toStartWith("hypotenuse/eng-2-");
    expect((await sessionRow(children[0].externalSessionId))?.reviewRound).toBe(
      1,
    );

    // The manager's own session shows what it did, and ends accepting.
    // The manager's own session: its first turn reached Linear; every review
    // turn is recorded with what it did (see the known bug below).
    managerSessionId = externalSessionId;
    const managerView = await e2e.linearSession(
      externalSessionId,
      (s) => bodies(s, "AgentActivityResponseContent").length >= 1,
    );
    expect(bodies(managerView, "AgentActivityResponseContent")[0]).toBe(
      signed(
        "Split ENG-1 into ENG-2 and ENG-3 and dispatched both.",
        "plan-box",
        "manager",
      ),
    );
    const recorded = (await outbound(manager.id))
      .filter((r) => r.deliveryStatus !== "superseded")
      .map((r) => {
        const c = r.content as {
          body?: string;
          action?: string;
          parameter?: string;
        };
        return r.contentType === "action"
          ? `${c.action} ${c.parameter}`
          : `${r.contentType}: ${c.body}`;
      });
    expect(
      recorded.filter((r) => /^(Dispatched|Requested changes) /.test(r)),
    ).toEqual([
      "Dispatched ENG-2",
      "Dispatched ENG-3",
      "Requested changes ENG-2",
    ]);
    expect(recorded.filter((r) => r.startsWith("thought: Reviewing"))).toEqual([
      "thought: Reviewing ENG-2 (round 1)…",
      "thought: Reviewing ENG-3 (round 1)…",
      "thought: Reviewing ENG-2 (round 2)…",
    ]);
    expect(recorded.filter((r) => r.startsWith("response: "))).toEqual(
      [
        "Split ENG-1 into ENG-2 and ENG-3 and dispatched both.",
        "Sent ENG-2 back: negative totals are not covered.",
        "Accepted.",
        "Accepted.",
      ].map((b) => `response: ${signed(b, "plan-box", "manager")}`),
    );
  }, 90_000);

  // A review turn wakes a manager session, and a "changes" dispatch a worker
  // session, that Linear already holds `complete`. finear refuses an app's
  // activity on a terminal session until a person prompts it ("Terminal
  // sessions require a human prompt to reopen"), so the review loop is
  // recorded above but never delivered. Linear's own docs say only that a
  // session's status follows its last activity; the release check in
  // `docs/DEPLOY.md` settles which is true (a finear gap, or a product bug
  // the review loop must answer). These fail until then; flip them to `test`
  // when they pass.
  test.failing("the review turns reach the manager's session in Linear", async () => {
    await e2e.linearSession(
      managerSessionId,
      (s) => bodies(s, "AgentActivityResponseContent").length === 4,
      5_000,
    );
  }, 15_000);

  test.failing("the round of changes reaches the worker's session in Linear", async () => {
    await e2e.linearSession(
      sentBackSessionId,
      (s) => bodies(s, "AgentActivityResponseContent").length === 2,
      5_000,
    );
  }, 15_000);
});
