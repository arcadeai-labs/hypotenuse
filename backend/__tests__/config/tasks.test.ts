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
  test("workers drain the linear queue first, and every queue an action names", () => {
    // Webhook processing and the activity outbox are what a person in Linear
    // waits on; anything else queued must not delay an acknowledgement.
    const queues = config.tasks.queues as string[];
    expect(queues[0]).toBe("linear");
    const named = new Set(
      api.actions.actions
        .map((a) => a.task?.queue)
        .filter((q): q is string => typeof q === "string"),
    );
    expect(named.size).toBeGreaterThan(0);
    for (const queue of named) expect(queues, queue).toContain(queue);
  });
});
