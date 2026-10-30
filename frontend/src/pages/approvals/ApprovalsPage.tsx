import { useState } from "react";
import { Link } from "react-router-dom";
import { useRead } from "../../components/bots/data";
import { ListLayout } from "../../components/layouts/ListLayout";
import { ApprovalStatusGlyph } from "../../components/mcp/ApprovalStatusGlyph";
import type { ApprovalRow } from "../../components/mcp/data";
import { SkeletonBlocks } from "../../components/SkeletonBlocks";
import { relativeTime } from "../../components/shell/NotificationBell";
import { useAuth } from "../../context/AuthContext";
import {
  Alert,
  BotBadge,
  Chip,
  ListGroup,
  ListRow,
  Pagination,
} from "../../ui";
import {
  approvalStatusLabel,
  approvalsQuery,
  expiresInWords,
} from "../../utils/mcp";

/** The status filters, in the order the chips are drawn. Pending is the inbox. */
const STATUS_FILTERS = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "consumed", label: "Ran" },
  { value: "denied", label: "Denied" },
  { value: "expired", label: "Expired" },
  { value: "", label: "All" },
] as const;

/**
 * `/approvals` — the project's tool calls waiting for a person, for the bots
 * the reader may read, newest first: the bot (always visibly a bot), the
 * call as `server/tool`, and when it expires. Chips show the decided ones
 * too. A row opens the approval, where it is decided.
 * @returns The page.
 */
export function ApprovalsPage() {
  const { activeProjectId, activeOrganizationId } = useAuth();
  const [status, setStatus] = useState<string>("pending");
  const [chosen, setChosen] = useState({ key: "", page: 1 });
  const page = chosen.key === status ? chosen.page : 1;
  const list = useRead<{
    approvals: ApprovalRow[];
    pagination: { total: number; pages: number };
  }>(
    activeProjectId === null
      ? null
      : `/project/${activeProjectId}/approvals${approvalsQuery(status, page)}`,
  );
  const pages = list.data?.pagination.pages ?? 0;

  return (
    <ListLayout
      title="Approvals"
      filters={
        <div
          className="conversation-filters"
          role="group"
          aria-label="Filter by status"
        >
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className="conversation-filter"
              aria-pressed={status === f.value}
              onClick={() => setStatus(f.value)}
              data-testid={`approval-filter-${f.value || "all"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      }
    >
      <div
        className="conversations-page approvals-page"
        data-testid="approvals-page"
      >
        {!activeProjectId ? (
          <Alert variant="info" data-testid="no-project">
            {activeOrganizationId ? (
              <>
                This organization shows you no projects yet. See the{" "}
                <Link to="/organization/projects">organization's projects</Link>
                .
              </>
            ) : (
              "Choose an organization, then a project, to see its approvals."
            )}
          </Alert>
        ) : (
          <>
            {list.error && (
              <Alert variant="danger" data-testid="approvals-error">
                {list.error}
              </Alert>
            )}
            {list.data === null && !list.error && (
              <SkeletonBlocks
                count={3}
                testId="approvals-skeleton"
                label="Loading approvals"
              />
            )}
            {list.data?.approvals.length === 0 && (
              <div className="shell-empty" data-testid="no-approvals">
                {status === "pending"
                  ? "Nothing is waiting for approval. A bot's call that no allowlist pattern allows lands here."
                  : "No approvals in this state."}
              </div>
            )}
            {list.data && list.data.approvals.length > 0 && (
              <ListGroup
                title={
                  status === "pending"
                    ? "Waiting for a decision"
                    : status
                      ? approvalStatusLabel(status)
                      : "Approvals"
                }
                count={list.data.pagination.total}
                data-testid="approval-list"
              >
                {list.data.approvals.map((a) => (
                  <ListRow
                    key={a.id}
                    as={Link}
                    to={`/approvals/${a.id}`}
                    data-testid={`approval-row-${a.id}`}
                    data-status={a.status}
                    glyph={<ApprovalStatusGlyph status={a.status} />}
                    identifier={`#${a.id}`}
                    title={<span className="mono">{a.name}</span>}
                    trailing={
                      <>
                        {a.status === "pending" ? (
                          <span className="text-meta tabular">
                            {expiresInWords(a.expiresAt)}
                          </span>
                        ) : (
                          <Chip>{approvalStatusLabel(a.status)}</Chip>
                        )}
                        <BotBadge name={a.botName} />
                        <span
                          className="conversation-activity tabular"
                          title={new Date(a.createdAt).toLocaleString()}
                        >
                          {relativeTime(a.createdAt)}
                        </span>
                      </>
                    }
                  />
                ))}
              </ListGroup>
            )}
            {pages > 1 && (
              <Pagination size="sm" data-testid="approvals-pages">
                <Pagination.Prev
                  disabled={page <= 1}
                  onClick={() => setChosen({ key: status, page: page - 1 })}
                />
                <Pagination.Item active>
                  {page} of {pages}
                </Pagination.Item>
                <Pagination.Next
                  disabled={page >= pages}
                  onClick={() => setChosen({ key: status, page: page + 1 })}
                />
              </Pagination>
            )}
          </>
        )}
      </div>
    </ListLayout>
  );
}
