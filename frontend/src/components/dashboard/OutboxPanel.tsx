import type { ConversationOutbox } from "@backend/actions/conversation/conversation-outbox";
import type { ActionResponse } from "keryx";
import { useEffect } from "react";
import { Chip } from "../../ui";
import { useRead } from "../bots/data";
import { ago } from "./model";

/** One outbox row. */
type OutboxRow = ActionResponse<ConversationOutbox>["outbox"][number];

/**
 * What a delivery status is called, and whether it is a problem.
 * @param status - The row's status.
 * @returns The words and whether to draw it as a warning.
 */
export function outboxStatusLabel(status: string): {
  label: string;
  problem: boolean;
} {
  switch (status) {
    case "sent":
      return { label: "Sent", problem: false };
    case "pending":
      return { label: "Queued", problem: false };
    case "sending":
      return { label: "Sending", problem: false };
    case "superseded":
      return { label: "Replaced", problem: false };
    case "failed":
      return { label: "Retrying", problem: true };
    case "undeliverable":
      return { label: "Undeliverable", problem: true };
    default:
      return { label: status, problem: false };
  }
}

/**
 * A row's text, when its payload has some.
 * @param row - The row.
 * @returns One line, or the kind.
 */
function rowText(row: OutboxRow): string {
  const p = row.payload as Record<string, unknown>;
  for (const key of ["text", "summary", "reason", "question", "label"]) {
    const v = p[key];
    if (typeof v === "string" && v.trim()) return v.trim().split("\n")[0];
  }
  return row.kind;
}

/**
 * "Sent to the platform": the conversation's outbox, newest first, with each
 * row's delivery status — what reached Slack, Linear, Pylon, or a callback,
 * and what did not. Folded by default; re-read whenever the transcript moves.
 * @param props - The project, conversation, and a value that changes when it moves.
 * @returns The panel.
 */
export function OutboxPanel({
  projectId,
  conversationId,
  version,
}: {
  projectId: number;
  conversationId: number;
  version: number;
}) {
  const outbox = useRead<ActionResponse<ConversationOutbox>>(
    `/project/${projectId}/conversation/${conversationId}/outbox?limit=25`,
  );
  const { reload } = outbox;
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-read when the transcript moves.
  useEffect(() => {
    reload();
  }, [version, reload]);
  const rows = outbox.data?.outbox ?? [];
  const total = outbox.data?.pagination.total ?? 0;
  const problems = rows.filter((r) => outboxStatusLabel(r.status).problem);
  return (
    <details
      className="tx-fold dashboard-outbox"
      data-testid="conversation-outbox"
    >
      <summary>
        Sent to the platform{" "}
        <span className="tabular" data-testid="conversation-outbox-count">
          ({total})
        </span>
        {problems.length > 0 && (
          <Chip data-testid="conversation-outbox-problems">
            {problems.length} not delivered
          </Chip>
        )}
      </summary>
      {outbox.error && <p className="dashboard-detail">{outbox.error}</p>}
      {rows.length === 0 && !outbox.error && (
        <p className="dashboard-detail">Nothing sent yet.</p>
      )}
      <ol className="dashboard-outbox-rows">
        {rows.map((row) => {
          const status = outboxStatusLabel(row.status);
          return (
            <li
              key={row.id}
              data-testid={`outbox-row-${row.id}`}
              data-status={row.status}
            >
              <span className="dashboard-outbox-kind">{row.kind}</span>
              <span className="dashboard-outbox-text">{rowText(row)}</span>
              <span
                className={
                  status.problem
                    ? "dashboard-outbox-problem"
                    : "dashboard-detail"
                }
                title={row.error ?? undefined}
              >
                {status.label}
                {row.attempts > 1 ? ` · ${row.attempts} tries` : ""}
              </span>
              <span className="dashboard-detail tabular">
                {ago(row.createdAt)}
              </span>
            </li>
          );
        })}
      </ol>
    </details>
  );
}
