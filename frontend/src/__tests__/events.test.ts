import { describe, expect, test } from "bun:test";
import { COMMANDS, type CommandContext } from "../commands/registry";
import {
  eventsChannel,
  isEventsPayload,
  type ListedEvent,
  OUTCOME_LABELS,
  outcomeGlyph,
  placement,
  roleReason,
} from "../utils/events";

/**
 * An event as the list serializes it, with overrides.
 * @param overrides - Fields to change.
 * @returns The event.
 */
function event(overrides: Partial<ListedEvent> = {}): ListedEvent {
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
    webhookTimestamp: 0,
    receivedAt: 0,
    processedAt: 0,
    session: null,
    turn: null,
    ...overrides,
  };
}

/** A session as an event carries it. */
const session: NonNullable<ListedEvent["session"]> = {
  id: 4,
  issueTitle: "Fix it",
  status: "active",
  role: "worker",
  routingRule: null,
  dispatched: false,
};

/** A turn as an event carries it. */
const turn: NonNullable<ListedEvent["turn"]> = {
  id: 9,
  kind: "session_created",
  status: "queued",
  repository: null,
  runner: null,
  waitingReason: null,
  waitingCode: "no_runners",
  cancelReason: null,
  finishedAt: null,
};

describe("the events channel", () => {
  test("is the project's events channel, and only its frame is read", () => {
    expect(eventsChannel(7)).toBe("project:7:events");
    expect(isEventsPayload({ event: "events" })).toBe(true);
    expect(isEventsPayload({ event: "join", presenceKey: "x" })).toBe(false);
    expect(isEventsPayload({ event: "sessions" })).toBe(false);
    expect(isEventsPayload(null)).toBe(false);
  });
});

describe("outcomes", () => {
  test("every outcome has words and a shared glyph", () => {
    expect(Object.keys(OUTCOME_LABELS).sort()).toEqual(
      [
        "duplicate_of_dispatch",
        "failed",
        "handled",
        "ignored",
        "pending",
        "unknown_integration",
      ].sort(),
    );
    expect(outcomeGlyph("handled")).toBe("complete");
    expect(outcomeGlyph("failed")).toBe("error");
    expect(outcomeGlyph("ignored")).toBe("stale");
    expect(outcomeGlyph("pending")).toBe("pending");
  });
});

describe("routing in words", () => {
  test("a role names the rule that chose it, a dispatch, or the default", () => {
    expect(roleReason(event())).toBeNull();
    expect(roleReason(event({ session }))).toBe("default");
    expect(
      roleReason(
        event({
          session: {
            ...session,
            role: "manager",
            routingRule: { id: 2, name: "/manage" },
          },
        }),
      ),
    ).toBe("rule /manage");
    expect(
      roleReason(event({ session: { ...session, dispatched: true } })),
    ).toBe("dispatched");
    expect(
      roleReason(event({ session: { ...session, role: null } })),
    ).toBeNull();
  });

  test("a turn says why it waits, which runner has it, or how it ended", () => {
    expect(placement(event())).toBeNull();
    expect(placement(event({ turn }))).toBe(
      "Waiting: No runners in this project",
    );
    const runner = { id: 3, name: "laptop" };
    expect(
      placement(event({ turn: { ...turn, status: "offered", runner } })),
    ).toBe("Offered to laptop");
    expect(
      placement(event({ turn: { ...turn, status: "running", runner } })),
    ).toBe("Running on laptop");
    expect(
      placement(event({ turn: { ...turn, status: "completed", runner } })),
    ).toBe("Completed on laptop");
    expect(
      placement(
        event({
          turn: { ...turn, status: "cancelled", cancelReason: "issue_closed" },
        }),
      ),
    ).toBe("Cancelled: issue_closed");
  });
});

describe("the command palette", () => {
  test("Go to Events is there for whoever may list events, on g e", () => {
    const command = COMMANDS.find((c) => c.id === "go-events");
    expect(command?.shortcut).toBe("g e");
    const ctx = (may: boolean) =>
      ({
        may: (name: string) => may && name === "trigger-event:list",
      }) as unknown as CommandContext;
    expect(command?.when?.(ctx(true))).toBe(true);
    expect(command?.when?.(ctx(false))).toBe(false);
  });
});
