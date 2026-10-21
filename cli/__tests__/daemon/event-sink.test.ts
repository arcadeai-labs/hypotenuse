import { describe, expect, test } from "bun:test";
import type {
  CompleteRequest,
  EventsRequest,
} from "../../../protocol/src/index";
import { ApiError } from "../../src/api/client";
import type { DaemonApi } from "../../src/daemon/daemon-api";
import { BATCH_EVENTS, EventSink } from "../../src/daemon/event-sink";
import { DaemonLog } from "../../src/daemon/log";
import { StateDb } from "../../src/daemon/state";

/**
 * The EventSink against a scripted server: batches of at most 50 in `seq`
 * order, a completion only after its events, the refusals the protocol
 * names, and a retry after the server comes back.
 */

/** A scripted `daemon:events` / `daemon:complete`. */
class FakeServer {
  readonly batches: EventsRequest[] = [];
  readonly completions: CompleteRequest[] = [];
  readonly calls: string[] = [];
  /** Throw this (once) on the next events call. */
  next: ApiError | Error | null = null;
  cancelRequested = false;

  /**
   * @param body - The batch.
   * @returns The answer.
   */
  async events(body: EventsRequest) {
    this.calls.push(`events:${body.events.map((e) => e.seq).join(",")}`);
    if (this.next) {
      const error = this.next;
      this.next = null;
      throw error;
    }
    this.batches.push(body);
    return {
      accepted: body.events.length,
      duplicates: 0,
      dropped: 0,
      cancelRequested: this.cancelRequested,
    };
  }

  /**
   * @param body - The completion.
   * @returns The answer.
   */
  async complete(body: CompleteRequest) {
    this.calls.push(`complete:${body.workItemId}`);
    this.completions.push(body);
    return { alreadyTerminal: false };
  }
}

/**
 * A sink over an in-memory database with one claimed session.
 * @returns The parts.
 */
function setup() {
  const state = new StateDb(":memory:");
  state.claimSession({
    agentSessionId: 1,
    linearSessionId: null,
    issueIdentifier: "ENG-1",
    role: "worker",
    repository: null,
    workItemId: 10,
    acpAgentId: "claude",
  });
  const server = new FakeServer();
  const seen = {
    cancel: [] as number[],
    notYours: [] as number[],
    unauthorized: 0,
    completed: [] as number[],
  };
  const sink = new EventSink(
    state,
    server as unknown as DaemonApi,
    new DaemonLog(null, "error", false),
    {
      onCancelRequested: (id) => seen.cancel.push(id),
      onNotYours: (id) => seen.notYours.push(id),
      onUnauthorized: () => seen.unauthorized++,
      onCompleted: (id) => seen.completed.push(id),
      onUnreachable: () => {},
    },
  );
  const target = { agentSessionId: 1, workItemId: 10 };
  const complete = () =>
    sink.complete({
      request: { workItemId: 10, outcome: "completed" },
      active: {
        workItemId: 10,
        agentSessionId: 1,
        role: "worker",
        agentId: "claude",
        state: "running",
      },
    });
  return { state, server, seen, sink, target, complete };
}

