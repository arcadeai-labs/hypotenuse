import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { api, config } from "keryx";
import { conversationInbox } from "../../schema/conversation_inbox";
import { call, HOOK_TIMEOUT, runAction } from "../setup";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  conversationRow,
  readEntries,
  runTicks,
  sendMessage,
  setColumns,
  shape,
  startConversation,
  startTick,
  untilRequests,
} from "./harness";

/**
 * **One test per reachable cell** of the conversation state table
 * (`ops/ConversationOps.ts`, and the tick's table in `ops/TickOps.ts`), each
 * named `<state> × <event>`. The cells common to every wait are proven with
 * the timer wait, which shares the row; the approval wait has its own suite
 * under `__tests__/mcp/`, and the sandbox wait under `__tests__/sandbox/`.
 */
let stage: AgentStage;
let defaults: typeof config.agents;

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
  defaults = { ...config.agents };
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  Object.assign(config.agents, defaults);
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
});

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/** A step that replies and ends the turn. */
const reply = (text: string, expect?: Record<string, unknown>) => ({
  toolCalls: [{ name: "reply_and_wait", input: { text } }],
  ...(expect ? { expect } : {}),
});

/**
 * A conversation that has answered once and is resting.
 * @returns Its id.
 */
async function hibernating(): Promise<number> {
  stage.models.play([reply("Hello.")]);
  const res = await startConversation(stage, "Hello?");
  await runTicks();
  return res.body.conversation.id;
}

/**
 * A conversation waiting on the answer to a question.
 * @param timeoutSeconds - The question's timeout, if any.
 * @returns Its id.
 */
async function waitingOnAnswer(timeoutSeconds?: number): Promise<number> {
  stage.models.play([
    {
      toolCalls: [
        {
          name: "ask_question",
          input: {
            question: "Which tower?",
            options: ["North", "South"],
            ...(timeoutSeconds ? { timeoutSeconds } : {}),
          },
        },
      ],
    },
  ]);
  const res = await startConversation(stage, "Find the princess.");
  await runTicks();
  return res.body.conversation.id;
}

/**
 * A conversation sleeping on a `wait_for` timer an hour out.
 * @returns Its id.
 */
async function waitingOnTimer(): Promise<number> {
  stage.models.play([
    {
      toolCalls: [
        { name: "wait_for", input: { seconds: 3600, note: "the tide" } },
      ],
    },
  ]);
  const res = await startConversation(stage, "Wait for the tide.");
  await runTicks();
  return res.body.conversation.id;
}

/**
 * Cancel over HTTP.
 * @param id - The conversation.
 * @returns The status and body.
 */
async function cancel(id: number) {
  return call<{ conversation: { state: string }; result: string }>(
    stage.u.url,
    stage.u.peach,
    "POST",
    `/project/${stage.u.projectId}/conversation/${id}/cancel`,
  );
}

/**
 * Undelivered inbox rows.
 * @param id - The conversation.
 * @returns How many.
 */
async function pendingInbox(id: number): Promise<number> {
  const rows = await api.db.db
    .select()
    .from(conversationInbox)
    .where(
      and(
        eq(conversationInbox.conversationId, id),
        isNull(conversationInbox.deliveredAt),
      ),
    );
  return rows.length;
}

