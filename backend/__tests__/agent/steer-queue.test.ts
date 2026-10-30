import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { api } from "keryx";
import { HOOK_TIMEOUT } from "../setup";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  conversationRow,
  readEntries,
  runTicks,
  sendMessage,
  startConversation,
  startTick,
  untilRequests,
} from "./harness";

/**
 * Messages that arrive mid-turn: a steer reaches the model before its next
 * step without interrupting the one running, a queued message waits for the
 * turn to end, and a message to a conversation waiting on an answer is the
 * answer. A repeated `requestId` delivers once.
 */
let stage: AgentStage;

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
});

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

const look = {
  toolCalls: [{ name: "search_history", input: { query: "x" } }],
};

describe("steer and queue", () => {
  test("two steers arrive in order between steps; the running step is not interrupted", async () => {
    stage.models.play([
      { ...look, hang: true },
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "Both." } }],
        expect: { lastMessageIncludes: "second steer" },
      },
    ]);
    const res = await startConversation(stage, "Go.");
    const id = res.body.conversation.id;
    const tick = startTick(id);
    await untilRequests(stage, 1);
    await sendMessage(stage, id, "first steer");
    await sendMessage(stage, id, "second steer");
    stage.models.release();
    await tick;
    expect(stage.models.disconnects()).toBe(0);
    const { entries } = await readEntries(stage, id);
    const users = entries
      .filter((e) => e.kind === "message" && e.role === "user")
      .map((e) => e.content.text);
    expect(users).toEqual(["Go.", "first steer", "second steer"]);
    expect((await conversationRow(id)).epoch).toBe(1);
  });

  test("a queued message waits for the turn's end, then starts the next turn in the same tick", async () => {
    stage.models.play([
      { ...look, hang: true },
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "First." } }],
        expect: { noMessageIncludes: "queued question" },
      },
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "Second." } }],
        expect: { lastMessageIncludes: "queued question" },
      },
    ]);
    const res = await startConversation(stage, "Go.");
    const id = res.body.conversation.id;
    const tick = startTick(id);
    await untilRequests(stage, 1);
    await sendMessage(stage, id, "queued question", { delivery: "queue" });
    stage.models.release();
    await tick;
    expect(await api.resque.queue.length("agents")).toBe(0);
    const row = await conversationRow(id);
    expect(row.epoch).toBe(2);
    expect(row.state).toBe("hibernating");
  });

  test("a message to a conversation waiting on an answer is the answer", async () => {
    stage.models.play([
      {
        toolCalls: [
          {
            name: "ask_question",
            input: { question: "Red or green?", options: ["Red", "Green"] },
          },
        ],
      },
      {
        toolCalls: [
          { name: "reply_and_wait", input: { text: "Green it is." } },
        ],
        expect: { lastMessageIncludes: "Green" },
      },
    ]);
    const res = await startConversation(stage, "Pick a pipe.");
    const id = res.body.conversation.id;
    await runTicks();
    expect((await conversationRow(id)).waitingOn?.kind).toBe("answer");
    await sendMessage(stage, id, "Green");
    await runTicks();
    expect((await conversationRow(id)).state).toBe("hibernating");
  });

  test("a repeated requestId is delivered once", async () => {
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Hi." } }] },
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Once." } }] },
    ]);
    const res = await startConversation(stage, "Go.");
    const id = res.body.conversation.id;
    await runTicks();
    const a = await sendMessage(stage, id, "only once", { requestId: "r-1" });
    const b = await sendMessage(stage, id, "only once", { requestId: "r-1" });
    expect(a.body.deduped).toBe(false);
    expect(b.body.deduped).toBe(true);
    await runTicks();
    const { entries } = await readEntries(stage, id);
    expect(entries.filter((e) => e.content.text === "only once")).toHaveLength(
      1,
    );
  });
});
