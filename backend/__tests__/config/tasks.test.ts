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
