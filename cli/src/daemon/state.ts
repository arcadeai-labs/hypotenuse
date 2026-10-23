/**
 * The daemon's own state, in `bun:sqlite` at `<state dir>/state.db`: what this
 * runner is doing and has done (`local_sessions`), the worktrees it owns, and
 * the offline queue of events and completions waiting for the server.
 *
 * WAL, `synchronous=NORMAL`, foreign keys on. Migrations are an ordered array
 * of SQL with `PRAGMA user_version` as the cursor — no ORM on this side.
 * Bun's sqlite is synchronous, so a row is written before the caller
 * continues: an event is durable before the agent produces the next one.
 *
 * Nothing here is the only copy of anything the server needs. Delete the file
 * and the next start treats every lease as abandoned; the server re-offers.
 */
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** The states of a session on this runner. */
export const LOCAL_SESSION_STATES = [
  "claimed",
  "running",
  "idle",
  "done",
  "interrupted",
  "cancelled",
  "failed",
] as const;

/** One of {@link LOCAL_SESSION_STATES}. */
export type LocalSessionState = (typeof LOCAL_SESSION_STATES)[number];

/** The states that mean a turn is (or was, before a crash) under way. */
export const LIVE_LOCAL_STATES: readonly LocalSessionState[] = [
  "claimed",
  "running",
];

