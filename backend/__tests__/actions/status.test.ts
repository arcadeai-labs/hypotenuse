import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ActionResponse, api, config } from "keryx";
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

describe("status: where platforms deliver", () => {
  test("reports each platform's webhook URL under APPLICATION_URL", async () => {
    const body = (await (
      await fetch(`${url}/api/status`)
    ).json()) as ActionResponse<Status>;
    const base = `${config.server.web.applicationUrl.replace(/\/+$/, "")}/api/webhooks`;
    expect(body.webhooks).toEqual({
      slack: `${base}/slack`,
      linear: `${base}/linear`,
      pylon: `${base}/pylon`,
    });
    for (const webhook of Object.values(body.webhooks)) {
      expect(new URL(webhook).pathname.startsWith("/api/webhooks/")).toBe(true);
    }
  });

  test("reports the dashboard's origin", async () => {
    const body = (await (
      await fetch(`${url}/api/status`)
    ).json()) as ActionResponse<Status>;
    expect(body.dashboardUrl).toBe(config.frontend.url);
  });

  test("a healthy server with no platform app installed is healthy", async () => {
    // Nothing is mounted at the webhook routes yet, and no bot exists; the
    // URLs are information for whoever creates a platform app, not a check.
    const body = (await (
      await fetch(`${url}/api/status`)
    ).json()) as ActionResponse<Status>;
    expect(body.healthy).toBe(true);
    expect(Object.keys(body.checks).sort()).toEqual(["database", "redis"]);
  });
});
