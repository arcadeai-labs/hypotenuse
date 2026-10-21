import { describe, expect, test } from "bun:test";
import {
  ClaimRequest,
  ClaimResponse,
  CompleteRequest,
  EventsRequest,
  EventsResponse,
  MAX_EVENTS_PER_BATCH,
  SessionEvent,
} from "../src/index";

/** The assignment docs/RUNNER_PROTOCOL.md shows, verbatim. */
const documentedAssignment = {
  workItemId: 813,
  agentSessionId: 92,
  type: "linear",
  externalSessionId: "f6c1",
  externalSessionUrl:
    "https://linear.app/acme/issue/ENG-123#agent-session-f6c1",
  dashboardUrl: "https://www.hypotenuse.cloud/sessions/92",
  kind: "session_created",
  role: "worker",
  agentId: "claude",
  fresh: true,
  repository: { remote: "github.com/acme/web", baseBranch: "main" },
  branch: "hypotenuse/eng-123-fix-checkout-rounding",
  issue: {
    id: "9a0",
    identifier: "ENG-123",
    title: "Fix checkout rounding",
    description: "…",
    url: "https://linear.app/acme/issue/ENG-123/…",
    teamKey: "ENG",
    labels: ["bug"],
    state: { name: "Todo", type: "unstarted" },
    parent: null,
    project: { id: "p1", name: "Checkout" },
  },
  instruction: null,
  promptContext: '<issue identifier="ENG-123">…</issue>',
  guidance: [
    { origin: "team", teamKey: "ENG", body: "Always open a draft PR." },
    { origin: "workspace", body: "Reference the issue id in commits." },
  ],
  previousComments: null,
  history: [
    {
      seq: 1,
      activityId: 330,
      direction: "outbound",
      type: "thought",
      body: "On it — finding a runner for ENG-123.",
      signal: null,
    },
  ],
  prompt: null,
  origin: "delegation",
  humanDelegated: true,
  leaseExpiresAt: 1792478475000,
};

/**
 * An event envelope with a fresh id.
 * @param seq - Its sequence number.
 * @returns The envelope fields.
 */
function envelope(seq = 1) {
  return { eventId: crypto.randomUUID(), seq, at: 1792478400000 };
}

describe("daemon:claim", () => {
  test("the request is strict and the ids optional", () => {
    expect(ClaimRequest.safeParse({}).success).toBe(true);
    expect(ClaimRequest.safeParse({ workItemIds: [813] }).success).toBe(true);
    expect(ClaimRequest.safeParse({ workItemIds: [0] }).success).toBe(false);
    expect(ClaimRequest.safeParse({ anything: true }).success).toBe(false);
  });

  test("the documented assignment parses, and new fields pass through", () => {
    const parsed = ClaimResponse.parse({
      assignment: { ...documentedAssignment, later: "added" },
    });
    expect(parsed.assignment).toMatchObject({
      workItemId: 813,
      later: "added",
    });
    expect(ClaimResponse.parse({ assignment: null }).assignment).toBeNull();
  });
});

