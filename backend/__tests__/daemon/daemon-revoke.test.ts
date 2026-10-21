import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { api } from "keryx";
import { withoutRunnerRateLimits } from "../routing/helpers";
import { runnerRow } from "../runners/helpers";
import {
  authHeaders,
  buildTestUniverse,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import { DaemonHome, until } from "./helpers";
import { ServerProxy } from "./proxy";

/**
 * Revoking a runner while its daemon is connected: the `revoked` frame stops
 * it at once, with the message that says what to do, and exit code 78 so a
 * service manager does not restart it. Started again with the same token, it
 * refuses before making a single request.
 */

let universe: TestUniverse;
let proxy: ServerProxy;
let home: DaemonHome;
beforeAll(async () => {
  universe = await buildTestUniverse();
  proxy = new ServerProxy(universe.url);
  proxy.up();
  home = await DaemonHome.create(
    universe.url,
    universe.mario,
    universe.projectId,
    "doomed",
    {
      serverUrl: proxy.url,
    },
  );
}, HOOK_TIMEOUT);
afterAll(async () => {
  await home?.kill("SIGKILL");
  proxy?.down();
  await api.stop();
}, HOOK_TIMEOUT);

withoutRunnerRateLimits();

describe("revocation", () => {
  test("runner:revoke stops a connected daemon with the revoke message and exit 78", async () => {
    await home.startForeground();
    await until(
      async () => (await runnerRow(home.runner.id)).status === "online",
    );
    await home.waitForLog(/subscribed/);

    const res = await fetch(`${universe.url}/api/runner/${home.runner.id}`, {
      method: "DELETE",
      headers: authHeaders(universe.mario.sessionId),
      body: JSON.stringify({ projectId: universe.projectId }),
    });
    expect(res.status).toBe(200);
    const revokedAt = Date.now();

    const code = await Promise.race([
      home.proc!.exited,
      Bun.sleep(15_000).then(() => "timeout"),
    ]);
    expect(code).toBe(78);
    expect(home.log()).toContain(
      'runner revoked on the server; run "hypotenuse runner register" to re-register',
    );
    // Nothing more carries the dead token once the daemon heard.
    await Bun.sleep(500);
    expect(proxy.since(revokedAt + 2_000, home.runner.token)).toEqual([]);
    expect(existsSync(join(home.stateDir, "daemon.pid"))).toBe(false);
    home.proc = null;
  }, 30_000);

  test("started again with the revoked token, it refuses without a request", async () => {
    const before = Date.now();
    const { code, stderr } = await home.run([
      "daemon",
      "start",
      "--foreground",
    ]);
    expect(code).toBe(78);
    expect(stderr).toContain(
      'runner "doomed" was revoked on the server; run "hypotenuse runner register"',
    );
    expect(proxy.since(before)).toEqual([]);
  }, 20_000);
});
