import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { api } from "keryx";
import { hashRunnerToken } from "../../ops/RunnerOps";
import { auditLogs } from "../../schema/audit_logs";
import {
  authHeaders,
  buildTestUniverse,
  cookieHeader,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";
import { registerRunner, runnerRow } from "./helpers";

let universe: TestUniverse;
let url: string;

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("runner:register", () => {
  test("returns a prefixed token once and stores only its hash", async () => {
    const runner = await registerRunner(
      url,
      universe.mario,
      universe.projectId,
      "mario-mbp",
    );
    expect(runner.token).toMatch(/^hyp_rt_[A-Za-z0-9_-]{43}$/);

    const row = await runnerRow(runner.id);
    expect(row.tokenHash).toBe(hashRunnerToken(runner.token));
    expect(row.tokenLastFour).toBe(runner.token.slice(-4));
    expect(row.userId).toBe(universe.mario.userId);
    expect(row.status).toBe("offline");

    // Never again: not in view, not in list, not in the audit row.
    const view = await fetch(
      `${url}/api/runner/${runner.id}?projectId=${universe.projectId}`,
      { headers: cookieHeader(universe.mario.sessionId) },
    );
    const list = await fetch(
      `${url}/api/runners?projectId=${universe.projectId}`,
      { headers: cookieHeader(universe.peach.sessionId) },
    );
    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "runner:register"))
      .orderBy(desc(auditLogs.id))
      .limit(1);
    for (const text of [
      await view.text(),
      await list.text(),
      JSON.stringify(audit),
    ]) {
      expect(text).not.toContain(runner.token);
      expect(text).not.toContain(row.tokenHash);
    }
    expect(audit?.targetPath).toBe("mario-mbp");
  });

  test("a name is unique among a project's unrevoked runners", async () => {
    await registerRunner(url, universe.luigi, universe.projectId, "shared");
    const res = await fetch(`${url}/api/runner`, {
      method: "PUT",
      headers: authHeaders(universe.toad.sessionId),
      body: JSON.stringify({ projectId: universe.projectId, name: "shared" }),
    });
    expect(res.status).toBe(406);
    const body = (await res.json()) as { error: { key: string } };
    expect(body.error.key).toBe("name");

    // Another project may use the name.
    await registerRunner(url, universe.toad, universe.toad.projectId, "shared");
  });

  test("replace revokes the old runner and its token, and reuses the name", async () => {
    const first = await registerRunner(
      url,
      universe.mario,
      universe.projectId,
      "rebuilt",
    );
    const second = await registerRunner(
      url,
      universe.mario,
      universe.projectId,
      "rebuilt",
      true,
    );
    expect(second.id).not.toBe(first.id);
    const old = await runnerRow(first.id);
    expect(old.status).toBe("revoked");
    expect(old.revokedReason).toBe("replaced");
    expect((await runnerRow(second.id)).status).toBe("offline");
  });

  test("only the owner or an admin can replace a runner", async () => {
    await registerRunner(url, universe.mario, universe.projectId, "marios");
    const res = await fetch(`${url}/api/runner`, {
      method: "PUT",
      headers: authHeaders(universe.toad.sessionId),
      body: JSON.stringify({
        projectId: universe.projectId,
        name: "marios",
        replace: true,
      }),
    });
    expect(res.status).toBe(403);
    // Peach administers the project.
    await registerRunner(
      url,
      universe.peach,
      universe.projectId,
      "marios",
      true,
    );
  });

  test("an outsider cannot register in someone else's project", async () => {
    const res = await fetch(`${url}/api/runner`, {
      method: "PUT",
      headers: authHeaders(universe.bowser.sessionId),
      body: JSON.stringify({ projectId: universe.projectId, name: "castle" }),
    });
    expect(res.status).toBe(403);
  });

  test("a name must look like a host name", async () => {
    const res = await fetch(`${url}/api/runner`, {
      method: "PUT",
      headers: authHeaders(universe.mario.sessionId),
      body: JSON.stringify({ projectId: universe.projectId, name: "a b" }),
    });
    expect(res.status).toBe(406);
  });
});