/** The migrations, in order. Append; never edit one that has shipped. */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE local_sessions (
     agent_session_id INTEGER PRIMARY KEY,
     linear_session_id TEXT,
     issue_identifier TEXT,
     role TEXT NOT NULL,
     repository TEXT,
     state TEXT NOT NULL,
     work_item_id INTEGER,
     next_seq INTEGER NOT NULL DEFAULT 1,
     acp_agent_id TEXT,
     acp_session_id TEXT,
     pid INTEGER,
     worktree_id INTEGER,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     last_event_at INTEGER
   );
   CREATE TABLE worktrees (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     repository TEXT NOT NULL,
     path TEXT NOT NULL UNIQUE,
     branch TEXT NOT NULL,
     base_branch TEXT NOT NULL,
     agent_session_id INTEGER,
     created_at INTEGER NOT NULL,
     last_used_at INTEGER NOT NULL,
     state TEXT NOT NULL,
     pushed INTEGER NOT NULL DEFAULT 0
   );
   CREATE TABLE pending_events (
     event_id TEXT PRIMARY KEY,
     agent_session_id INTEGER NOT NULL,
     seq INTEGER NOT NULL,
     work_item_id INTEGER NOT NULL,
     ephemeral INTEGER NOT NULL,
     payload TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0
   );
   CREATE INDEX pending_events_item ON pending_events (work_item_id, seq);
   CREATE TABLE pending_completions (
     work_item_id INTEGER PRIMARY KEY,
     payload TEXT NOT NULL,
     created_at INTEGER NOT NULL
   );`,
  `ALTER TABLE worktrees ADD COLUMN kind TEXT NOT NULL DEFAULT 'worktree';
   ALTER TABLE worktrees ADD COLUMN repo_path TEXT;
   ALTER TABLE worktrees ADD COLUMN setup_done INTEGER NOT NULL DEFAULT 0;
   ALTER TABLE worktrees ADD COLUMN kept_reason TEXT;
   ALTER TABLE worktrees ADD COLUMN removed_at INTEGER;
   ALTER TABLE local_sessions ADD COLUMN last_answer TEXT;
   ALTER TABLE local_sessions ADD COLUMN ended_at INTEGER;
   ALTER TABLE local_sessions ADD COLUMN pull_requests TEXT NOT NULL DEFAULT '[]';`,
  `ALTER TABLE local_sessions ADD COLUMN acp_cost_usd REAL;`,
];

/** A `local_sessions` row. */
export interface LocalSession {
  agentSessionId: number;
  linearSessionId: string | null;
  issueIdentifier: string | null;
  role: string;
  repository: string | null;
  state: LocalSessionState;
  workItemId: number | null;
  nextSeq: number;
  acpAgentId: string | null;
  acpSessionId: string | null;
  /** What `acpSessionId` had cost (USD) by its last turn's end; the next turn's baseline. */
  acpCostUsd: number | null;
  pid: number | null;
  worktreeId: number | null;
  createdAt: number;
  updatedAt: number;
  lastEventAt: number | null;
  /** How the last turn answered: `response`, `error`, or `elicitation`. */
  lastAnswer: string | null;
  /** When the last turn ended. */
  endedAt: number | null;
  /** Pull request URLs linked to the session, in the order found. */
  pullRequests: string[];
}

/** The states of a worktree. */
export const WORKTREE_STATES = [
  "active",
  "idle",
  "removing",
  "removed",
] as const;

/** A `worktrees` row. */
export interface LocalWorktree {
  id: number;
  /** `worktree` (a git worktree) or `scratch` (a repository-less directory). */
  kind: "worktree" | "scratch";
  /** The repository's configured name (`_scratch` for a scratch directory). */
  repository: string;
  /** The clone the worktree belongs to. */
  repoPath: string | null;
  path: string;
  branch: string;
  baseBranch: string;
  agentSessionId: number | null;
  createdAt: number;
  lastUsedAt: number;
  state: (typeof WORKTREE_STATES)[number];
  pushed: boolean;
  /** Whether the repository's setup commands have all succeeded here. */
  setupDone: boolean;
  /** Why the last cleanup kept it. */
  keptReason: string | null;
  removedAt: number | null;
}

/** What a new worktree row records. */
export interface NewWorktree {
  kind: LocalWorktree["kind"];
  repository: string;
  repoPath: string | null;
  path: string;
  branch: string;
  baseBranch: string;
  agentSessionId: number;
}

/** A `pending_events` row. */
export interface PendingEvent {
  eventId: string;
  agentSessionId: number;
  seq: number;
  workItemId: number;
  ephemeral: boolean;
  payload: Record<string, unknown>;
  createdAt: number;
  attempts: number;
}

/** A `pending_completions` row. */
export interface PendingCompletion {
  workItemId: number;
  payload: Record<string, unknown>;
  createdAt: number;
}

/** What a claim records about a session. */
export interface ClaimedSession {
  agentSessionId: number;
  linearSessionId: string | null;
  issueIdentifier: string | null;
  role: string;
  repository: string | null;
  workItemId: number;
  acpAgentId: string | null;
}

/** Map a snake_case row to its camelCase shape. */
type Row = Record<string, unknown>;

/**
 * A `local_sessions` row from SQL.
 * @param row - The raw row.
 * @returns The typed row.
 */
function toSession(row: Row): LocalSession {
  return {
    agentSessionId: row.agent_session_id as number,
    linearSessionId: (row.linear_session_id as string | null) ?? null,
    issueIdentifier: (row.issue_identifier as string | null) ?? null,
    role: row.role as string,
    repository: (row.repository as string | null) ?? null,
    state: row.state as LocalSessionState,
    workItemId: (row.work_item_id as number | null) ?? null,
    nextSeq: row.next_seq as number,
    acpAgentId: (row.acp_agent_id as string | null) ?? null,
    acpSessionId: (row.acp_session_id as string | null) ?? null,
    acpCostUsd: (row.acp_cost_usd as number | null) ?? null,
    pid: (row.pid as number | null) ?? null,
    worktreeId: (row.worktree_id as number | null) ?? null,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
    lastEventAt: (row.last_event_at as number | null) ?? null,
    lastAnswer: (row.last_answer as string | null) ?? null,
    endedAt: (row.ended_at as number | null) ?? null,
    pullRequests: JSON.parse((row.pull_requests as string | null) ?? "[]"),
  };
}

/**
 * A `worktrees` row from SQL.
 * @param row - The raw row.
 * @returns The typed row.
 */
function toWorktree(row: Row): LocalWorktree {
  return {
    id: row.id as number,
    kind: (row.kind as LocalWorktree["kind"]) ?? "worktree",
    repository: row.repository as string,
    repoPath: (row.repo_path as string | null) ?? null,
    path: row.path as string,
    branch: row.branch as string,
    baseBranch: row.base_branch as string,
    agentSessionId: (row.agent_session_id as number | null) ?? null,
    createdAt: row.created_at as number,
    lastUsedAt: row.last_used_at as number,
    state: row.state as LocalWorktree["state"],
    pushed: Boolean(row.pushed),
    setupDone: Boolean(row.setup_done),
    keptReason: (row.kept_reason as string | null) ?? null,
    removedAt: (row.removed_at as number | null) ?? null,
  };
}

/**
 * A `pending_events` row from SQL.
 * @param row - The raw row.
 * @returns The typed row.
 */
function toEvent(row: Row): PendingEvent {
  return {
    eventId: row.event_id as string,
    agentSessionId: row.agent_session_id as number,
    seq: row.seq as number,
    workItemId: row.work_item_id as number,
    ephemeral: Boolean(row.ephemeral),
    payload: JSON.parse(row.payload as string),
    createdAt: row.created_at as number,
    attempts: row.attempts as number,
  };
}

/** The daemon's state database. */
export class StateDb {
  /** The open database. */
  readonly db: Database;

  /**
   * Open (creating if needed) and migrate.
   * @param path - The file, or `:memory:`.
   * @param now - The clock, injectable for tests.
   */
  constructor(
    readonly path: string,
    private readonly now: () => number = Date.now,
  ) {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    }
    const fresh = path === ":memory:" || !existsSync(path);
    this.db = new Database(path, { create: true, strict: true });
    if (fresh && path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  /**
   * Apply every migration past `user_version`, each in its own transaction.
   * Running it again is a no-op.
   * @returns How many migrations ran.
   */
  migrate(): number {
    const { user_version: current } = this.db
      .query("PRAGMA user_version")
      .get() as { user_version: number };
    let ran = 0;
    for (let i = current; i < MIGRATIONS.length; i++) {
      this.db.transaction(() => {
        this.db.exec(MIGRATIONS[i] as string);
        this.db.exec(`PRAGMA user_version = ${i + 1}`);
      })();
      ran++;
    }
    return ran;
  }

  /** The schema version. */
  get version(): number {
    return (
      this.db.query("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
  }

  /** Close the database. */
  close(): void {
    this.db.close();
  }

  // ── local_sessions ────────────────────────────────────────────────────────

  /**
   * Record a claimed turn: insert the session, or move a known one to its new
   * work item with `seq` restarting at 1 (seq is per claim).
   * @param claim - What the assignment says.
   */
  claimSession(claim: ClaimedSession): void {
    const now = this.now();
    this.db
      .query(
        `INSERT INTO local_sessions
           (agent_session_id, linear_session_id, issue_identifier, role, repository, state,
            work_item_id, next_seq, acp_agent_id, created_at, updated_at)
         VALUES ($id, $linear, $issue, $role, $repo, 'claimed', $item, 1, $agent, $now, $now)
         ON CONFLICT (agent_session_id) DO UPDATE SET
           linear_session_id = excluded.linear_session_id,
           issue_identifier = excluded.issue_identifier,
           role = excluded.role,
           repository = excluded.repository,
           state = 'claimed',
           work_item_id = excluded.work_item_id,
           next_seq = 1,
           acp_agent_id = excluded.acp_agent_id,
           pid = NULL,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: claim.agentSessionId,
        linear: claim.linearSessionId,
        issue: claim.issueIdentifier,
        role: claim.role,
        repo: claim.repository,
        item: claim.workItemId,
        agent: claim.acpAgentId,
        now,
      });
  }

  /**
   * Move a session to a state.
   * @param agentSessionId - The session.
   * @param state - Its new state.
   * @param extra - Other columns to set (`pid`, `acpSessionId`, `acpCostUsd`).
   */
  setSessionState(
    agentSessionId: number,
    state: LocalSessionState,
    extra: {
      pid?: number | null;
      acpSessionId?: string | null;
      acpCostUsd?: number | null;
    } = {},
  ): void {
    this.db
      .query(
        `UPDATE local_sessions SET state = $state, updated_at = $now,
           pid = CASE WHEN $setPid THEN $pid ELSE pid END,
           acp_session_id = CASE WHEN $setAcp THEN $acp ELSE acp_session_id END,
           acp_cost_usd = CASE WHEN $setCost THEN $cost ELSE acp_cost_usd END
         WHERE agent_session_id = $id`,
      )
      .run({
        state,
        now: this.now(),
        id: agentSessionId,
        setPid: extra.pid !== undefined ? 1 : 0,
        pid: extra.pid ?? null,
        setAcp: extra.acpSessionId !== undefined ? 1 : 0,
        acp: extra.acpSessionId ?? null,
        setCost: extra.acpCostUsd !== undefined ? 1 : 0,
        cost: extra.acpCostUsd ?? null,
      });
  }

  /**
   * One session.
   * @param agentSessionId - The session.
   * @returns The row, or null.
   */
  session(agentSessionId: number): LocalSession | null {
    const row = this.db
      .query("SELECT * FROM local_sessions WHERE agent_session_id = $id")
      .get({ id: agentSessionId }) as Row | null;
    return row ? toSession(row) : null;
  }

  /**
   * Sessions, most recently updated first.
   * @param states - Only these states; all when omitted.
   * @returns The rows.
   */
  sessions(states?: readonly LocalSessionState[]): LocalSession[] {
    const rows = states
      ? (this.db
          .query(
            `SELECT * FROM local_sessions WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY updated_at DESC, agent_session_id DESC`,
          )
          .all(...states) as Row[])
      : (this.db
          .query(
            "SELECT * FROM local_sessions ORDER BY updated_at DESC, agent_session_id DESC",
          )
          .all() as Row[]);
    return rows.map(toSession);
  }

  /**
   * Mark every live session `interrupted`: they belong to a previous process,
   * whose agents died with its process group.
   * @returns The sessions marked.
   */
  interruptLive(): LocalSession[] {
    const live = this.sessions(LIVE_LOCAL_STATES);
    for (const s of live)
      this.setSessionState(s.agentSessionId, "interrupted", { pid: null });
    return live.map((s) => ({ ...s, state: "interrupted" as const }));
  }

  // ── pending_events ────────────────────────────────────────────────────────

  /**
   * Queue one event, durably, assigning its `seq` from the session's counter in
   * the same transaction. A new ephemeral event supersedes the session's older
   * unsent ephemeral rows — Linear would replace them on arrival anyway.
   * @param input - The event's identity and payload (without `seq`).
   * @returns The `seq` assigned.
   */
  queueEvent(input: {
    eventId: string;
    agentSessionId: number;
    workItemId: number;
    ephemeral: boolean;
    payload: Record<string, unknown>;
  }): number {
    return this.db.transaction(() => {
      const row = this.db
        .query(
          "SELECT next_seq FROM local_sessions WHERE agent_session_id = $id AND work_item_id = $item",
        )
        .get({ id: input.agentSessionId, item: input.workItemId }) as {
        next_seq: number;
      } | null;
      const seq = row?.next_seq ?? this.nextSeqFromQueue(input.workItemId);
      if (input.ephemeral) {
        this.db
          .query(
            "DELETE FROM pending_events WHERE agent_session_id = $id AND ephemeral = 1",
          )
          .run({ id: input.agentSessionId });
      }
      const now = this.now();
      this.db
        .query(
          `INSERT INTO pending_events (event_id, agent_session_id, seq, work_item_id, ephemeral, payload, created_at)
           VALUES ($eventId, $id, $seq, $item, $ephemeral, $payload, $now)`,
        )
        .run({
          eventId: input.eventId,
          id: input.agentSessionId,
          seq,
          item: input.workItemId,
          ephemeral: input.ephemeral ? 1 : 0,
          payload: JSON.stringify({ ...input.payload, seq }),
          now,
        });
      this.db
        .query(
          "UPDATE local_sessions SET next_seq = $next, last_event_at = $now WHERE agent_session_id = $id AND work_item_id = $item",
        )
        .run({
          next: seq + 1,
          now,
          id: input.agentSessionId,
          item: input.workItemId,
        });
      return seq;
    })();
  }

  /**
   * The next `seq` for a work item with no session row (a test, or a row
   * deleted by hand): one past the highest queued.
   * @param workItemId - The work item.
   * @returns The seq.
   */
  private nextSeqFromQueue(workItemId: number): number {
    const row = this.db
      .query(
        "SELECT max(seq) AS seq FROM pending_events WHERE work_item_id = $item",
      )
      .get({ item: workItemId }) as { seq: number | null };
    return (row.seq ?? 0) + 1;
  }

  /**
   * The work items that have queued events or completions, oldest first.
   * @returns Their ids.
   */
  pendingWorkItems(): number[] {
    const rows = this.db
      .query(
        `SELECT work_item_id, min(created_at) AS at FROM (
           SELECT work_item_id, created_at FROM pending_events
           UNION ALL SELECT work_item_id, created_at FROM pending_completions
         ) GROUP BY work_item_id ORDER BY at, work_item_id`,
      )
      .all() as { work_item_id: number }[];
    return rows.map((r) => r.work_item_id);
  }

  /**
   * One work item's queued events, in `seq` order.
   * @param workItemId - The work item.
   * @param limit - At most this many.
   * @returns The rows.
   */
  pendingEvents(workItemId: number, limit = 1000): PendingEvent[] {
    return (
      this.db
        .query(
          "SELECT * FROM pending_events WHERE work_item_id = $item ORDER BY seq LIMIT $limit",
        )
        .all({ item: workItemId, limit }) as Row[]
    ).map(toEvent);
  }

  /**
   * Every queued event, for tests and `doctor`.
   * @returns The rows, by work item then seq.
   */
  allPendingEvents(): PendingEvent[] {
    return (
      this.db
        .query("SELECT * FROM pending_events ORDER BY work_item_id, seq")
        .all() as Row[]
    ).map(toEvent);
  }

  /**
   * Count a failed attempt on some events.
   * @param eventIds - The events.
   */
  bumpAttempts(eventIds: readonly string[]): void {
    const stmt = this.db.query(
      "UPDATE pending_events SET attempts = attempts + 1 WHERE event_id = $id",
    );
    this.db.transaction(() => {
      for (const id of eventIds) stmt.run({ id });
    })();
  }

  /**
   * Delete events the server acknowledged (or refused for good).
   * @param eventIds - The events.
   */
  deleteEvents(eventIds: readonly string[]): void {
    const stmt = this.db.query(
      "DELETE FROM pending_events WHERE event_id = $id",
    );
    this.db.transaction(() => {
      for (const id of eventIds) stmt.run({ id });
    })();
  }

  /**
   * Drop everything queued for a work item: the server no longer considers it
   * this runner's, so nothing more may be written for it.
   * @param workItemId - The work item.
   */
  dropWorkItem(workItemId: number): void {
    this.db.transaction(() => {
      this.db
        .query("DELETE FROM pending_events WHERE work_item_id = $item")
        .run({ item: workItemId });
      this.db
        .query("DELETE FROM pending_completions WHERE work_item_id = $item")
        .run({ item: workItemId });
    })();
  }

  // ── pending_completions ───────────────────────────────────────────────────

  /**
   * Queue a `daemon:complete`, sent once its work item's events have landed.
   * @param workItemId - The work item.
   * @param payload - The `CompleteRequest`.
   */
  queueCompletion(workItemId: number, payload: Record<string, unknown>): void {
    this.db
      .query(
        `INSERT INTO pending_completions (work_item_id, payload, created_at) VALUES ($item, $payload, $now)
         ON CONFLICT (work_item_id) DO UPDATE SET payload = excluded.payload`,
      )
      .run({
        item: workItemId,
        payload: JSON.stringify(payload),
        now: this.now(),
      });
  }

  /**
   * One queued completion.
   * @param workItemId - The work item.
   * @returns The row, or null.
   */
  pendingCompletion(workItemId: number): PendingCompletion | null {
    const row = this.db
      .query("SELECT * FROM pending_completions WHERE work_item_id = $item")
      .get({ item: workItemId }) as Row | null;
    return row
      ? {
          workItemId: row.work_item_id as number,
          payload: JSON.parse(row.payload as string),
          createdAt: row.created_at as number,
        }
      : null;
  }

  /**
   * Delete a completion the server acknowledged.
   * @param workItemId - The work item.
   */
  deleteCompletion(workItemId: number): void {
    this.db
      .query("DELETE FROM pending_completions WHERE work_item_id = $item")
      .run({ item: workItemId });
  }

  // ── worktrees ─────────────────────────────────────────────────────────────

  /**
   * The worktrees this runner owns, removed ones included.
   * @param options - Leave out removed rows.
   * @returns The rows, most recently used first.
   */
  worktrees(options: { live?: boolean } = {}): LocalWorktree[] {
    return (
      this.db
        .query(
          `SELECT * FROM worktrees ${options.live ? "WHERE state != 'removed'" : ""} ORDER BY last_used_at DESC, id DESC`,
        )
        .all() as Row[]
    ).map(toWorktree);
  }

  /**
   * One worktree.
   * @param id - Its id.
   * @returns The row, or null.
   */
  worktree(id: number): LocalWorktree | null {
    const row = this.db
      .query("SELECT * FROM worktrees WHERE id = $id")
      .get({ id }) as Row | null;
    return row ? toWorktree(row) : null;
  }

  /**
   * The worktree at a path, removed or not.
   * @param path - The directory.
   * @returns The row, or null.
   */
  worktreeAt(path: string): LocalWorktree | null {
    const row = this.db
      .query("SELECT * FROM worktrees WHERE path = $path")
      .get({ path }) as Row | null;
    return row ? toWorktree(row) : null;
  }

  /**
   * Record a new worktree, `active`, and link its session to it. A removed
   * row at the same path is replaced.
   * @param input - What it is.
   * @returns The row.
   */
  insertWorktree(input: NewWorktree): LocalWorktree {
    const now = this.now();
    return this.db.transaction(() => {
      this.db
        .query("DELETE FROM worktrees WHERE path = $path AND state = 'removed'")
        .run({ path: input.path });
      const row = this.db
        .query(
          `INSERT INTO worktrees (kind, repository, repo_path, path, branch, base_branch, agent_session_id,
             created_at, last_used_at, state)
           VALUES ($kind, $repository, $repoPath, $path, $branch, $base, $session, $now, $now, 'active')
           RETURNING *`,
        )
        .get({
          kind: input.kind,
          repository: input.repository,
          repoPath: input.repoPath,
          path: input.path,
          branch: input.branch,
          base: input.baseBranch,
          session: input.agentSessionId,
          now,
        }) as Row;
      this.db
        .query(
          "UPDATE local_sessions SET worktree_id = $wt WHERE agent_session_id = $id",
        )
        .run({ wt: row.id as number, id: input.agentSessionId });
      return toWorktree(row);
    })();
  }

  /**
   * Update a worktree.
   * @param id - Its id.
   * @param changes - The columns to set.
   */
  updateWorktree(
    id: number,
    changes: {
      state?: LocalWorktree["state"];
      setupDone?: boolean;
      keptReason?: string | null;
      pushed?: boolean;
      touch?: boolean;
      agentSessionId?: number;
    },
  ): void {
    const sets: string[] = [];
    const values: Record<string, string | number | null> = { id };
    if (changes.state !== undefined) {
      sets.push("state = $state");
      values.state = changes.state;
      if (changes.state === "removed") {
        sets.push("removed_at = $removedAt");
        values.removedAt = this.now();
      }
    }
    if (changes.setupDone !== undefined) {
      sets.push("setup_done = $setupDone");
      values.setupDone = changes.setupDone ? 1 : 0;
    }
    if (changes.keptReason !== undefined) {
      sets.push("kept_reason = $keptReason");
      values.keptReason = changes.keptReason;
    }
    if (changes.pushed !== undefined) {
      sets.push("pushed = $pushed");
      values.pushed = changes.pushed ? 1 : 0;
    }
    if (changes.touch) {
      sets.push("last_used_at = $now");
      values.now = this.now();
    }
    if (changes.agentSessionId !== undefined) {
      sets.push("agent_session_id = $session");
      values.session = changes.agentSessionId;
    }
    if (!sets.length) return;
    this.db
      .query(`UPDATE worktrees SET ${sets.join(", ")} WHERE id = $id`)
      .run(values);
  }

  /**
   * Link a session to a worktree it reuses.
   * @param agentSessionId - The session.
   * @param worktreeId - The worktree.
   */
  linkWorktree(agentSessionId: number, worktreeId: number | null): void {
    this.db
      .query(
        "UPDATE local_sessions SET worktree_id = $wt WHERE agent_session_id = $id",
      )
      .run({ wt: worktreeId, id: agentSessionId });
  }

  /**
   * Record how a turn ended, for the cleanup policies.
   * @param agentSessionId - The session.
   * @param lastAnswer - The last answering event's type, or null.
   */
  recordTurnEnd(agentSessionId: number, lastAnswer: string | null): void {
    this.db
      .query(
        "UPDATE local_sessions SET last_answer = $answer, ended_at = $now WHERE agent_session_id = $id",
      )
      .run({ answer: lastAnswer, now: this.now(), id: agentSessionId });
  }

  /**
   * Remember a pull request linked to a session.
   * @param agentSessionId - The session.
   * @param url - The pull request.
   */
  addPullRequest(agentSessionId: number, url: string): void {
    const session = this.session(agentSessionId);
    if (!session || session.pullRequests.includes(url)) return;
    this.db
      .query(
        "UPDATE local_sessions SET pull_requests = $prs WHERE agent_session_id = $id",
      )
      .run({
        prs: JSON.stringify([...session.pullRequests, url]),
        id: agentSessionId,
      });
  }
}
