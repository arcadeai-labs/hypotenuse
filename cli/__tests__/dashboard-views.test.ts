import { describe, expect, test } from "bun:test";
import {
  describeOverview,
  humanDuration,
  type ProjectOverview,
} from "../src/commands/project";
import {
  describePreview,
  previewRepositoryLine,
  type RoutingPreview,
} from "../src/commands/routing";
import {
  type AgentActivity,
  follow,
  isIssueIdentifier,
  resolveSessionId,
  turnsTable,
} from "../src/commands/session";

/**
 * A preview with defaults.
 * @param overrides - Fields to set.
 * @returns The preview.
 */
function preview(overrides: Partial<RoutingPreview> = {}): RoutingPreview {
  return {
    issue: {
      id: "i1",
      identifier: "ENG-1",
      title: "Fix it",
      url: null,
      teamKey: "ENG",
      labels: [],
      project: null,
    },
    origin: "delegation",
    matchedRuleId: null,
    matchedRuleName: null,
    role: "worker",
    candidates: [],
    waitingCode: "no_runners",
    repository: {
      candidates: [],
      repository: null,
      pinnedByRule: false,
      suggestion: null,
      wouldElicit: false,
      waitsForRepository: false,
      askedLinear: false,
    },
    ...overrides,
  };
}

describe("routing preview rendering", () => {
  test("names the rule, the role, every runner's reasons, and the wait", () => {
    const text = describePreview(
      preview({
        matchedRuleId: 3,
        matchedRuleName: "Plans",
        role: "manager",
        waitingCode: "offline",
        candidates: [
          {
            runnerId: 7,
            name: "laptop",
            owner: { id: 1, name: "Mario" },
            eligible: false,
            reasons: [
              { code: "offline", message: "It is offline." },
              { code: "paused", message: "It is paused." },
            ],
          },
        ],
      }),
    );
    expect(text).toContain("rule #3 Plans");
    expect(text).toContain("manager");
    expect(text).toContain("offline, paused");
    expect(text).toContain("Mario");
    expect(text).toContain("would wait offline");
  });

  test("no rule, no runners", () => {
    const text = describePreview(preview());
    expect(text).toContain("no rule matched");
    expect(text).toContain("No runners in this project.");
  });

  test("each repository outcome reads as a sentence", () => {
    const base = preview().repository;
    expect(
      previewRepositoryLine({
        ...base,
        repository: "github.com/a/b",
        pinnedByRule: true,
      }),
    ).toBe("github.com/a/b (pinned by the rule)");
    expect(
      previewRepositoryLine({
        ...base,
        repository: "github.com/a/b",
        candidates: ["github.com/a/b", "github.com/a/c"],
        suggestion: { repository: "github.com/a/b", confidence: 0.9 },
      }),
    ).toContain("90% confident");
    expect(
      previewRepositoryLine({ ...base, repository: "github.com/a/b" }),
    ).toContain("the only candidate");
    expect(
      previewRepositoryLine({ ...base, waitsForRepository: true }),
    ).toContain("would wait");
    expect(
      previewRepositoryLine({
        ...base,
        candidates: ["x", "y"],
        wouldElicit: null,
      }),
    ).toContain("--with-repository");
    expect(
      previewRepositoryLine({
        ...base,
        candidates: ["x", "y"],
        wouldElicit: true,
      }),
    ).toContain("asked to pick");
    expect(previewRepositoryLine(base)).toBe("none needed");
  });
});