describe("EventSink", () => {
  test("is durable before emit returns, then sends in seq order, 50 at a time, completion last", async () => {
    const { state, server, sink, target, complete, seen } = setup();
    sink.close(); // queue without flushing, to see the rows
    for (let i = 0; i < 120; i++)
      sink.emit(target, { type: "thought", body: `step ${i}` });
    expect(state.pendingEvents(10).length).toBe(120);
    complete();
    const live = new EventSink(
      state,
      server as unknown as DaemonApi,
      new DaemonLog(null, "error", false),
      {
        onCancelRequested: () => {},
        onNotYours: () => {},
        onUnauthorized: () => {},
        onCompleted: (id) => seen.completed.push(id),
        onUnreachable: () => {},
      },
    );
    expect(await live.drain(5_000)).toBe(true);
    expect(server.batches.map((b) => b.events.length)).toEqual([
      BATCH_EVENTS,
      BATCH_EVENTS,
      20,
    ]);
    expect(server.batches.flatMap((b) => b.events.map((e) => e.seq))).toEqual(
      Array.from({ length: 120 }, (_, i) => i + 1),
    );
    expect(server.calls.at(-1)).toBe("complete:10");
    expect(seen.completed).toEqual([10]);
    expect(state.pendingWorkItems()).toEqual([]);
  });

  test("a network failure keeps everything queued; the next try resends the same events", async () => {
    const { server, sink, target, complete, state } = setup();
    server.next = new ApiError("Could not reach the server", 0);
    sink.emit(target, { type: "thought", body: "one" });
    sink.emit(target, { type: "response", body: "two" });
    complete();
    await Bun.sleep(50);
    expect(state.pendingEvents(10).length).toBeGreaterThan(0);
    expect(server.completions).toEqual([]);
    expect(await sink.drain(5_000)).toBe(true);
    const sent = server.batches.flatMap((b) => b.events);
    expect(sent.map((e) => e.type)).toEqual(["thought", "response"]);
    expect(server.completions.map((c) => c.outcome)).toEqual(["completed"]);
  });

  test("409 NOT_YOUR_WORK drops the work item's queue and says so", async () => {
    const { server, sink, target, complete, state, seen } = setup();
    server.next = new ApiError("not yours", 409, "NOT_YOUR_WORK");
    sink.emit(target, { type: "thought", body: "one" });
    complete();
    await sink.drain(2_000);
    expect(seen.notYours).toEqual([10]);
    expect(state.pendingWorkItems()).toEqual([]);
    expect(server.completions).toEqual([]);
  });

  test("a 406 naming one event drops that event and sends the rest", async () => {
    const { server, sink, target, state } = setup();
    sink.close();
    sink.emit(target, { type: "thought", body: "good" });
    sink.emit(target, { type: "thought", body: "bad" });
    sink.emit(target, { type: "thought", body: "good too" });
    server.next = new ApiError(
      "invalid",
      406,
      "CONNECTION_ACTION_PARAM_VALIDATION",
      { key: "events.1.body" },
    );
    const live = new EventSink(
      state,
      server as unknown as DaemonApi,
      new DaemonLog(null, "error", false),
      {
        onCancelRequested: () => {},
        onNotYours: () => {},
        onUnauthorized: () => {},
        onCompleted: () => {},
        onUnreachable: () => {},
      },
    );
    await live.drain(2_000);
    expect(
      server.batches.flatMap((b) =>
        b.events.map((e) => (e as { body: string }).body),
      ),
    ).toEqual(["good", "good too"]);
  });

  test("a 413 halves the batch and resends", async () => {
    const { server, sink, target, state } = setup();
    sink.close();
    for (let i = 0; i < 10; i++)
      sink.emit(target, { type: "thought", body: `n${i}` });
    server.next = new ApiError("too large", 413, "PAYLOAD_TOO_LARGE");
    const live = new EventSink(
      state,
      server as unknown as DaemonApi,
      new DaemonLog(null, "error", false),
      {
        onCancelRequested: () => {},
        onNotYours: () => {},
        onUnauthorized: () => {},
        onCompleted: () => {},
        onUnreachable: () => {},
      },
    );
    await live.drain(2_000);
    expect(server.calls[0]).toBe("events:1,2,3,4,5,6,7,8,9,10");
    expect(server.batches.map((b) => b.events.length)).toEqual([5, 5]);
  });

  test("cancelRequested on an answer reaches the supervisor; a 401 stops flushing", async () => {
    const first = setup();
    first.server.cancelRequested = true;
    first.sink.emit(first.target, { type: "thought", body: "x" });
    await first.sink.drain(2_000);
    expect(first.seen.cancel).toEqual([10]);

    const second = setup();
    second.server.next = new ApiError("no", 401);
    second.sink.emit(second.target, { type: "thought", body: "x" });
    await Bun.sleep(50);
    expect(second.seen.unauthorized).toBe(1);
    expect(second.state.pendingEvents(10).length).toBe(1);
  });
});
