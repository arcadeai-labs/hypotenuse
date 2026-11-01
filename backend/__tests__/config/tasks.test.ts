import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, config } from "keryx";
import { HOOK_TIMEOUT } from "../setup";

beforeAll(async () => {
  await api.start();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("task processors under test", () => {
  test("no background worker runs while tests drive jobs in-process", () => {
    // `.env.example` is copied into CI; its bare `TASK_PROCESSORS=1` must not
    // beat the test override, or a Resque worker races `runAction`.
    expect(config.tasks.taskProcessors).toBe(0);
  });
});

describe("queue priority", () => {
  test("ingress and the outbox drain before agent ticks, and clocks after", () => {
    // A person's message must reach the inbox, and a finished answer must
    // leave, ahead of another tick on some other conversation.
    expect(config.tasks.queues).toEqual([
      "ingress",
      "outbox",
      "agents",
      "sandboxes",
      "orchestrator",
      "default",
    ]);
  });

  test("every queue an action names is one a worker drains", () => {
    const queues = config.tasks.queues as string[];
    for (const action of api.actions.actions) {
      const queue = action.task?.queue;
      if (typeof queue === "string")
        expect(queues, action.name).toContain(queue);
    }
  });
});
