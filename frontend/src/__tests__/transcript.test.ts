import { describe, expect, test } from "bun:test";
import {
  actionOf,
  bodyOf,
  canCancelSession,
  collapseResult,
  groupByTurn,
  mergeActivities,
  orderLinks,
  planTurnIndex,
  type SessionTurn,
  selectOptions,
  type TranscriptActivity,
  transcriptEntries,
  turnDuration,
} from "../utils/transcript";

let nextId = 1;

/**
 * An activity with sensible defaults.
 * @param over - Fields to set.
 * @returns The activity.
 */
function activity(over: Partial<TranscriptActivity>): TranscriptActivity {
  const id = over.id ?? nextId++;
  return {
    id,
    agentSessionId: 1,
    seq: id,
    direction: "outbound",
    kind: "activity",
    contentType: "thought",
    content: { type: "thought", body: `line ${id}` },
    ephemeral: false,
    signal: null,
    signalMetadata: null,
    clientActivityId: `c${id}`,
    externalActivityId: null,
    externalSourceCommentId: null,
    externalUserId: null,
    priority: "normal",
    deliveryStatus: "sent",
    attempts: 0,
    nextAttemptAt: 0,
    lastError: null,
    sentAt: null,
    createdAt: id * 1000,
    ...over,
  } as TranscriptActivity;
}

/**
 * A work item with sensible defaults.
 * @param over - Fields to set.
 * @returns The turn.
 */
function turn(over: Partial<SessionTurn>): SessionTurn {
  return {
    id: 1,
    kind: "session_created",
    status: "completed",
    createdAt: 0,
    claimedAt: null,
    finishedAt: null,
    ...over,
  } as SessionTurn;
}

describe("mergeActivities", () => {
  test("merges by id, newest copy wins, ordered by seq", () => {
    const a = activity({ id: 10, seq: 2, deliveryStatus: "pending" });
    const b = activity({ id: 11, seq: 1 });
    const merged = mergeActivities(
      [a, b],
      [activity({ id: 10, seq: 2, deliveryStatus: "sent" })],
    );
    expect(merged.map((x) => x.id)).toEqual([11, 10]);
    expect(merged[1].deliveryStatus).toBe("sent");
  });
});