describe("project overview rendering", () => {
  const overview: ProjectOverview = {
    window: "24h",
    since: 0,
    linear: {
      status: "active",
      workspaceName: "Acme",
      workspaceUrlKey: "acme",
      appUserName: "hypotenuse",
      lastWebhookAt: null,
      failedDeliveries: 2,
    },
    runners: {
      online: 1,
      draining: 0,
      offline: 2,
      used: 1,
      total: 4,
      oldestHeartbeatAt: null,
    },
    sessions: {
      total: 3,
      byStatus: { active: 2, complete: 1, error: 0 },
      byRole: { worker: 3, manager: 0, undecided: 0 },
      medianAckMs: 850,
      medianClaimMs: 4200,
    },
    queue: {
      items: [
        {
          workItemId: 9,
          agentSessionId: 5,
          issueIdentifier: "ENG-9",
          kind: "prompt",
          role: "worker",
          status: "queued",
          waitingCode: "no_capacity",
          waitingReason: "Waiting for a runner: all busy.",
          ageMs: 120_000,
        },
      ],
      expired: 1,
    },
  };

  test("the four cards and the queue", () => {
    const text = describeOverview(overview);
    expect(text).toContain("Acme (active)");
    expect(text).toContain("2 failed in 24h");
    expect(text).toContain("1 online, 0 draining, 2 offline; 1/4 slots busy");
    expect(text).toContain("active 2, complete 1");
    expect(text).not.toContain("error 0");
    expect(text).toContain("median acknowledgement 850ms, median claim 4.2s");
    expect(text).toContain("1 waiting now, 1 expired in 24h");
    expect(text).toContain("no_capacity");
    expect(text).toContain("ENG-9");
  });

  test("no Linear connection", () => {
    expect(describeOverview({ ...overview, linear: null })).toContain(
      "not connected",
    );
  });

  test("durations", () => {
    expect(humanDuration(null)).toBe("-");
    expect(humanDuration(999)).toBe("999ms");
    expect(humanDuration(1500)).toBe("1.5s");
    expect(humanDuration(180_000)).toBe("3m");
    expect(humanDuration(7_200_000)).toBe("2h");
  });
});

describe("session view helpers", () => {
  test("an issue identifier is told from a session id", () => {
    expect(isIssueIdentifier("ENG-123")).toBe(true);
    expect(isIssueIdentifier("eng-1")).toBe(true);
    expect(isIssueIdentifier("42")).toBe(false);
    expect(isIssueIdentifier("ENG")).toBe(false);
  });

  test("an identifier resolves to the newest session on the issue", async () => {
    const calls: Record<string, unknown>[] = [];
    const client = {
      request: async <T>(
        _method: string,
        _path: string,
        options?: { query?: Record<string, unknown> },
      ) => {
        calls.push(options?.query ?? {});
        return { agentSessions: [{ id: 17 }] } as T;
      },
    };
    expect(await resolveSessionId(client, 1, "42")).toBe(42);
    expect(calls).toHaveLength(0);
    expect(await resolveSessionId(client, 1, "ENG-5")).toBe(17);
    expect(calls[0]).toMatchObject({ issueIdentifier: "ENG-5", limit: 1 });
    const none = {
      request: async <T>() => ({ agentSessions: [] }) as T,
    };
    await expect(resolveSessionId(none, 1, "ENG-5")).rejects.toThrow(
      "No session on ENG-5.",
    );
    await expect(resolveSessionId(none, 1, "what?")).rejects.toThrow(
      "neither a session id",
    );
  });

  test("a waiting turn shows its code and sentence; a cancelled one its reason", () => {
    const base = {
      kind: "prompt",
      role: "worker",
      attempts: 0,
      runnerName: null,
      waitingReason: null,
      cancelReason: null,
      createdAt: 0,
      claimedAt: null,
      finishedAt: null,
    };
    const text = turnsTable([
      {
        ...base,
        id: 1,
        status: "queued",
        waitingCode: "offline",
        waitingReason: "Waiting for a runner: it is offline.",
      },
      {
        ...base,
        id: 2,
        status: "cancelled",
        waitingCode: null,
        cancelReason: "dashboard",
      },
    ]);
    expect(text).toContain("offline: Waiting for a runner");
    expect(text).toContain("dashboard");
  });

  test("follow reads after the last sequence shown and prints only what is new", async () => {
    const reads: number[] = [];
    const printed: number[] = [];
    const activity = (seq: number) => ({ seq }) as AgentActivity;
    let n = 0;
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 60);
    await follow(
      5,
      3,
      async (afterSeq) => {
        reads.push(afterSeq);
        n++;
        return n === 1 ? [activity(4), activity(5)] : [];
      },
      (fresh) => printed.push(...fresh.map((a) => a.seq)),
      stop.signal,
    );
    expect(reads[0]).toBe(3);
    expect(reads.slice(1).every((s) => s === 5)).toBe(true);
    expect(printed).toEqual([4, 5]);
  });
});
