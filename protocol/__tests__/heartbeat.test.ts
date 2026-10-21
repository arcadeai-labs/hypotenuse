import { describe, expect, test } from "bun:test";
import {
  ConnectResponse,
  HeartbeatRequest,
  HeartbeatResponse,
  isSupportedProtocol,
  PROTOCOL_VERSION,
  RunnerCapabilities,
  runnerChannel,
  SUPPORTED_PROTOCOL_RANGE,
} from "../src/index";

/** The request body docs/RUNNER_PROTOCOL.md shows, verbatim. */
const documented = {
  protocolVersion: 1,
  daemonVersion: "0.4.2",
  platform: "darwin-arm64",
  hostname: "evan-mbp",
  draining: false,
  machineId: "sha256:4be1",
  limits: {
    maxParallelJobs: 3,
    roles: { manager: 1 },
    agents: { claude: 2 },
  },
  active: [
    {
      workItemId: 812,
      agentSessionId: 91,
      role: "worker",
      agentId: "codex",
      state: "running",
    },
  ],
  capabilities: {
    roles: ["manager", "worker"],
    agents: [
      {
        id: "claude",
        preset: "claude",
        available: true,
        roles: ["manager", "worker"],
      },
      {
        id: "codex",
        preset: "codex",
        available: false,
        roles: [],
        error: "codex-acp not found",
      },
    ],
    repositories: [
      { name: "web", remote: "github.com/acme/web", baseBranch: "main" },
    ],
    subscriptions: { teams: ["ENG"], projects: [], labels: ["frontend"] },
  },
};

describe("HeartbeatRequest", () => {
  test("accepts the documented example", () => {
    expect(HeartbeatRequest.safeParse(documented).success).toBe(true);
  });

  test("is strict: an unknown field is refused, top-level or nested", () => {
    expect(
      HeartbeatRequest.safeParse({ ...documented, extra: 1 }).success,
    ).toBe(false);
    expect(
      HeartbeatRequest.safeParse({
        ...documented,
        capabilities: { ...documented.capabilities, extra: 1 },
      }).success,
    ).toBe(false);
  });

  test("subscriptions default to everything", () => {
    const parsed = RunnerCapabilities.parse({
      roles: ["worker"],
      agents: [],
      repositories: [],
      subscriptions: {},
    });
    expect(parsed.subscriptions).toEqual({
      teams: [],
      projects: [],
      labels: [],
    });
  });

  test("refuses a role that is not a role, and a malformed machine id", () => {
    expect(
      HeartbeatRequest.safeParse({
        ...documented,
        capabilities: { ...documented.capabilities, roles: ["boss"] },
      }).success,
    ).toBe(false);
    expect(
      HeartbeatRequest.safeParse({ ...documented, machineId: "abc" }).success,
    ).toBe(false);
  });
});

describe("responses are loose", () => {
  test("an older daemon keeps fields a newer server adds", () => {
    const response = HeartbeatResponse.parse({
      serverTime: 1,
      heartbeatIntervalMs: 15_000,
      leaseMs: 60_000,
      offers: [],
      cancels: [],
      unknownActive: [],
      somethingNew: true,
    });
    expect((response as Record<string, unknown>).somethingNew).toBe(true);
    expect(
      ConnectResponse.safeParse({
        runnerId: 5,
        channel: runnerChannel(5),
        heartbeatIntervalMs: 15_000,
        leaseMs: 60_000,
        serverTime: 1,
      }).success,
    ).toBe(true);
  });
});

describe("versioning", () => {
  test("the current version is inside the supported range", () => {
    const [min, max] = SUPPORTED_PROTOCOL_RANGE;
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(min);
    expect(PROTOCOL_VERSION).toBeLessThanOrEqual(max);
    expect(isSupportedProtocol(String(PROTOCOL_VERSION))).toBe(true);
  });

  test("absent, malformed, and out-of-range versions are unsupported", () => {
    for (const v of [null, undefined, "", "abc", "1.5", "0", String(99)]) {
      expect(isSupportedProtocol(v), String(v)).toBe(false);
    }
  });
});
