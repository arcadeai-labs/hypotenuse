import { describe, expect, test } from "bun:test";
import { checkLabel, type StatusResponse, statusChecks } from "../utils/status";

/**
 * A status body as the server sends it.
 * @param overrides - Fields to replace.
 * @returns A full response.
 */
function status(overrides: Partial<StatusResponse> = {}): StatusResponse {
  return {
    name: "hypotenuse",
    pid: 1,
    version: "0.0.1",
    uptime: 10,
    consumedMemoryMB: 1,
    healthy: true,
    checks: { database: true, redis: true },
    database: { extensions: { vector: true } },
    dashboardUrl: "http://localhost:3000",
    webhooks: {
      slack: "http://localhost:8080/api/webhooks/slack",
      linear: "http://localhost:8080/api/webhooks/linear",
      pylon: "http://localhost:8080/api/webhooks/pylon",
    },
    ...overrides,
  };
}

describe("statusChecks", () => {
  test("reports the vector extension beside the database and Redis", () => {
    expect(statusChecks(status())).toEqual([
      { label: "Database", ok: true },
      { label: "Database extension: vector", ok: true },
      { label: "Redis", ok: true },
    ]);
  });

  test("a database missing the extension shows it failing", () => {
    const checks = statusChecks(
      status({ database: { extensions: { vector: false } }, healthy: false }),
    );
    expect(checks[1]).toEqual({
      label: "Database extension: vector",
      ok: false,
    });
  });

  test("a server running without a database has no extension to fail", () => {
    const checks = statusChecks(
      status({ checks: { database: null, redis: true }, database: null }),
    );
    expect(checks.slice(0, 2).map((c) => c.ok)).toEqual([null, null]);
  });
});

describe("checkLabel", () => {
  test("names every state", () => {
    expect([true, false, null].map(checkLabel)).toEqual([
      "ok",
      "failing",
      "disabled",
    ]);
  });
});
