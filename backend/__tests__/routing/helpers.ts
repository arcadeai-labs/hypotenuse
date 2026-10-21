import { afterAll, beforeAll } from "bun:test";
import {
  type ClaimResponse,
  type HeartbeatRequest,
  HeartbeatResponse,
  type SessionEvent,
  type WorkAssignment,
} from "@hypotenuse/protocol";
import { asc, eq } from "drizzle-orm";
import { api, config } from "keryx";
import { agentSessions } from "../../schema/agent_sessions";
import { type WorkItem, workItems } from "../../schema/work_items";
import type { Finear } from "../linear/sessions";
import {
  createIssue,
  delegate,
  recordedEvent,
  sessionRow,
  settle,
} from "../linear/sessions";
import {
  daemonHeaders,
  heartbeatBody,
  registerRunner,
  type TestRunner,
} from "../runners/helpers";
import { runAction, type TestUser } from "../setup";

/**
 * Work routing's test harness: a **scripted daemon** that registers a runner
 * over HTTP and speaks the daemon's half of the wire — heartbeat, claim,
 * events, complete — exactly as a daemon would, with no daemon process; and
 * helpers that start sessions in finear and run routing in-process.
 */

/**
 * Turn the per-runner rate limits off for the file: a scripted daemon
 * heartbeats far more often than every 15 seconds. Restored afterwards.
 */
export function withoutRunnerRateLimits(): void {
  let saved = true;
  beforeAll(() => {
    saved = config.runners.rateLimitEnabled;
    config.runners.rateLimitEnabled = false;
  });
  afterAll(() => {
    config.runners.rateLimitEnabled = saved;
  });
}

/** What a scripted daemon reports about itself, beyond the defaults. */
export type DaemonShape = Partial<Omit<HeartbeatRequest, "active">>;

/** A raw response with its parsed JSON body. */
export interface Answer<T = Record<string, unknown>> {
  status: number;
  body: T;
}

/**
 * One runner and the daemon a test drives for it.
 */
export class ScriptedDaemon {
  /** The heartbeat body, minus `active`, which the daemon tracks itself. */
  shape: Omit<HeartbeatRequest, "active">;
  /** The work items this daemon believes it holds. */
  readonly held = new Set<number>();
  private readonly seqs = new Map<number, number>();

  /**
   * @param url - The server.
   * @param runner - The registered runner.
   * @param shape - Its heartbeat, minus `active`.
   */
  constructor(
    readonly url: string,
    readonly runner: TestRunner,
    shape: Omit<HeartbeatRequest, "active">,
  ) {
    this.shape = shape;
  }

  /**
   * Register a runner as a user and give it a shape.
   * @param url - The server.
   * @param user - Its owner.
   * @param projectId - The project.
   * @param name - Its name.
   * @param shape - What it reports.
   * @returns The daemon.
   */
  static async register(
    url: string,
    user: TestUser,
    projectId: number,
    name: string,
    shape: DaemonShape = {},
  ): Promise<ScriptedDaemon> {
    const runner = await registerRunner(url, user, projectId, name);
    const { active: _active, ...base } = heartbeatBody({
      hostname: name,
      capabilities: {
        roles: ["manager", "worker"],
        agents: [{ id: "claude", preset: "claude", available: true }],
        repositories: [
          { name: "web", remote: "github.com/acme/web", baseBranch: "main" },
        ],
        subscriptions: { teams: [], projects: [], labels: [] },
      },
    });
    const daemon = new ScriptedDaemon(url, runner, { ...base, ...shape });
    return daemon;
  }

  /** The runner's id. */
  get id(): number {
    return this.runner.id;
  }

