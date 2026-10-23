import type { AgentSessionList } from "@backend/actions/agent-session/agent-session-list";
import type { WaitingCode } from "@backend/schema/work_items";
import type { ActionResponse } from "keryx";
import type { AgentSessionStatus } from "../ui";

/** A session as `agent-session:list` serializes it. */
export type ListedSession =
  ActionResponse<AgentSessionList>["agentSessions"][number];

/**
 * The dashboard channel a project's sessions are refreshed on.
 * @param projectId - The project on screen.
 * @returns `project:<id>:sessions`.
 */
export function sessionsChannel(projectId: number): string {
  return `project:${projectId}:sessions`;
}

/** What a sessions frame says changed. */
export type SessionsFrame =
  | { event: "sessions" }
  | { event: "session"; id: number };

/**
 * Read a frame from `project:<id>:sessions`. Anything else is ignored.
 * @param payload - The parsed inner payload of a broadcast.
 * @returns The frame, or null.
 */
export function parseSessionsFrame(payload: unknown): SessionsFrame | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { event, id } = payload as { event?: unknown; id?: unknown };
  if (event === "sessions") return { event };
  if (event === "session" && typeof id === "number") return { event, id };
  return null;
}

/**
 * Whether a frame concerns one session's page: its own id, or the whole list.
 * @param frame - The frame.
 * @param id - The session on screen.
 * @returns True when the page should re-read.
 */
export function frameTouches(frame: SessionsFrame, id: number): boolean {
  return frame.event === "sessions" || frame.id === id;
}

/**
 * A server status as a glyph status. The server and the UI kit share Linear's
 * seven names; anything new draws as pending rather than crashing.
 * @param status - The session's status.
 * @returns The glyph status.
 */
export function glyphStatus(status: string): AgentSessionStatus {
  const known: AgentSessionStatus[] = [
    "pending",
    "active",
    "awaitingInput",
    "complete",
    "error",
    "stale",
    "stopping",
  ];
  return (known as string[]).includes(status)
    ? (status as AgentSessionStatus)
    : "pending";
}

/**
 * Why a turn waits, or why a runner was ruled out, in words. The codes are
 * the server's (`work:route` records them; `routing-rule:preview` gives them
 * per runner); the record type makes a new code a compile error here.
 */
export const WAITING_LABELS: Record<WaitingCode, string> = {
  offline: "Runner offline",
  draining: "Runner draining",
  paused: "Runner paused",
  no_capacity: "No free slot",
  role_not_served: "Role not served",
  repository_missing: "Repository not checked out",
  subscription_mismatch: "Not subscribed to this issue",
  no_runners: "No runners in this project",
  sticky_runner: "Waiting for the runner with its worktree",
  offer_lapsed: "Offer lapsed; retrying",
};

/**
 * A waiting code in words, falling back to the code itself.
 * @param code - The code, or null.
 * @returns The label, or null.
 */
export function waitingLabel(code: string | null): string | null {
  if (code === null) return null;
  return WAITING_LABELS[code as WaitingCode] ?? code;
}

/** What a session's turns cost, as `agent-session:view` totals them. */
export interface CostTotals {
  turns: number;
  unpricedTurns: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

/**
 * Dollars as a person reads them: cents, or two significant places below a cent.
 * @param usd - Dollars.
 * @returns `$1.25` or `$0.0042`.
 */
export function formatUsd(usd: number): string {
  if (usd !== 0 && Math.abs(usd) < 0.01) return `$${usd.toPrecision(2)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * A session's cost on one line: dollars when the agent reported them, the
 * tokens, and how many turns it reported no cost for. Null for a session no
 * runner has run.
 * @param totals - The totals.
 * @returns `$1.25 · 1,500 tokens`, `1,500 tokens · 1 turn unpriced`, or null.
 */
export function costLabel(totals: CostTotals | null): string | null {
  if (!totals || totals.turns === 0) return null;
  const tokens = totals.inputTokens + totals.outputTokens;
  const parts = [
    ...(totals.costUsd !== null ? [formatUsd(totals.costUsd)] : []),
    `${tokens.toLocaleString("en-US")} tokens`,
  ];
  if (totals.unpricedTurns > 0) {
    parts.push(
      `${totals.unpricedTurns} turn${totals.unpricedTurns === 1 ? "" : "s"} unpriced`,
    );
  }
  return parts.join(" · ");
}