describe("transcriptEntries", () => {
  test("session updates are not transcript lines", () => {
    const entries = transcriptEntries([
      activity({ kind: "session_update", contentType: null, content: {} }),
      activity({}),
    ]);
    expect(entries).toHaveLength(1);
  });

  test("an ephemeral line followed by an outbound one is replaced; the last is live", () => {
    const first = activity({ ephemeral: true });
    const second = activity({ ephemeral: true });
    const entries = transcriptEntries([first, second]);
    expect(entries.map((e) => [e.replaced, e.live])).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  test("a superseded ephemeral line is replaced even when it is last", () => {
    const [entry] = transcriptEntries([
      activity({ ephemeral: true, deliveryStatus: "superseded" }),
    ]);
    expect(entry.replaced).toBe(true);
    expect(entry.live).toBe(false);
  });

  test("a person's prompt does not replace an ephemeral line", () => {
    const entries = transcriptEntries([
      activity({ ephemeral: true }),
      activity({ direction: "inbound", contentType: "prompt" }),
    ]);
    expect(entries[0].live).toBe(true);
  });

  test("a non-ephemeral line is never replaced", () => {
    const entries = transcriptEntries([activity({}), activity({})]);
    expect(entries.every((e) => !e.replaced && !e.live)).toBe(true);
  });
});

describe("groupByTurn", () => {
  test("lines go to the latest turn created at or before them", () => {
    const entries = transcriptEntries([
      activity({ id: 100, createdAt: 1000 }),
      activity({ id: 101, createdAt: 5000 }),
    ]);
    const groups = groupByTurn(entries, [
      turn({ id: 1, createdAt: 500 }),
      turn({ id: 2, kind: "review", createdAt: 4000 }),
    ]);
    expect(
      groups.map((g) => [g.turn?.id, g.entries.map((e) => e.activity.id)]),
    ).toEqual([
      [1, [100]],
      [2, [101]],
    ]);
  });

  test("the prompt that started a prompt turn moves under its separator", () => {
    const entries = transcriptEntries([
      activity({ id: 200, createdAt: 1000 }),
      activity({
        id: 201,
        direction: "inbound",
        contentType: "prompt",
        createdAt: 2000,
      }),
      activity({ id: 202, createdAt: 3000 }),
    ]);
    const groups = groupByTurn(entries, [
      turn({ id: 1, createdAt: 500 }),
      turn({ id: 2, kind: "prompt", createdAt: 2100 }),
    ]);
    expect(groups.map((g) => g.entries.map((e) => e.activity.id))).toEqual([
      [200],
      [201, 202],
    ]);
  });

  test("lines before any turn form their own group; empty turns are kept", () => {
    const groups = groupByTurn(
      transcriptEntries([activity({ id: 300, createdAt: 10 })]),
      [turn({ id: 1, createdAt: 50 })],
    );
    expect(groups.map((g) => [g.turn?.id ?? null, g.entries.length])).toEqual([
      [null, 1],
      [1, 0],
    ]);
  });
});

describe("planTurnIndex", () => {
  test("pins the plan to the turn holding the last plan update", () => {
    const activities = [
      activity({
        id: 400,
        kind: "session_update",
        content: { plan: [] },
        createdAt: 1500,
      }),
    ];
    const groups = groupByTurn(transcriptEntries(activities), [
      turn({ id: 1, createdAt: 1000 }),
      turn({ id: 2, createdAt: 2000 }),
    ]);
    expect(planTurnIndex(activities, groups)).toBe(0);
  });

  test("with no plan update, the last turn", () => {
    const groups = groupByTurn([], [turn({ id: 1 }), turn({ id: 2 })]);
    expect(planTurnIndex([], groups)).toBe(1);
    expect(planTurnIndex([], [])).toBe(-1);
  });
});

describe("collapseResult", () => {
  test("eight lines show whole; nine collapse to eight", () => {
    const eight = Array.from({ length: 8 }, (_, i) => `l${i}`).join("\n");
    expect(collapseResult(eight)).toEqual({ head: eight, hidden: 0 });
    const nine = `${eight}\nl8`;
    expect(collapseResult(nine)).toEqual({ head: eight, hidden: 1 });
  });
});

describe("orderLinks", () => {
  test("pull requests come first, the rest keep their order", () => {
    const links = [
      { label: "Hypotenuse", url: "a" },
      { label: "Pull request #2", url: "b" },
      { label: "Docs", url: "c" },
      { label: "Pull Request", url: "d" },
    ];
    expect(orderLinks(links).map((l) => l.url)).toEqual(["b", "d", "a", "c"]);
  });
});

describe("canCancelSession", () => {
  test("a live turn or a waiting session can be cancelled; nothing else", () => {
    expect(canCancelSession("active", [{ status: "running" }])).toBe(true);
    expect(canCancelSession("pending", [{ status: "queued" }])).toBe(true);
    expect(canCancelSession("awaitingInput", [{ status: "completed" }])).toBe(
      true,
    );
    expect(canCancelSession("complete", [{ status: "completed" }])).toBe(false);
    expect(canCancelSession("error", [])).toBe(false);
  });
});

describe("content readers", () => {
  test("bodyOf, actionOf, and selectOptions read what is there", () => {
    expect(bodyOf({ body: "hi" })).toBe("hi");
    expect(bodyOf(null)).toBe("");
    expect(actionOf({ action: "Read", parameter: "a.ts" })).toEqual({
      action: "Read",
      parameter: "a.ts",
      result: null,
    });
    expect(
      selectOptions({ options: [{ label: "Yes" }, { value: "no" }, "maybe"] }),
    ).toEqual(["Yes", "no", "maybe"]);
    expect(selectOptions(null)).toEqual([]);
  });

  test("turnDuration counts from the claim", () => {
    expect(turnDuration({ claimedAt: null, finishedAt: null }, 0)).toBeNull();
    expect(turnDuration({ claimedAt: 0, finishedAt: 42_000 }, 0)).toBe("42s");
    expect(turnDuration({ claimedAt: 0, finishedAt: null }, 372_000)).toBe(
      "6m 12s",
    );
    expect(turnDuration({ claimedAt: 0, finishedAt: 3_720_000 }, 0)).toBe(
      "1h 2m",
    );
  });
});