describe("working", () => {
  test("working × inbound message (steer): it enters at the next step", async () => {
    stage.models.play([
      {
        hang: true,
        toolCalls: [{ name: "search_history", input: { query: "x" } }],
      },
      reply("Steered.", { lastMessageIncludes: "Turn left" }),
    ]);
    const res = await startConversation(stage, "Walk.");
    const id = res.body.conversation.id;
    const tick = startTick(id);
    await untilRequests(stage, 1);
    const sent = await sendMessage(stage, id, "Turn left", {
      delivery: "steer",
    });
    expect(sent.body.conversation.state).toBe("working");
    stage.models.release();
    await tick;
    expect(await shape(id)).toEqual([
      "status_change:new→working",
      "message:user",
      "context_update",
      "message:assistant",
      "tool_call_intent:search_history",
      "tool_result:search_history",
      "message:user",
      "message:assistant",
      "tool_call_intent:reply_and_wait",
      "tool_result:reply_and_wait",
      "status_change:working→hibernating",
    ]);
  });

  test("working × inbound message (queue): it enters when the turn ends", async () => {
    stage.models.play([
      {
        hang: true,
        toolCalls: [{ name: "search_history", input: { query: "x" } }],
      },
      reply("First turn.", { noMessageIncludes: "Later, please" }),
      reply("Second turn.", { lastMessageIncludes: "Later, please" }),
    ]);
    const res = await startConversation(stage, "Walk.");
    const id = res.body.conversation.id;
    const tick = startTick(id);
    await untilRequests(stage, 1);
    await sendMessage(stage, id, "Later, please", { delivery: "queue" });
    stage.models.release();
    await tick;
    const row = await conversationRow(id);
    expect(row.state).toBe("hibernating");
    expect(row.epoch).toBe(2);
    expect(stage.models.completions).toHaveLength(3);
  });

  test("working × reply_and_wait → hibernating, and with a queued message → a new turn", async () => {
    const id = await hibernating();
    expect((await conversationRow(id)).state).toBe("hibernating");
    // The queued-message half is the cell above's second turn.
  });

  test("working × complete → ended (completed)", async () => {
    stage.models.play([
      { toolCalls: [{ name: "complete", input: { summary: "All done." } }] },
    ]);
    const res = await startConversation(stage, "Finish.");
    await runTicks();
    const row = await conversationRow(res.body.conversation.id);
    expect(row.state).toBe("ended");
    expect(row.outcome).toBe("completed");
  });

  test("working × fail → ended (failed)", async () => {
    stage.models.play([
      {
        toolCalls: [
          { name: "fail", input: { reason: "No key to the tower." } },
        ],
      },
    ]);
    const res = await startConversation(stage, "Open the tower.");
    await runTicks();
    const row = await conversationRow(res.body.conversation.id);
    expect(row.state).toBe("ended");
    expect(row.outcome).toBe("failed");
  });

  test("working × complete with inbox rows pending → stays working, a new turn, epoch + 1", async () => {
    stage.models.play([
      {
        hang: true,
        toolCalls: [{ name: "complete", input: { summary: "Done." } }],
      },
      reply("And this too.", { lastMessageIncludes: "One more thing" }),
    ]);
    const res = await startConversation(stage, "Finish.");
    const id = res.body.conversation.id;
    const tick = startTick(id);
    await untilRequests(stage, 1);
    await sendMessage(stage, id, "One more thing", { delivery: "queue" });
    stage.models.release();
    await tick;
    const row = await conversationRow(id);
    expect(row.state).toBe("hibernating");
    expect(row.outcome).toBeNull();
    expect(row.epoch).toBe(2);
    expect(await shape(id)).toContain("status_change:ended→working");
  });

  test("working × wait_for → waiting (timer)", async () => {
    const id = await waitingOnTimer();
    const row = await conversationRow(id);
    expect(row.state).toBe("waiting");
    expect(row.waitingOn?.kind).toBe("timer");
    expect(row.leaseOwner).toBeNull();
  });

  test("working × ask_question → waiting (answer)", async () => {
    const id = await waitingOnAnswer();
    const row = await conversationRow(id);
    expect(row.state).toBe("waiting");
    expect(row.waitingOn).toMatchObject({ kind: "answer", timeoutAt: null });
  });

  test("working × cancel → the step is aborted and the conversation ends cancelled", async () => {
    config.agents.heartbeatMs = 25;
    stage.models.play([{ hang: true, text: "never" }]);
    const res = await startConversation(stage, "Think forever.");
    const id = res.body.conversation.id;
    const tick = startTick(id);
    await untilRequests(stage, 1);
    const cancelled = await cancel(id);
    expect(cancelled.body.result).toBe("requested");
    expect(await tick).toMatchObject({ ended: "cancelled" });
    const row = await conversationRow(id);
    expect(row.state).toBe("ended");
    expect(row.outcome).toBe("cancelled");
    expect(row.cancelRequestedAt).toBeNull();
  });

  test("working × lease expired → agents:reap owes a tick and the next tick recovers", async () => {
    stage.models.play([reply("Recovered.")]);
    const res = await startConversation(stage, "Hello?");
    const id = res.body.conversation.id;
    // A tick claimed it and died: a lease in the past, no tick queued.
    await api.resque.queue.delQueue("agents");
    await setColumns(id, {
      leaseOwner: "dead-worker",
      leaseExpiresAt: new Date(Date.now() - 1000),
      wakeRequestedAt: null,
    });
    const reaped = await runAction<{ reaped: number[] }>("agents:reap");
    expect(reaped.reaped).toContain(id);
    const owed = await conversationRow(id);
    expect(owed.wakeRequestedAt).not.toBeNull();
    expect(owed.leaseOwner).toBeNull();
    await runTicks();
    expect((await conversationRow(id)).state).toBe("hibernating");
  });
});

