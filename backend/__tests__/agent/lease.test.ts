import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { api } from "keryx";
import { enqueueTick } from "../../ops/ConversationOps";
import { HOOK_TIMEOUT } from "../setup";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  conversationRow,
  setColumns,
  shape,
  startConversation,
  startTick,
  untilRequests,
} from "./harness";

/**
 * One tick per conversation at a time: the lease is claimed by a conditional
 * update, and every write re-checks it under the row lock.
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

describe("the lease", () => {
  test("two ticks for one conversation → one claims, the other exits", async () => {
    stage.models.play([
      {
        hang: true,
        toolCalls: [{ name: "reply_and_wait", input: { text: "Once." } }],
      },
    ]);
    const res = await startConversation(stage, "Hello?");
    const id = res.body.conversation.id;
    await enqueueTick(await conversationRow(id));
    const first = startTick(id);
    await untilRequests(stage, 1);
    const second = await startTick();
    expect(second).toEqual({ claimed: false, steps: 0, ended: "not-claimed" });
    stage.models.release();
    expect(await first).toMatchObject({ claimed: true, ended: "released" });
    expect(stage.models.completions).toHaveLength(1);
    expect((await conversationRow(id)).state).toBe("hibernating");
  });

  test("a tick whose lease was stolen writes nothing more", async () => {
    stage.models.play([
      {
        hang: true,
        toolCalls: [{ name: "reply_and_wait", input: { text: "Mine." } }],
      },
    ]);
    const res = await startConversation(stage, "Hello?");
    const id = res.body.conversation.id;
    const tick = startTick(id);
    await untilRequests(stage, 1);
    const before = await shape(id);
    await setColumns(id, {
      leaseOwner: "another-tick",
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    stage.models.release();
    expect(await tick).toMatchObject({ ended: "lease-lost" });
    expect(await shape(id)).toEqual(before);
    const row = await conversationRow(id);
    expect(row.leaseOwner).toBe("another-tick");
    expect(row.state).toBe("working");
  });

  test("a tick for a conversation that is not working exits after one query", async () => {
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Hi." } }] },
    ]);
    const res = await startConversation(stage, "Hello?");
    const id = res.body.conversation.id;
    await startTick();
    await enqueueTick(await conversationRow(id));
    expect(await startTick()).toMatchObject({ claimed: false });
  });
});
