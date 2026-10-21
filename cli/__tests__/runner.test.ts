import { describe, expect, test } from "bun:test";
import { HeartbeatRequest } from "../../protocol/src/index";
import {
  capacityCell,
  describeRunner,
  type Runner,
} from "../src/commands/runner";
import {
  defaultRunnerName,
  machineId,
  registrationHeartbeat,
} from "../src/runner/machine";

/** A runner as `runner:view` answers it. */
const runner: Runner = {
  id: 5,
  projectId: 1,
  userId: 2,
  owner: { id: 2, name: "Mario", email: "mario@mushroom.kingdom" },
  name: "evan-mbp",
  status: "online",
  online: true,
  enabled: false,
  tokenLastFour: "abcd",
  lastHeartbeatAt: 0,
  lastConnectedAt: null,
  protocolVersion: 1,
  daemonVersion: "0.4.0",
  platform: "darwin-arm64",
  hostname: "evan-mbp",
  limits: { maxParallelJobs: 3 },
  activeCount: 1,
  roles: ["worker"],
  agents: [{ id: "claude", preset: "claude", available: true }],
  repositories: [],
  subscriptions: { teams: ["ENG"], projects: [], labels: [] },
  socketAttached: false,
  createdAt: 0,
  revokedAt: null,
  revokedReason: null,
};

describe("runner names", () => {
  test("a host name becomes a valid runner name", () => {
    const valid = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
    for (const host of [
      "evan-mbp",
      "Evans-MacBook-Pro.local",
      "  build box #2 ",
      "_weird_",
      "x".repeat(200),
      "",
      "***",
    ]) {
      const name = defaultRunnerName(host);
      expect(name, host).toMatch(valid);
      expect(name.length, host).toBeLessThanOrEqual(64);
    }
    expect(defaultRunnerName("Evans-MacBook-Pro.local")).toBe(
      "Evans-MacBook-Pro",
    );
    expect(defaultRunnerName("build box #2")).toBe("build-box-2");
    expect(defaultRunnerName("***")).toBe("runner");
  });
});

describe("machine id", () => {
  test("is sha256 of the raw id, never the raw id", () => {
    expect(machineId("abc")).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(machineId("abc")).toBe(machineId("abc"));
    expect(machineId("abc")).not.toBe(machineId("abd"));
    expect(machineId()).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("the registration heartbeat", () => {
  test("is a valid HeartbeatRequest with no capabilities yet", () => {
    const body = registrationHeartbeat();
    expect(HeartbeatRequest.safeParse(body).success).toBe(true);
    expect(body.draining).toBe(false);
    expect(body.active).toEqual([]);
    expect(body.platform).toBe(`${process.platform}-${process.arch}`);
  });
});

describe("rendering", () => {
  test("shows capacity, the paused state, and subscriptions — never a token", () => {
    expect(capacityCell(runner)).toBe("1/3");
    const text = describeRunner(runner);
    expect(text).toContain("online (paused)");
    expect(text).toContain("teams        ENG");
    expect(text).toContain("labels       all");
    expect(text).toContain("not attached");
    expect(text).toContain("…abcd");
  });
});
