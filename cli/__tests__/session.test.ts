import { describe, expect, test } from "bun:test";
import {
  type AgentActivity,
  type AgentSession,
  activitySummary,
  describeSession,
} from "../src/commands/session";

/**
 * An activity row with defaults.
 * @param overrides - Fields to set.
 * @returns The activity.
 */
function activity(overrides: Partial<AgentActivity>): AgentActivity {
  return {
    seq: 1,
    direction: "outbound",
    kind: "activity",
    contentType: "thought",
    content: { type: "thought", body: "Received." },
    ephemeral: false,
    signal: null,
    deliveryStatus: "sent",
    lastError: null,
    createdAt: 0,
    ...overrides,
  };
}

describe("activitySummary", () => {
  test("a body, folded onto one line", () => {
    expect(
      activitySummary(
        activity({
          content: { type: "response", body: "Done.\n\nPR opened." },
        }),
      ),
    ).toBe("Done. PR opened.");
  });

  test("an action is its action and parameter", () => {
    expect(
      activitySummary(
        activity({
          contentType: "action",
          content: { type: "action", action: "Reading", parameter: "a.ts" },
        }),
      ),
    ).toBe("Reading a.ts");
  });

  test("a session update names what it set, and a signal is shown", () => {
    expect(
      activitySummary(
        activity({
          kind: "session_update",
          contentType: null,
          content: { plan: [], summary: "x" },
        }),
      ),
    ).toBe("update plan, summary");
    expect(
      activitySummary(
        activity({
          direction: "inbound",
          contentType: "prompt",
          signal: "stop",
          content: { type: "prompt", body: "Stop" },
        }),
      ),
    ).toBe("[stop] Stop");
  });
});

describe("describeSession", () => {
  test("the session's fields, then its activities in order", () => {
    const session: AgentSession = {
      id: 7,
      type: "linear",
      externalSessionId: "s",
      externalUrl: "https://linear.app/agent-session/s",
      issueIdentifier: "ENG-1",
      issueTitle: "Fix it",
      issueUrl: null,
      creatorName: "Human 1",
      origin: "delegation",
      role: null,
      repository: null,
      runnerId: null,
      status: "error",
      summary: null,
      externalUrls: [],
      createdAt: 0,
      endedAt: null,
    };
    const text = describeSession(session, [
      activity({ seq: 1 }),
      activity({
        seq: 2,
        contentType: "error",
        content: { type: "error", body: "No runner" },
        deliveryStatus: "pending",
      }),
    ]);
    expect(text).toContain("ENG-1  Fix it");
    expect(text).toContain("origin     delegation by Human 1");
    expect(text.indexOf("Received.")).toBeLessThan(text.indexOf("No runner"));
    expect(text).toContain("pending");
    expect(text).toContain("linear     https://linear.app/agent-session/s");
  });

  test("a dispatched session names its manager; a manager lists what it dispatched", () => {
    const session: AgentSession = {
      id: 9,
      type: "linear",
      externalSessionId: "w",
      externalUrl: null,
      issueIdentifier: "ENG-2",
      issueTitle: "Handle EUR",
      issueUrl: null,
      creatorName: null,
      origin: "delegation",
      role: "worker",
      repository: null,
      runnerId: null,
      status: "complete",
      summary: null,
      externalUrls: [],
      parentAgentSessionId: 7,
      dispatchMode: "changes",
      reviewRound: 2,
      createdAt: 0,
      endedAt: null,
    };
    expect(
      describeSession(session, [], {
        parent: {
          id: 7,
          issueIdentifier: "ENG-1",
          issueUrl: "https://linear.app/acme/issue/ENG-1",
          status: "active",
          role: "manager",
        },
      }),
    ).toContain(
      "dispatched by session 7 on ENG-1 (active, round 3) https://linear.app/acme/issue/ENG-1",
    );
    const tree = describeSession({ ...session, id: 7, role: "manager" }, [], {
      parent: null,
      children: [
        {
          id: 9,
          issueIdentifier: "ENG-2",
          issueTitle: "Handle EUR",
          issueUrl: null,
          status: "complete",
          dispatchMode: "changes",
          reviewRound: 2,
          pullRequests: [
            {
              label: "Pull Request",
              url: "https://github.com/acme/web/pull/9",
            },
          ],
          workStatus: "completed",
        },
      ],
    });
    expect(tree).toContain("Dispatched");
    expect(tree).toMatch(
      /9\s+ENG-2\s+Handle EUR\s+complete\s+completed\s+3\s+https:\/\/github.com\/acme\/web\/pull\/9/,
    );
    expect(tree).not.toContain("dispatched by");
  });
});
