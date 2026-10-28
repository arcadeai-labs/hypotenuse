import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ActionResponse, api } from "keryx";
import type { Health } from "../../actions/health";
import { failingChecks } from "../../ops/HealthOps";
import { HOOK_TIMEOUT, serverUrl } from "../setup";

let url: string;

beforeAll(async () => {
  await api.start();
  url = serverUrl();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("health", () => {
  test("answers 200 over HTTP when every dependency answers", async () => {
    const res = await fetch(`${url}/api/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ActionResponse<Health>;
    expect(body.healthy).toBe(true);
    expect(body.checks).toEqual({ database: true, redis: true });
    expect(body.database?.extensions.vector).toBe(true);
  });

  test("opts out of tracing, like status", () => {
    const action = api.actions.actions.find((a) => a.name === "health");
    expect(action?.tracing).toBe(false);
  });
});

describe("failingChecks", () => {
  test("names each failing dependency, and the extension only on a reachable database", () => {
    expect(
      failingChecks({
        healthy: false,
        checks: { database: false, redis: false },
        database: { extensions: { vector: false } },
      }),
    ).toEqual(["database", "redis"]);
    expect(
      failingChecks({
        healthy: false,
        checks: { database: true, redis: true },
        database: { extensions: { vector: false } },
      }),
    ).toEqual(["database extension vector"]);
    expect(
      failingChecks({
        healthy: true,
        checks: { database: null, redis: true },
        database: null,
      }),
    ).toEqual([]);
  });
});
