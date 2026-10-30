import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { StatusGlyph } from "../../ui";
import { apiFetch } from "../../utils/client";
import { expiresInWords } from "../../utils/mcp";
import type { ApprovalDetail } from "../mcp/data";

/**
 * What a conversation parked on approvals waits for: one accented card per
 * call — "Waiting for approval to run mail/send_email" — linking to the
 * approval, where someone who may decide it does. The tool call's own row in
 * the transcript above shows its intent with no result until then.
 *
 * Each approval is read by id; one the reader may not see, or that is gone,
 * still gets its line, without a name.
 * @param props.projectId - The project.
 * @param props.approvalIds - `waitingOn.approvalIds`.
 * @returns The cards.
 */
export function ApprovalWait({
  projectId,
  approvalIds,
}: {
  projectId: number;
  approvalIds: readonly number[];
}) {
  const [approvals, setApprovals] = useState<Map<number, ApprovalDetail>>(
    () => new Map(),
  );
  const key = approvalIds.join(",");

  useEffect(() => {
    let cancelled = false;
    const ids = key ? key.split(",").map(Number) : [];
    Promise.all(
      ids.map((id) =>
        apiFetch<{ approval: ApprovalDetail }>(
          `/project/${projectId}/approval/${id}`,
        )
          .then((res) => res.approval)
          .catch(() => null),
      ),
    ).then((found) => {
      if (cancelled) return;
      setApprovals(
        new Map(
          found
            .filter((a): a is ApprovalDetail => a !== null)
            .map((a) => [a.id, a]),
        ),
      );
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, key]);

  return (
    <div className="approval-wait" data-testid="approval-wait">
      {approvalIds.map((id) => {
        const approval = approvals.get(id);
        return (
          <div
            key={id}
            className="tx-card tx-ask"
            data-testid={`approval-wait-${id}`}
          >
            <div className="tx-card-title">
              <StatusGlyph state="waiting" waitingOn="approval" />
              <span>
                Waiting for approval to run{" "}
                {approval ? (
                  <span className="mono">{approval.name}</span>
                ) : (
                  "a tool call"
                )}
              </span>
            </div>
            <div className="approval-wait-line">
              <Link to={`/approvals/${id}`} data-testid="approval-wait-link">
                {approval?.canDecide ? "Decide it" : "See the approval"}
              </Link>
              {approval && (
                <span className="text-meta tabular">
                  {expiresInWords(approval.expiresAt)}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
