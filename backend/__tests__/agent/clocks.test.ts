import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { api } from "keryx";
import { HOOK_TIMEOUT, runAction } from "../setup";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  conversationRow,
  readEntries,
  runTicks,
  setColumns,
  startConversation,
} from "./harness";

/**
 * The clocks find, from the rows alone, every tick a lost job owed. Time is
 * moved by writing the columns they read.
 */
let stage: AgentStage;

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  stage.models.reset();
});

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/** Queued ticks, by conversation. */
async function queuedTicks(): Promise<number[]> {
  const jobs = (await api.resque.queue.queued("agents", 0, -1)) as {
    class: string;
    args: { conversationId: number }[];
  }[];
  return jobs
    .filter((j) => j.class === "agent:tick")
    .map((j) => Number(j.args[0].conversationId));
}

describe("agents:reap", () => {
  test("an expired lease is cleared, a tick owed, and one enqueued; a live one is left alone", async () => {
    const dead = (await startConversation(stage, "One.")).body.conversation.id;
    const live = (await startConversation(stage, "Two.")).body.conversation.id;
    await clearLoopQueues();
    await setColumns(dead, {
      leaseOwner: "gone",
      leaseExpiresAt: new Date(Date.now() - 5_000),
      wakeRequestedAt: null,
    });
    await setColumns(live, {
      leaseOwner: "alive",
      leaseExpiresAt: new Date(Date.now() + 60_000),
      wakeRequestedAt: null,
    });
    const { reaped } = await runAction<{ reaped: number[] }>("agents:reap");
    expect(reaped).toEqual([dead]);
    expect(await queuedTicks()).toEqual([dead]);
    expect((await conversationRow(dead)).leaseOwner).toBeNull();
    expect((await conversationRow(live)).leaseOwner).toBe("alive");
  });
});

describe("agents:wake-due", () => {
  test("an owed tick older than the stale window with no lease is re-enqueued; a fresh one is not", async () => {
    const stale = (await startConversation(stage, "A.")).body.conversation.id;
    const fresh = (await startConversation(stage, "B.")).body.conversation.id;
    await clearLoopQueues();
    await setColumns(stale, { wakeRequestedAt: new Date(Date.now() - 60_000) });
    const result = await runAction<{ owed: number[] }>("agents:wake-due");
    expect(result.owed).toContain(stale);
    expect(result.owed).not.toContain(fresh);
    expect(await queuedTicks()).toEqual([stale]);
  });

  test("a due timer wakes its conversation; a future one does not", async () => {
    stage.models.play([
      { toolCalls: [{ name: "wait_for", input: { seconds: 60 } }] },
      { toolCalls: [{ name: "wait_for", input: { seconds: 60 } }] },
    ]);
    const due = (await startConversation(stage, "Wait.")).body.conversation.id;
    await runTicks();
    const later = (await startConversation(stage, "Wait.")).body.conversation
      .id;
    await runTicks();
    await setColumns(due, { waitingOn: { kind: "timer", at: Date.now() - 1 } });
    const result = await runAction<{ timers: number[] }>("agents:wake-due");
    expect(result.timers).toEqual([due]);
    expect((await conversationRow(due)).state).toBe("working");
    expect((await conversationRow(later)).state).toBe("waiting");
    expect(await queuedTicks()).toContain(due);
    expect(await queuedTicks()).not.toContain(later);
  });

  test("a timed-out question wakes with a system message, once", async () => {
    stage.models.play([
      {
        toolCalls: [
          {
            name: "ask_question",
            input: { question: "Now?", timeoutSeconds: 60 },
          },
        ],
      },
    ]);
    const id = (await startConversation(stage, "Ask me.")).body.conversation.id;
    await runTicks();
    const row = await conversationRow(id);
    if (row.waitingOn?.kind !== "answer") throw new Error("not waiting");
    await setColumns(id, {
      waitingOn: { ...row.waitingOn, timeoutAt: Date.now() - 1 },
    });
    const first = await runAction<{ questionTimeouts: number[] }>(
      "agents:wake-due",
    );
    expect(first.questionTimeouts).toEqual([id]);
    const second = await runAction<{ questionTimeouts: number[] }>(
      "agents:wake-due",
    );
    expect(second.questionTimeouts).toEqual([]);
    stage.models.play([
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "Moving on." } }],
      },
    ]);
    await runTicks();
    const { entries } = await readEntries(stage, id);
    const system = entries.find(
      (e) =>
        e.kind === "message" &&
        e.role === "user" &&
        e.content.source === "system",
    );
    expect(String(system?.content.text)).toContain("No answer");
  });
});