describe("runner:edit and runner:revoke", () => {
  test("a plain member cannot pause or revoke someone else's runner; the owner and an admin can", async () => {
    const runner = await registerRunner(
      url,
      universe.mario,
      universe.projectId,
      "editable",
    );
    const at = `${url}/api/runner/${runner.id}`;
    const as = (sessionId: string, method: string, body: unknown) =>
      fetch(at, {
        method,
        headers: authHeaders(sessionId),
        body: JSON.stringify(body),
      });

    expect(
      (
        await as(universe.toad.sessionId, "POST", {
          projectId: universe.projectId,
          enabled: false,
        })
      ).status,
    ).toBe(403);
    const paused = await as(universe.mario.sessionId, "POST", {
      projectId: universe.projectId,
      enabled: false,
      name: "renamed",
    });
    expect(paused.status).toBe(200);
    const edited = (await paused.json()) as {
      runner: { enabled: boolean; name: string };
    };
    expect(edited.runner).toMatchObject({ enabled: false, name: "renamed" });

    expect(
      (
        await as(universe.toad.sessionId, "DELETE", {
          projectId: universe.projectId,
        })
      ).status,
    ).toBe(403);
    const revoked = await as(universe.peach.sessionId, "DELETE", {
      projectId: universe.projectId,
    });
    expect(revoked.status).toBe(200);
    expect((await runnerRow(runner.id)).revokedReason).toBe("revoked");

    // Revoked is final.
    expect(
      (
        await as(universe.mario.sessionId, "DELETE", {
          projectId: universe.projectId,
        })
      ).status,
    ).toBe(406);
  });

  test("a runner in another project is not found, not forbidden", async () => {
    const runner = await registerRunner(
      url,
      universe.bowser,
      universe.bowser.projectId,
      "koopa",
    );
    const res = await fetch(
      `${url}/api/runner/${runner.id}?projectId=${universe.projectId}`,
      { headers: cookieHeader(universe.peach.sessionId) },
    );
    expect(res.status).toBe(404);
  });

  test("view reports standing, list omits revoked runners unless asked", async () => {
    const runner = await registerRunner(
      url,
      universe.luigi,
      universe.projectId,
      "luigis",
    );
    const view = async (sessionId: string) =>
      (
        (await (
          await fetch(
            `${url}/api/runner/${runner.id}?projectId=${universe.projectId}`,
            { headers: cookieHeader(sessionId) },
          )
        ).json()) as {
          runner: {
            standing: { canManage: boolean };
            socketAttached: boolean;
            online: boolean;
            owner: { name: string };
          };
        }
      ).runner;
    expect((await view(universe.luigi.sessionId)).standing.canManage).toBe(
      true,
    );
    expect((await view(universe.peach.sessionId)).standing.canManage).toBe(
      true,
    );
    const asToad = await view(universe.toad.sessionId);
    expect(asToad.standing.canManage).toBe(false);
    expect(asToad.owner.name).toBe("Luigi");
    expect(asToad.online).toBe(false);
    expect(asToad.socketAttached).toBe(false);

    const names = async (query: string) =>
      (
        (await (
          await fetch(
            `${url}/api/runners?projectId=${universe.projectId}${query}`,
            { headers: cookieHeader(universe.toad.sessionId) },
          )
        ).json()) as { runners: { name: string; status: string }[] }
      ).runners;
    const live = await names("&limit=100");
    expect(live.every((r) => r.status !== "revoked")).toBe(true);
    const all = await names("&limit=100&includeRevoked=true");
    expect(all.some((r) => r.status === "revoked")).toBe(true);
  });
});

describe("runner:edit under concurrency", () => {
  test("concurrent renames onto one name: one lands, the rest are told it is taken", async () => {
    const racers = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        registerRunner(url, universe.peach, universe.projectId, `renamer-${i}`),
      ),
    );
    const statuses = await Promise.all(
      racers.map(async (r) => {
        const res = await fetch(`${url}/api/runner/${r.id}`, {
          method: "POST",
          headers: authHeaders(universe.peach.sessionId),
          body: JSON.stringify({
            projectId: universe.projectId,
            name: "contested",
          }),
        });
        return res.status;
      }),
    );
    expect(statuses.filter((s) => s === 200)).toHaveLength(1);
    expect(statuses.filter((s) => s === 406)).toHaveLength(racers.length - 1);
  });
});
