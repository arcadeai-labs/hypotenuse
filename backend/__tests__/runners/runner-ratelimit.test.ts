import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api, config } from "keryx";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import { heartbeat, heartbeatBody, registerRunner } from "./helpers";

let universe: TestUniverse;
let url: string;

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("per-runner rate limits", () => {
  test("the heartbeat past the limit is a 429 for that runner only", async () => {
    const noisy = await registerRunner(
      url,
      universe.mario,
      universe.projectId,
      "noisy",
    );
    const quiet = await registerRunner(
      url,
      universe.luigi,
      universe.projectId,
      "quiet",
    );
    const body = heartbeatBody();
    const limit = config.runners.heartbeatLimit;
    for (let i = 0; i < limit; i++) {
      expect(
        (await heartbeat(url, noisy.token, body)).status,
        `beat ${i + 1}`,
      ).toBe(200);
    }
    const over = await heartbeat(url, noisy.token, body);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).not.toBeNull();

    expect((await heartbeat(url, quiet.token, heartbeatBody())).status).toBe(
      200,
    );
  });
});
