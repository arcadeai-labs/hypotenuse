import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  PROTOCOL_UNSUPPORTED,
  SUPPORTED_PROTOCOL_RANGE,
} from "@hypotenuse/protocol";
import { api } from "keryx";
import { INVALID_RUNNER_TOKEN_MESSAGE } from "../../ops/RunnerOps";
import {
  authHeaders,
  buildTestUniverse,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import {
  connect,
  daemonHeaders,
  heartbeat,
  heartbeatBody,
  registerRunner,
  runnerRow,
} from "./helpers";

let universe: TestUniverse;
let url: string;

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * A refusal's status and the parts of its body that are not a clock.
 * @param res - The response.
 * @returns What two refusals must agree on.
 */
async function refusal(res: Response) {
  const body = (await res.json()) as {
    error: Record<string, unknown>;
  };
  const { timestamp: _t, stack: _s, ...error } = body.error;
  return { status: res.status, error };
}

describe("RunnerTokenMiddleware", () => {
  test("unknown, revoked, and malformed tokens get one identical 401", async () => {
    const revoked = await registerRunner(
      url,
      universe.mario,
      universe.projectId,
      "to-revoke",
    );
    await fetch(`${url}/api/runner/${revoked.id}`, {
      method: "DELETE",
      headers: authHeaders(universe.mario.sessionId),
      body: JSON.stringify({ projectId: universe.projectId }),
    });

    const answers = await Promise.all(
      [
        `hyp_rt_${"x".repeat(43)}`,
        revoked.token,
        "hyp_rt_",
        "hyp_rt_not base64!",
      ].map(async (token) =>
        refusal(await heartbeat(url, token, heartbeatBody())),
      ),
    );
    for (const answer of answers) {
      expect(answer).toEqual({
        status: 401,
        error: {
          message: INVALID_RUNNER_TOKEN_MESSAGE,
          type: "CONNECTION_SESSION_NOT_FOUND",
        },
      });
    }
  });

  test("a disabled runner may heartbeat, and nothing else", async () => {
    const runner = await registerRunner(
      url,
      universe.mario,
      universe.projectId,
      "paused",
    );
    const pause = await fetch(`${url}/api/runner/${runner.id}`, {
      method: "POST",
      headers: authHeaders(universe.mario.sessionId),
      body: JSON.stringify({ projectId: universe.projectId, enabled: false }),
    });
    expect(pause.status).toBe(200);

    const beat = await heartbeat(url, runner.token, heartbeatBody());
    expect(beat.status).toBe(200);
    const row = await runnerRow(runner.id);
    expect(row).toMatchObject({ status: "online", enabled: false });

    const connected = await connect(
      url,
      runner.token,
      heartbeatBody().machineId,
    );
    expect((await refusal(connected)).status).toBe(401);
  });

  test("an owner removed from the project: 401, and the runner is revoked", async () => {
    // Luigi registers, then is removed through the database directly — the
    // eager path through membership:delete is tested in membership.test.ts;
    // this is the backstop on the runner's next request.
    const runner = await registerRunner(
      url,
      universe.luigi,
      universe.projectId,
      "orphan",
    );
    const { projectMemberships } = await import(
      "../../schema/project_memberships"
    );
    const { and, eq } = await import("drizzle-orm");
    await api.db.db
      .delete(projectMemberships)
      .where(
        and(
          eq(projectMemberships.userId, universe.luigi.userId),
          eq(projectMemberships.projectId, universe.projectId),
        ),
      );

    const answer = await refusal(
      await heartbeat(url, runner.token, heartbeatBody()),
    );
    expect(answer.status).toBe(401);
    expect(answer.error.message).toBe(INVALID_RUNNER_TOKEN_MESSAGE);
    const row = await runnerRow(runner.id);
    expect(row.status).toBe("revoked");
    expect(row.revokedReason).toBe("membership_removed");
  });

  test("a missing or unsupported protocol version gets 426 with the supported range", async () => {
    const runner = await registerRunner(
      url,
      universe.toad,
      universe.projectId,
      "old-daemon",
    );
    for (const protocol of [null, "0", "99", "one"]) {
      const res = await fetch(`${url}/api/daemon/heartbeat`, {
        method: "POST",
        headers: daemonHeaders(runner.token, protocol),
        body: JSON.stringify(heartbeatBody()),
      });
      expect(res.status, String(protocol)).toBe(426);
      const body = (await res.json()) as {
        error: { type: string; supported: number[] };
      };
      expect(body.error.type).toBe(PROTOCOL_UNSUPPORTED);
      expect(body.error.supported).toEqual([...SUPPORTED_PROTOCOL_RANGE]);
    }
    // Nothing was written.
    expect((await runnerRow(runner.id)).lastHeartbeatAt).toBeNull();
  });

  test("a heartbeat body naming an unsupported protocol is refused the same way", async () => {
    const runner = await registerRunner(
      url,
      universe.toad,
      universe.projectId,
      "confused-daemon",
    );
    const res = await heartbeat(
      url,
      runner.token,
      heartbeatBody({ protocolVersion: 99 }),
    );
    expect(res.status).toBe(426);
  });
});
