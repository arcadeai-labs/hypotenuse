import { AgentBadge, Chip, RoleChip, Table } from "../../ui";
import { waitingLabel } from "../../utils/sessions";
import { type SessionTurn, turnDuration } from "../../utils/transcript";
import { relativeTime } from "../NotificationBell";

/**
 * Every turn a session took: kind, role, status, runner, when it was queued,
 * claimed, and finished, how many claims were lost, and — the column that
 * answers "why is it pending" — why a waiting turn waits or why one ended
 * without finishing.
 * @param props - The turns and the clock.
 * @returns The table.
 */
export function WorkItemTimeline({
  turns,
  now,
}: {
  turns: SessionTurn[];
  now: number;
}) {
  if (turns.length === 0) {
    return (
      <p className="text-muted" data-testid="turns-empty">
        No turns yet.
      </p>
    );
  }
  return (
    <Table size="sm" responsive data-testid="turns-table">
      <thead>
        <tr>
          <th scope="col">Turn</th>
          <th scope="col">Status</th>
          <th scope="col">Runner</th>
          <th scope="col">Queued</th>
          <th scope="col">Ran</th>
          <th scope="col">Why</th>
        </tr>
      </thead>
      <tbody>
        {turns.map((turn) => (
          <tr key={turn.id} data-testid={`turn-${turn.id}`}>
            <td>
              {turn.kind.replace("_", " ")}{" "}
              {turn.role && <RoleChip role={turn.role} />}
            </td>
            <td>
              <Chip>{turn.status}</Chip>
              {turn.attempts > 0 && (
                <span className="text-meta"> · {turn.attempts} lost</span>
              )}
            </td>
            <td>
              {turn.runnerName ?? <span className="text-muted">—</span>}{" "}
              {turn.agentId && <AgentBadge kind={turn.agentId} />}
            </td>
            <td className="tabular">{relativeTime(turn.queuedAt)}</td>
            <td className="tabular">{turnDuration(turn, now) ?? "—"}</td>
            <td data-testid={`turn-why-${turn.id}`}>{turnReason(turn)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

/**
 * Why a turn is where it is, in words: the waiting code for a queued turn,
 * the cancel reason for a cancelled one, the error for a failed or expired one.
 * @param turn - The turn.
 * @returns The text, or a dash.
 */
export function turnReason(turn: SessionTurn): string {
  if (turn.status === "queued" || turn.status === "offered") {
    return (
      waitingLabel(turn.waitingCode) ??
      turn.waitingReason ??
      (turn.status === "offered" ? "Offered to a runner" : "Queued")
    );
  }
  if (turn.status === "cancelled") {
    return turn.cancelReason ? `Cancelled: ${turn.cancelReason}` : "Cancelled";
  }
  if (turn.status === "failed" || turn.status === "expired") {
    return turn.outcome?.error ?? turn.waitingReason ?? turn.status;
  }
  return "—";
}