describe("SessionEvent", () => {
  test("every documented type parses", () => {
    const events = [
      { type: "thought", body: "Thinking", ephemeral: true },
      { type: "action", action: "Read", parameter: "a.ts", ephemeral: false },
      { type: "action", action: "Read", parameter: "a.ts", result: "ok" },
      { type: "elicitation", body: "Which?" },
      {
        type: "elicitation",
        body: "Which?",
        signal: "select",
        signalMetadata: {
          options: [{ label: "A", value: "a" }, { value: "b" }],
        },
      },
      {
        type: "elicitation",
        body: "Sign in",
        signal: "auth",
        signalMetadata: {
          url: "https://example.test/auth",
          providerName: "GitHub",
        },
      },
      { type: "response", body: "Done" },
      { type: "error", body: "Broke" },
      {
        type: "plan",
        entries: [
          { content: "One", status: "completed" },
          { content: "Two", status: "in_progress" },
        ],
      },
      { type: "summary", title: "Fix checkout rounding" },
      {
        type: "external_url",
        label: "Pull Request",
        url: "https://github.com/acme/web/pull/1",
      },
      { type: "usage", inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      { type: "status", state: "running" },
    ];
    for (const event of events) {
      const parsed = SessionEvent.safeParse({ ...envelope(), ...event });
      expect(parsed.success, JSON.stringify(event)).toBe(true);
    }
  });

  test("ephemeral is legal only on a thought or an action", () => {
    for (const type of ["response", "error", "elicitation"]) {
      const parsed = SessionEvent.safeParse({
        ...envelope(),
        type,
        body: "x",
        ephemeral: true,
      });
      expect(parsed.success, type).toBe(false);
    }
  });

  test("Linear's own limits hold: one-line summaries, valid signal metadata, uuid v4 ids", () => {
    const refused = [
      { type: "summary", title: "two\nlines" },
      { type: "summary", title: "x".repeat(256) },
      { type: "summary", title: "   " },
      {
        type: "elicitation",
        body: "?",
        signal: "select",
        signalMetadata: { options: [] },
      },
      {
        type: "elicitation",
        body: "?",
        signal: "auth",
        signalMetadata: { url: "not a url" },
      },
      {
        type: "elicitation",
        body: "?",
        signalMetadata: { options: [{ value: "a" }] },
      },
      { type: "elicitation", body: "?", signal: "stop" },
      { type: "thought", body: "" },
      { type: "external_url", label: "PR", url: "nope" },
      { type: "plan", entries: [{ content: "x", status: "inProgress" }] },
      { type: "status", state: "sleeping" },
      { type: "prompt", body: "agents never write prompts" },
    ];
    for (const event of refused) {
      expect(
        SessionEvent.safeParse({ ...envelope(), ...event }).success,
        JSON.stringify(event),
      ).toBe(false);
    }
    expect(
      SessionEvent.safeParse({
        eventId: "not-a-uuid",
        seq: 1,
        at: 0,
        type: "thought",
        body: "x",
      }).success,
    ).toBe(false);
    expect(
      SessionEvent.safeParse({ ...envelope(0), type: "thought", body: "x" })
        .success,
    ).toBe(false);
  });

  test("a batch carries 1 to 100 events, and the answer is loose", () => {
    const one = { ...envelope(), type: "thought", body: "x" };
    expect(
      EventsRequest.safeParse({ workItemId: 1, events: [one] }).success,
    ).toBe(true);
    expect(EventsRequest.safeParse({ workItemId: 1, events: [] }).success).toBe(
      false,
    );
    const many = Array.from({ length: MAX_EVENTS_PER_BATCH + 1 }, (_, i) => ({
      ...envelope(i + 1),
      type: "thought",
      body: "x",
    }));
    expect(
      EventsRequest.safeParse({ workItemId: 1, events: many }).success,
    ).toBe(false);
    expect(
      EventsResponse.parse({
        accepted: 1,
        duplicates: 0,
        dropped: 0,
        cancelRequested: false,
        later: true,
      }),
    ).toMatchObject({ later: true });
  });
});

describe("daemon:complete", () => {
  test("the documented body parses, and the outcome is one of three", () => {
    expect(
      CompleteRequest.safeParse({
        workItemId: 813,
        outcome: "completed",
        acpSessionId: "sess_01",
        branch: "hypotenuse/eng-123-fix-checkout-rounding",
        error: null,
      }).success,
    ).toBe(true);
    expect(
      CompleteRequest.safeParse({ workItemId: 813, outcome: "done" }).success,
    ).toBe(false);
    expect(
      CompleteRequest.safeParse({
        workItemId: 813,
        outcome: "failed",
        extra: 1,
      }).success,
    ).toBe(false);
  });
});
