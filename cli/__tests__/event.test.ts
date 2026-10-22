import { describe, expect, test } from "bun:test";
import {
  describeEvent,
  routedAs,
  type TriggerEvent,
  turnPlace,
} from "../src/commands/event";

/**
 * An event as the server serializes it, with overrides.
 * @param overrides - Fields to change.
 * @returns The event.
 */
function event(overrides: Partial<TriggerEvent> = {}): TriggerEvent {
  return {
    id: 1,
    type: "linear",
    deliveryId: "d-1",
    eventType: "AgentSessionEvent",
    action: "created",
    outcome: "handled",
    summary: "Started a session on ENG-1.",
    error: null,
    issueIdentifier: "ENG-1",
    receivedAt: 0,
    processedAt: 0,
    session: {
      id: 4,
      issueTitle: "Fix it",
      status: "active",
      role: "worker",
      routingRule: null,
      dispatched: false,
    },
    turn: {
      id: 9,
      kind: "session_created",
      status: "queued",
      repository: null,
      runner: null,
      waitingReason: "No runner takes worker work to ENG.",
      waitingCode: "no_runners",
      cancelReason: null,
      finishedAt: null,
    },
    ...overrides,
  };
}

describe("routedAs", () => {
  test("names the rule, a dispatch, or the default", () => {
    expect(routedAs(event())).toBe("worker (default)");
    expect(
      routedAs(
        event({
          session: {
            ...event().session!,
            role: "manager",
            routingRule: { id: 1, name: "/manage" },
          },
        }),
      ),
    ).toBe("manager (rule /manage)");
    expect(
      routedAs(event({ session: { ...event().session!, dispatched: true } })),
    ).toBe("worker (dispatched)");
    expect(routedAs(event({ session: null }))).toBe("-");
  });
});

describe("turnPlace", () => {
  test("why it waits, where it runs, or how it ended", () => {
    expect(turnPlace(event())).toBe("queued: no_runners");
    const runner = { id: 2, name: "laptop" };
    expect(
      turnPlace(
        event({ turn: { ...event().turn!, status: "running", runner } }),
      ),
    ).toBe("running on laptop");
    expect(
      turnPlace(
        event({
          turn: { ...event().turn!, status: "cancelled", cancelReason: "stop" },
        }),
      ),
    ).toBe("cancelled: stop");
    expect(turnPlace(event({ turn: null }))).toBe("-");
  });
});

describe("describeEvent", () => {
  test("a member is told the payload is for admins; an admin sees it", () => {
    const member = describeEvent(event(), null);
    expect(member).toContain("routed as  worker (default)");
    expect(member).toContain("waiting    No runner takes worker work to ENG.");
    expect(member).toContain("payload    (project admins only)");
    const admin = describeEvent(event(), { type: "AgentSessionEvent" });
    expect(admin).toContain('"type": "AgentSessionEvent"');
    expect(admin).not.toContain("project admins only");
  });
});