describe("hibernating", () => {
  test("hibernating × inbound message → working, epoch + 1, woken", async () => {
    const id = await hibernating();
    stage.models.play([reply("Again.")]);
    const sent = await sendMessage(stage, id, "Again?");
    expect(sent.body.conversation.state).toBe("working");
    expect(sent.body.conversation.epoch).toBe(2);
    expect(await api.resque.queue.length("agents")).toBe(1);
    await runTicks();
    expect((await conversationRow(id)).state).toBe("hibernating");
  });

  test("hibernating × cancel → ended (cancelled)", async () => {
    const id = await hibernating();
    const res = await cancel(id);
    expect(res.body.result).toBe("ended");
    const row = await conversationRow(id);
    expect(row.state).toBe("ended");
    expect(row.outcome).toBe("cancelled");
  });
});

describe("waiting on an answer", () => {
  test("waiting (answer) × inbound message → it is the answer: working, same turn", async () => {
    const id = await waitingOnAnswer();
    const before = await conversationRow(id);
    stage.models.play([
      reply("To the north tower.", { lastMessageIncludes: "North" }),
    ]);
    const sent = await sendMessage(stage, id, "North");
    expect(sent.body.conversation.state).toBe("working");
    expect(sent.body.conversation.waitingOn).toBeNull();
    expect(sent.body.conversation.epoch).toBe(before.epoch);
    await runTicks();
    expect((await conversationRow(id)).state).toBe("hibernating");
  });

  test("waiting (answer) × timer due → working, told nobody answered", async () => {
    const id = await waitingOnAnswer(600);
    const row = await conversationRow(id);
    if (row.waitingOn?.kind !== "answer") throw new Error("not waiting");
    await setColumns(id, {
      waitingOn: { ...row.waitingOn, timeoutAt: Date.now() - 1000 },
    });
    stage.models.play([
      reply("I'll pick the north.", { lastMessageIncludes: "No answer" }),
    ]);
    const due = await runAction<{ questionTimeouts: number[] }>(
      "agents:wake-due",
    );
    expect(due.questionTimeouts).toContain(id);
    expect((await conversationRow(id)).state).toBe("working");
    await runTicks();
    expect((await conversationRow(id)).state).toBe("hibernating");
  });

  test("waiting (answer) × cancel → ended (cancelled)", async () => {
    const id = await waitingOnAnswer();
    const res = await cancel(id);
    expect(res.body.result).toBe("ended");
    const row = await conversationRow(id);
    expect(row.state).toBe("ended");
    expect(row.waitingOn).toBeNull();
  });
});

describe("waiting on a timer (the approval and sandbox rows' shape)", () => {
  test("waiting (timer) × inbound message → kept until the wait ends", async () => {
    const id = await waitingOnTimer();
    const sent = await sendMessage(stage, id, "Are you there?");
    expect(sent.body.conversation.state).toBe("waiting");
    expect(await pendingInbox(id)).toBe(1);
    expect(await api.resque.queue.length("agents")).toBe(0);
  });

  test("waiting (timer) × timer due → working, and kept messages are delivered", async () => {
    const id = await waitingOnTimer();
    await sendMessage(stage, id, "Still there?", { delivery: "steer" });
    await setColumns(id, { waitingOn: { kind: "timer", at: Date.now() - 1 } });
    stage.models.play([
      reply("The tide is in.", { lastMessageIncludes: "Still there?" }),
    ]);
    const due = await runAction<{ timers: number[] }>("agents:wake-due");
    expect(due.timers).toContain(id);
    const woken = await conversationRow(id);
    expect(woken.state).toBe("working");
    expect(woken.waitingOn).toBeNull();
    await runTicks();
    expect(await pendingInbox(id)).toBe(0);
    expect((await conversationRow(id)).state).toBe("hibernating");
  });

  test("waiting (timer) × cancel → ended (cancelled)", async () => {
    const id = await waitingOnTimer();
    const res = await cancel(id);
    expect(res.body.result).toBe("ended");
    expect((await conversationRow(id)).outcome).toBe("cancelled");
  });
});

describe("ended", () => {
  test("ended × inbound message → working, epoch + 1, outcome cleared", async () => {
    stage.models.play([
      { toolCalls: [{ name: "complete", input: { summary: "Done." } }] },
    ]);
    const res = await startConversation(stage, "Finish.");
    await runTicks();
    const id = res.body.conversation.id;
    stage.models.play([reply("Back again.")]);
    const sent = await sendMessage(stage, id, "One more?");
    expect(sent.body.conversation).toMatchObject({
      state: "working",
      outcome: null,
      epoch: 2,
    });
    await runTicks();
    expect((await conversationRow(id)).state).toBe("hibernating");
  });

  test("ended × cancel → no-op", async () => {
    const id = await hibernating();
    await cancel(id);
    const before = await readEntries(stage, id);
    const again = await cancel(id);
    expect(again.status).toBe(200);
    expect(again.body.result).toBe("noop");
    const after = await readEntries(stage, id);
    expect(after.entries).toHaveLength(before.entries.length);
  });
});
