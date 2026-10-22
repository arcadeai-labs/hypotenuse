import { inArray } from "drizzle-orm";
import { api } from "keryx";
import { agentSessions } from "../schema/agent_sessions";

/**
 * `project:<projectId>:sessions` — the dashboard's wake-up call for a
 * project's agent sessions. Frames are content-free: `{ event: "sessions" }`
 * (something in the list changed) or `{ event: "session", id }` (this one
 * did). The client re-reads over HTTP; Postgres stays the truth.
 *
 * The id may ride in the frame because every member can read every session of
 * the project (the integration is workspace-wide). If a session ever becomes
 * readable by only some members, the id leaves the frame in the same commit;
 * a test pins the frame's key set so that change is noticed.
 *
 * Every publisher runs after commit and never throws: the change it reports
 * already happened, and a dashboard that missed a frame re-reads on reconnect.
 */

/** The channel-name shape {@link projectSessionsChannel} produces. */
export const PROJECT_SESSIONS_CHANNEL_PATTERN = /^project:(\d+):sessions$/;

/** How long one session's activity frames are coalesced for. */
export const SESSION_FRAME_WINDOW_MS = 1000;

/**
 * The channel a project's dashboards watch for session changes.
 * @param projectId - The project.
 * @returns `project:<projectId>:sessions`.
 */
export function projectSessionsChannel(projectId: number): string {
  return `project:${projectId}:sessions`;
}

/**
 * The Redis key that holds one session's frame window.
 * @param agentSessionId - The session.
 * @returns The key.
 */
export function sessionFrameKey(agentSessionId: number): string {
  return `sessions:frame:${agentSessionId}`;
}

/**
 * The Redis key that says a trailing frame is already scheduled.
 * @param agentSessionId - The session.
 * @returns The key.
 */
export function sessionTrailingKey(agentSessionId: number): string {
  return `sessions:trailing:${agentSessionId}`;
}

/**
 * Tell a project's dashboards a session changed, or (with no id) that its
 * list did. Never throws.
 * @param projectId - The project.
 * @param agentSessionId - The session, when one is known.
 */
export async function broadcastSessionUpdate(
  projectId: number,
  agentSessionId?: number,
): Promise<void> {
  try {
    const frame =
      agentSessionId === undefined
        ? { event: "sessions" }
        : { event: "session", id: agentSessionId };
    await api.pubsub.broadcast(
      projectSessionsChannel(projectId),
      JSON.stringify(frame),
      "sessions",
    );
  } catch (error) {
    api.logger.warn("session broadcast failed", {
      projectId,
      agentSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * {@link broadcastSessionUpdate} for sessions known only by id: one read for
 * their projects, then one frame each. Never throws.
 * @param agentSessionIds - The sessions that changed.
 */
export async function broadcastSessionsChanged(
  agentSessionIds: Iterable<number>,
): Promise<void> {
  const ids = [...new Set(agentSessionIds)];
  if (ids.length === 0) return;
  try {
    const rows = await api.db.db
      .select({ id: agentSessions.id, projectId: agentSessions.projectId })
      .from(agentSessions)
      .where(inArray(agentSessions.id, ids));
    for (const row of rows) await broadcastSessionUpdate(row.projectId, row.id);
  } catch (error) {
    api.logger.warn("session broadcast failed", {
      agentSessionIds: ids,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * The outbox's frame: one per session per {@link SESSION_FRAME_WINDOW_MS},
 * however many activities it sends. The first send in a window publishes at
 * once; a later one schedules a single trailing frame at the window's end
 * (`sessions:broadcast`), so the last activity of a burst is never left
 * unannounced. Coalesced in Redis, so it holds across processes. Never
 * throws.
 * @param agentSessionId - The session whose activities were sent.
 */
export async function broadcastSessionActivity(
  agentSessionId: number,
): Promise<void> {
  try {
    const redis = api.redis.redis;
    const window = SESSION_FRAME_WINDOW_MS;
    if (
      (await redis.set(
        sessionFrameKey(agentSessionId),
        "1",
        "PX",
        window,
        "NX",
      )) === "OK"
    ) {
      await broadcastSessionsChanged([agentSessionId]);
      return;
    }
    if (
      (await redis.set(
        sessionTrailingKey(agentSessionId),
        "1",
        "PX",
        window,
        "NX",
      )) === "OK"
    ) {
      await api.actions.enqueueIn(window, "sessions:broadcast", {
        agentSessionId,
      });
    }
  } catch (error) {
    api.logger.warn("session activity broadcast failed", {
      agentSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
