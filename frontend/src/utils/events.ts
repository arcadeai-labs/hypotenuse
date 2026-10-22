import type { TriggerEventList } from "@backend/actions/trigger-event/trigger-event-list";
import type { ActionResponse } from "keryx";
import type { AgentSessionStatus } from "../ui";
import { waitingLabel } from "./sessions";

/** An event as `trigger-event:list` serializes it. */
export type ListedEvent =
  ActionResponse<TriggerEventList>["triggerEvents"][number];

/** Every outcome a recorded delivery can reach, in the order a filter lists them. */
export const EVENT_OUTCOMES = [
  "handled",
  "ignored",
  "duplicate_of_dispatch",
  "failed",
  "pending",
] as const satisfies readonly ListedEvent["outcome"][];

/** An outcome in words. The record type makes a new outcome a compile error here. */
export const OUTCOME_LABELS: Record<ListedEvent["outcome"], string> = {
  pending: "Pending",
  handled: "Handled",
  duplicate_of_dispatch: "Duplicate of a dispatch",
  ignored: "Ignored",
  unknown_integration: "No connected project",
  failed: "Failed",
};

/** The event types Linear sends that the log offers as a filter. */
export const EVENT_TYPES = [
  "AgentSessionEvent",
  "Issue",
  "PermissionChange",
  "OAuthApp",
  "AppUserNotification",
] as const;

/**
 * The dashboard channel a project's event log is refreshed on. Its one
 * frame, `{ event: "events" }`, carries nothing: the page re-reads.
 * @param projectId - The project on screen.
 * @returns `project:<id>:events`.
 */
export function eventsChannel(projectId: number): string {
  return `project:${projectId}:events`;
}

/**
 * Whether a socket frame is the event log's refresh frame. Presence frames
 * are not.
 * @param payload - The parsed inner payload of a broadcast.
 * @returns True for `{ event: "events" }`.
 */
export function isEventsPayload(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { event?: unknown }).event === "events"
  );
}

/**
 * The shared status glyph an outcome is drawn with — a shape per state, so
 * colour is never the only cue: done is complete, not acted on is stale.
 * @param outcome - The event's outcome.
 * @returns The glyph status.
 */
export function outcomeGlyph(
  outcome: ListedEvent["outcome"],
): AgentSessionStatus {
  switch (outcome) {
    case "handled":
    case "duplicate_of_dispatch":
      return "complete";
    case "failed":
      return "error";
    case "pending":
      return "pending";
    default:
      return "stale";
  }
}

/**
 * How an event's session got its role, in words: the rule that chose it, a
 * manager's dispatch, or the default.
 * @param event - The event.
 * @returns "rule /manage", "dispatched", "default", or null before routing.
 */
export function roleReason(event: ListedEvent): string | null {
  const session = event.session;
  if (!session?.role) return null;
  if (session.routingRule) return `rule ${session.routingRule.name}`;
  if (session.dispatched) return "dispatched";
  return "default";
}

/**
 * Where an event's turn is now, in words: its runner, why it waits, or how
 * it ended.
 * @param event - The event.
 * @returns The placement, or null when the event touched no turn.
 */
export function placement(event: ListedEvent): string | null {
  const turn = event.turn;
  if (!turn) return null;
  switch (turn.status) {
    case "queued":
      return `Waiting: ${waitingLabel(turn.waitingCode) ?? turn.waitingReason ?? "queued"}`;
    case "offered":
      return turn.runner ? `Offered to ${turn.runner.name}` : "Offered";
    case "claimed":
    case "running":
      return turn.runner ? `Running on ${turn.runner.name}` : "Running";
    case "cancelled":
      return turn.cancelReason
        ? `Cancelled: ${turn.cancelReason}`
        : "Cancelled";
    default:
      return turn.runner
        ? `${capitalize(turn.status)} on ${turn.runner.name}`
        : capitalize(turn.status);
  }
}

/**
 * A word with its first letter in capitals.
 * @param text - The word.
 * @returns It, capitalized.
 */
function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
