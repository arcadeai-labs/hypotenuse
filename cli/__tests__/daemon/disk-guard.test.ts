import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { realMachine } from "../../src/config/machine";
import type { DaemonApi } from "../../src/daemon/daemon-api";
import { DaemonLog } from "../../src/daemon/log";
import { StateDb } from "../../src/daemon/state";
import { Supervisor } from "../../src/daemon/supervisor";
import { fakeConfig } from "../acp/harness";

const GB = 1024 ** 3;

test("short on disk, the heartbeat reports no capacity (draining) until space recovers", () => {
  const root = mkdtempSync(join(tmpdir(), "hyp-disk-"));
  let free = 1 * GB;
  const log = new DaemonLog(join(root, "daemon.log"), "debug", false);
  const supervisor = new Supervisor({
    config: fakeConfig(root),
    configPath: join(root, "config.toml"),
    state: new StateDb(":memory:"),
    log,
    api: {} as DaemonApi,
    machine: realMachine(),
    machineId: "sha256:00",
    runner: { runnerId: 1, projectId: 1, name: "test-runner" },
    executor: { run: async () => ({ outcome: "completed" }) },
    stateDir: root,
    env: { HOME: root },
    readConfig: () => ({ config: null }),
    requestExit: () => {},
    useSocket: false,
    statfs: () => ({ bavail: free, bsize: 1 }),
  });
  expect(supervisor.heartbeatBody().draining).toBe(true);
  free = 5 * GB;
  expect(supervisor.heartbeatBody().draining).toBe(false);
  supervisor.close();
});
