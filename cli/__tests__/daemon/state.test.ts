import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, StateDb } from "../../src/daemon/state";

/**
 * The daemon's state database: migrations are idempotent, `seq` is per claim,
 * an ephemeral event supersedes only the same session's unsent ephemerals,
 * and a restart finds what a crash left behind.
 */

/**
 * A database with one claimed session.
 * @returns The database.
 */
function claimed(): StateDb {
  const db = new StateDb(":memory:");
  db.claimSession({
    agentSessionId: 7,
    linearSessionId: "lin-7",
    issueIdentifier: "ENG-1",
    role: "worker",
    repository: "github.com/acme/web",
    workItemId: 70,
    acpAgentId: "claude",
  });
  return db;
}

/**
 * Queue an event.
 * @param db - The database.
 * @param ephemeral - Whether it is ephemeral.
 * @param session - The session.
 * @param item - The work item.
 * @returns Its seq.
 */
function event(
  db: StateDb,
  ephemeral: boolean,
  session = 7,
  item = 70,
): number {
  return db.queueEvent({
    eventId: crypto.randomUUID(),
    agentSessionId: session,
    workItemId: item,
    ephemeral,
    payload: { type: "thought", body: "x", ephemeral },
  });
}

describe("state.db", () => {
  test("is created 0600 and migrations are idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyp-state-"));
    const path = join(dir, "state.db");
    const first = new StateDb(path);
    expect(first.version).toBe(MIGRATIONS.length);
    first.close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const again = new StateDb(path);
    expect(again.migrate()).toBe(0);
    expect(again.version).toBe(MIGRATIONS.length);
    again.close();
  });

  test("seq counts per claim and restarts at 1 for the session's next work item", () => {
    const db = claimed();
    expect([event(db, false), event(db, false), event(db, false)]).toEqual([
      1, 2, 3,
    ]);
    db.claimSession({
      agentSessionId: 7,
      linearSessionId: "lin-7",
      issueIdentifier: "ENG-1",
      role: "worker",
      repository: null,
      workItemId: 71,
      acpAgentId: "claude",
    });
    expect(event(db, false, 7, 71)).toBe(1);
    expect(db.pendingEvents(70).map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(db.pendingEvents(71).map((e) => e.payload.seq)).toEqual([1]);
  });

  test("a new ephemeral supersedes only the same session's unsent ephemerals", () => {
    const db = claimed();
    db.claimSession({
      agentSessionId: 8,
      linearSessionId: null,
      issueIdentifier: "ENG-2",
      role: "worker",
      repository: null,
      workItemId: 80,
      acpAgentId: "claude",
    });
    event(db, true); // 1, superseded
    event(db, false); // 2
    event(db, true, 8, 80); // other session, kept
    event(db, true); // 3, superseded
    event(db, true); // 4, kept
    expect(db.pendingEvents(70).map((e) => [e.seq, e.ephemeral])).toEqual([
      [2, false],
      [4, true],
    ]);
    expect(db.pendingEvents(80).map((e) => e.seq)).toEqual([1]);
    // Sent rows are gone, so nothing already sent is ever "superseded".
    db.deleteEvents(db.pendingEvents(70).map((e) => e.eventId));
    event(db, true);
    expect(db.pendingEvents(70).map((e) => e.seq)).toEqual([5]);
  });

  test("a completion waits behind its events; dropping a work item drops both", () => {
    const db = claimed();
    event(db, false);
    db.queueCompletion(70, {
      request: { workItemId: 70, outcome: "completed" },
    });
    expect(db.pendingWorkItems()).toEqual([70]);
    expect(db.pendingCompletion(70)?.payload).toEqual({
      request: { workItemId: 70, outcome: "completed" },
    });
    db.dropWorkItem(70);
    expect(db.pendingWorkItems()).toEqual([]);
    expect(db.pendingCompletion(70)).toBeNull();
  });

  test("live sessions from a previous process are marked interrupted", () => {
    const db = claimed();
    db.setSessionState(7, "running", { pid: 4242 });
    const interrupted = db.interruptLive();
    expect(interrupted.map((s) => [s.agentSessionId, s.state])).toEqual([
      [7, "interrupted"],
    ]);
    expect(db.session(7)).toMatchObject({
      state: "interrupted",
      pid: null,
      issueIdentifier: "ENG-1",
    });
    expect(db.interruptLive()).toEqual([]);
  });
});
