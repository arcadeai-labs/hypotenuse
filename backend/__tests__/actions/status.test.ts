import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ActionResponse, api } from "keryx";
import type { Status } from "../../actions/status";
import { HOOK_TIMEOUT, serverUrl } from "../setup";

let url: string;

beforeAll(async () => {
  await api.start();
  url = serverUrl();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("status", () => {
  test("opts out of tracing", () => {
    // Load-balancer probes hit this every few seconds; a trace each would drown
    // everything else the moment tracing is turned on.
    const action = api.actions.actions.find((a) => a.name === "status");
    expect(action?.tracing).toBe(false);
  });

  test("boots a real server on a random free port", () => {
    expect(new URL(url).port).not.toBe("0");
    expect(new URL(url).port).not.toBe("8080");
  });

  test("reports healthy dependencies over HTTP", async () => {
    const res = await fetch(`${url}/api/status`);
    expect(res.status).toBe(200);

    const body = (await res.json()) as ActionResponse<Status>;
    expect(body.checks.database).toBe(true);
    expect(body.checks.redis).toBe(true);
    expect(body.database?.extensions.vector).toBe(true);
    expect(body.healthy).toBe(true);
    expect(body.name).toBe("hypotenuse-test");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });
});