  /**
   * POST to a daemon route.
   * @param path - Under `/api/daemon/`.
   * @param body - The JSON body.
   * @returns The status and body.
   */
  async post<T = Record<string, unknown>>(
    path: string,
    body: unknown,
  ): Promise<Answer<T>> {
    const res = await fetch(`${this.url}/api/daemon/${path}`, {
      method: "POST",
      headers: daemonHeaders(this.runner.token),
      body: JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
  }

  /**
   * Heartbeat, reporting the items it holds; forgets what the server says
   * is no longer its own.
   * @param over - Fields to change in the shape from now on.
   * @returns The parsed heartbeat response.
   */
  async heartbeat(over: DaemonShape = {}): Promise<HeartbeatResponse> {
    this.shape = { ...this.shape, ...over };
    const { status, body } = await this.post("heartbeat", {
      ...this.shape,
      active: [...this.held].map((workItemId) => ({
        workItemId,
        agentSessionId: 1,
        role: "worker",
        agentId: "claude",
        state: "running",
      })),
    });
    if (status !== 200) {
      throw new Error(`heartbeat ${status}: ${JSON.stringify(body)}`);
    }
    const parsed = HeartbeatResponse.parse(body);
    for (const id of parsed.unknownActive) this.held.delete(id);
    return parsed;
  }

  /**
   * Claim an offer.
   * @param workItemIds - Which, if any.
   * @returns The assignment, or null.
   */
  async claim(workItemIds?: number[]): Promise<WorkAssignment | null> {
    const { status, body } = await this.post<ClaimResponse>(
      "claim",
      workItemIds ? { workItemIds } : {},
    );
    if (status !== 200) {
      throw new Error(`claim ${status}: ${JSON.stringify(body)}`);
    }
    if (body.assignment) this.held.add(body.assignment.workItemId);
    return body.assignment;
  }

  /**
   * Post events for a held item, numbering them after the last ones sent.
   * @param workItemId - The item.
   * @param events - The events, without `eventId`, `seq`, or `at` (each may
   *   carry its own to override).
   * @returns The status and body.
   */
  async events(
    workItemId: number,
    events: Record<string, unknown>[],
  ): Promise<Answer> {
    let seq = this.seqs.get(workItemId) ?? 0;
    const numbered = events.map((event) => ({
      eventId: crypto.randomUUID(),
      seq: ++seq,
      at: Date.now(),
      ...event,
    }));
    this.seqs.set(workItemId, seq);
    return this.post("events", { workItemId, events: numbered });
  }

  /**
   * Post an exact batch, as given.
   * @param workItemId - The item.
   * @param events - Complete events.
   * @returns The status and body.
   */
  async rawEvents(
    workItemId: number,
    events: SessionEvent[] | Record<string, unknown>[],
  ): Promise<Answer> {
    return this.post("events", { workItemId, events });
  }

  /**
   * Complete a held item.
   * @param workItemId - The item.
   * @param outcome - How it ended.
   * @param extra - `error`, `branch`, `acpSessionId`.
   * @returns The status and body.
   */
  async complete(
    workItemId: number,
    outcome: "completed" | "failed" | "cancelled",
    extra: Record<string, unknown> = {},
  ): Promise<Answer> {
    const answer = await this.post("complete", {
      workItemId,
      outcome,
      ...extra,
    });
    this.held.delete(workItemId);
    return answer;
  }
}

/**
 * Run routing once, in-process.
 * @returns What the pass did.
 */
export async function route(): Promise<{
  ran: boolean;
  prepared: number;
  offered: number[];
  lapsed: number[];
}> {
  return runAction("work:route");
}

/**
 * Run the lease clock once, in-process.
 * @returns What it reaped.
 */
export async function reap(): Promise<{
  requeued: number[];
  failed: number[];
  stopped: number[];
}> {
  return runAction("work:reap");
}

/**
 * Start a session by delegating a new issue in finear, and settle it: mirrored,
 * acknowledged, prepared, and (if a runner can take it) offered.
 * @param linear - The harness.
 * @param appUserId - The app user.
 * @param title - The issue's title.
 * @returns The issue and the mirror row.
 */
export async function delegatedSession(
  linear: Finear,
  appUserId: string,
  title: string,
) {
  const issue = await createIssue(linear, title);
  const externalSessionId = await delegate(linear, issue.id, appUserId);
  await recordedEvent(
    (e) =>
      e.action === "created" &&
      (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
        externalSessionId,
  );
  await settle();
  const session = await sessionRow(externalSessionId);
  if (!session) throw new Error("no mirror row");
  return { issue, externalSessionId, session };
}

/**
 * A person prompts a session in finear; the webhook is processed and routed.
 * @param linear - The harness.
 * @param externalSessionId - Linear's session id.
 * @param body - What they type.
 * @param signal - `stop` to press Stop instead.
 */
export async function personSays(
  linear: Finear,
  externalSessionId: string,
  body: string,
  signal?: "stop",
): Promise<void> {
  await linear.control(
    signal === "stop" ? "/__test/agents/stop" : "/__test/agents/prompt",
    { sessionId: externalSessionId, body },
  );
  await recordedEvent(
    (e) =>
      e.action === "prompted" &&
      (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
        externalSessionId &&
      (e.payload as { agentActivity?: { content?: { body?: string } } })
        .agentActivity?.content?.body === body,
  );
  await settle();
}

/**
 * A session's work items, oldest first.
 * @param agentSessionId - The session.
 * @returns The rows.
 */
export async function itemsOf(agentSessionId: number): Promise<WorkItem[]> {
  return api.db.db
    .select()
    .from(workItems)
    .where(eq(workItems.agentSessionId, agentSessionId))
    .orderBy(asc(workItems.id));
}

/**
 * One work item.
 * @param id - The item.
 * @returns The row.
 */
export async function itemRow(id: number): Promise<WorkItem> {
  const [row] = await api.db.db
    .select()
    .from(workItems)
    .where(eq(workItems.id, id));
  if (!row) throw new Error(`no work item ${id}`);
  return row;
}

/**
 * Change a work item's columns directly — how a test moves time.
 * @param id - The item.
 * @param set - The columns.
 */
export async function setItem(
  id: number,
  set: Partial<typeof workItems.$inferInsert>,
): Promise<void> {
  await api.db.db.update(workItems).set(set).where(eq(workItems.id, id));
}

/**
 * A session row, re-read.
 * @param id - The session's id.
 * @returns The row.
 */
export async function sessionById(id: number) {
  const [row] = await api.db.db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, id));
  return row;
}

/**
 * A time `ms` ago.
 * @param ms - How long ago.
 * @returns The date.
 */
export function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}
