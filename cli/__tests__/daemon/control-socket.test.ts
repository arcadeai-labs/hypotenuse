import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callDaemon,
  DaemonNotRunning,
  DaemonRpcError,
  NOT_RUNNING_MESSAGE,
} from "../../src/daemon/control-client";
import {
  ControlServer,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  RpcError,
} from "../../src/daemon/control-socket";

/**
 * The control socket: newline-delimited JSON-RPC on a `0600` Unix socket.
 * Each method answers through a stub supervisor; an unknown method, a refusal,
 * and a missing or stale socket each come back as what the CLI needs.
 */

/**
 * A fresh socket path (short: Unix socket paths are limited to ~100 bytes).
 * @returns The path.
 */
function socketPath(): string {
  return join(mkdtempSync(join(tmpdir(), "hypc-")), "d.sock");
}

/**
 * The error a call must fail with.
 * @param call - The call.
 * @returns What it threw.
 */
function refusal(call: Promise<unknown>): Promise<DaemonRpcError> {
  return call.then(
    () => {
      throw new Error("expected a refusal");
    },
    (e: DaemonRpcError) => e,
  );
}

/** The methods with stub answers shaped as the daemon's. */
const handlers = {
  status: () => ({
    pid: 1,
    version: "0.6.0",
    uptimeMs: 5,
    configPath: "/c.toml",
    runner: { id: 1, name: "r", projectId: 2 },
    server: {
      url: "http://x",
      connected: true,
      lastHeartbeatAt: 1,
      socket: "open",
    },
    slots: { total: 2, busy: 0 },
    draining: false,
  }),
  "agents.list": (p: Record<string, unknown>) => [
    { agentSessionId: 1, state: p.all ? "done" : "idle" },
  ],
  "agents.kill": (p: Record<string, unknown>) => {
    if (p.target === undefined)
      throw new RpcError(
        INVALID_PARAMS,
        "target is a session id or an issue identifier",
      );
    return { killed: [9] };
  },
  "worktrees.list": () => [],
  "worktrees.cleanup": () => ({ removed: [], kept: [] }),
  drain: (p: Record<string, unknown>) => ({
    drained: true,
    cancelled: p.cancel ? 1 : 0,
  }),
  reload: () => ({ applied: ["log.level"], requiresRestart: [] }),
  restart: () => ({ restarting: true, mode: "re-exec" }),
  "mcp.call": () => {
    throw new RpcError(METHOD_NOT_FOUND, "reserved");
  },
};

describe("control socket", () => {
  test("is 0600 and answers every method", async () => {
    const path = socketPath();
    const server = new ControlServer(path, handlers);
    server.listen();
    try {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(await callDaemon(path, "status")).toMatchObject({
        runner: { id: 1 },
        slots: { total: 2, busy: 0 },
      });
      expect(await callDaemon(path, "agents.list", { all: true })).toEqual([
        { agentSessionId: 1, state: "done" },
      ]);
      expect(
        await callDaemon(path, "agents.kill", { target: "ENG-1" }),
      ).toEqual({ killed: [9] });
      expect(await callDaemon(path, "worktrees.list")).toEqual([]);
      expect(
        await callDaemon(path, "worktrees.cleanup", { dryRun: true }),
      ).toEqual({ removed: [], kept: [] });
      expect(
        await callDaemon(path, "drain", { timeoutMs: 1, cancel: true }),
      ).toEqual({ drained: true, cancelled: 1 });
      expect(await callDaemon(path, "reload")).toEqual({
        applied: ["log.level"],
        requiresRestart: [],
      });
      expect(await callDaemon(path, "restart")).toEqual({
        restarting: true,
        mode: "re-exec",
      });
    } finally {
      server.close();
    }
  });

  test("a refusal and an unknown method are JSON-RPC errors", async () => {
    const path = socketPath();
    const server = new ControlServer(path, handlers);
    server.listen();
    try {
      const bad = await refusal(callDaemon(path, "agents.kill"));
      expect(bad).toBeInstanceOf(DaemonRpcError);
      expect(bad.code).toBe(INVALID_PARAMS);
      const unknown = await refusal(callDaemon(path, "nope"));
      expect(unknown.code).toBe(METHOD_NOT_FOUND);
      expect(unknown.message).toBe('unknown method "nope"');
      const reserved = await refusal(callDaemon(path, "mcp.call"));
      expect(reserved.code).toBe(METHOD_NOT_FOUND);
    } finally {
      server.close();
    }
  });

  test("a missing socket, or a stale file nobody listens on, is 'not running'", async () => {
    const missing = await refusal(callDaemon(socketPath(), "status"));
    expect(missing).toBeInstanceOf(DaemonNotRunning);
    expect(missing.message).toBe(NOT_RUNNING_MESSAGE);
    const stale = socketPath();
    writeFileSync(stale, "");
    expect(await refusal(callDaemon(stale, "status", {}, 500))).toBeInstanceOf(
      DaemonNotRunning,
    );
  });

  test("binding replaces a stale socket file", async () => {
    const path = socketPath();
    writeFileSync(path, "left over");
    const server = new ControlServer(path, handlers);
    server.listen();
    try {
      expect(await callDaemon(path, "status")).toMatchObject({ pid: 1 });
    } finally {
      server.close();
    }
  });
});
