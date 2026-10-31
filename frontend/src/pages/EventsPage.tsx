import { useState } from "react";
import { Link } from "react-router-dom";
import { useRead } from "../components/bots/data";
import {
  EVENT_STATUS_FILTERS,
  eventStatusLabel,
  listQuery,
  type TriggerEventRow,
} from "../components/help/model";
import { LoadingLabel } from "../components/LoadingLabel";
import { SkeletonRows } from "../components/SkeletonRows";
import { relativeTime } from "../components/shell/NotificationBell";
import { PageHeader } from "../components/shell/PageHeader";
import { oneLine } from "../components/transcript/model";
import { useAuth } from "../context/AuthContext";
import { useStanding } from "../context/StandingContext";
import { useMay } from "../hooks/useMay";
import { Alert, Chip, Form, Pagination, Table } from "../ui";

/**
 * The log itself, for an admin: every delivery the project's platforms sent,
 * newest first, filtered by status and by outcome.
 * @param props.projectId - The project.
 * @returns The table and its filters.
 */
function EventsLog({ projectId }: { projectId: number }) {
  const [status, setStatus] = useState("");
  const [outcome, setOutcome] = useState("");
  const filterKey = `${status}|${outcome.trim()}`;
  const [chosen, setChosen] = useState({ key: "", page: 1 });
  const page = chosen.key === filterKey ? chosen.page : 1;
  const list = useRead<{
    triggerEvents: TriggerEventRow[];
    pagination: { total: number; pages: number };
  }>(
    `/project/${projectId}/trigger-events${listQuery(
      { status, outcome: outcome.trim() },
      page,
    )}`,
  );
  const pages = list.data?.pagination.pages ?? 0;

  return (
    <div className="events-log" data-testid="events-log">
      <div className="events-filters">
        <div
          className="conversation-filters"
          role="group"
          aria-label="Filter by status"
        >
          {EVENT_STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              className="conversation-filter"
              aria-pressed={status === f.value}
              onClick={() => setStatus(f.value)}
              data-testid={`events-filter-${f.value || "all"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <Form.Control
          size="sm"
          className="settings-input events-outcome"
          placeholder="Outcome, e.g. unbound"
          aria-label="Filter by outcome"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          data-testid="events-outcome"
        />
      </div>
      {list.error && (
        <Alert variant="danger" data-testid="events-error">
          {list.error}
        </Alert>
      )}
      <Table size="sm" className="events-table" data-testid="events-table">
        <thead>
          <tr>
            <th>Received</th>
            <th>Platform</th>
            <th>Status</th>
            <th>Outcome</th>
            <th>Detail</th>
            <th className="tabular">Tries</th>
          </tr>
        </thead>
        <tbody>
          {list.data === null && !list.error && (
            <SkeletonRows rows={4} columns={6} testId="events-skeleton" />
          )}
          {list.data?.triggerEvents.map((e) => (
            <tr
              key={e.id}
              data-testid={`event-row-${e.id}`}
              data-status={e.status}
            >
              <td
                className="tabular"
                title={new Date(e.receivedAt).toLocaleString()}
              >
                {relativeTime(e.receivedAt)}
              </td>
              <td>{e.type}</td>
              <td>
                <Chip>{eventStatusLabel(e.status)}</Chip>
              </td>
              <td className="mono">{e.outcome ?? "—"}</td>
              <td className="events-detail">
                {e.error ? (
                  <span className="events-error">{e.error}</span>
                ) : (
                  e.detail && (
                    <span className="mono">{oneLine(e.detail, 160)}</span>
                  )
                )}
              </td>
              <td className="tabular">{e.attempts}</td>
            </tr>
          ))}
        </tbody>
      </Table>
      {list.data?.triggerEvents.length === 0 && (
        <div className="shell-empty" data-testid="no-events">
          {status || outcome.trim()
            ? "No events match."
            : "No platform has delivered anything yet. Connect one on a bot's page, under Channels."}
        </div>
      )}
      {pages > 1 && (
        <Pagination size="sm" data-testid="events-pages">
          <Pagination.Prev
            disabled={page <= 1}
            onClick={() => setChosen({ key: filterKey, page: page - 1 })}
          />
          <Pagination.Item active>
            {page} of {pages}
          </Pagination.Item>
          <Pagination.Next
            disabled={page >= pages}
            onClick={() => setChosen({ key: filterKey, page: page + 1 })}
          />
        </Pagination>
      )}
    </div>
  );
}

/**
 * `/events` — the active project's platform events: every webhook a platform
 * delivered, what became of it (a message, ignored as unbound, a duplicate…),
 * and why one failed. Admins only, which the page asks `can()` about once
 * `project:view` has answered, so a member sees why rather than a failed
 * request.
 * @returns The page.
 */
export function EventsPage() {
  const { activeProjectId } = useAuth();
  const { projectView } = useStanding();
  const { reason } = useMay();
  const resolved =
    activeProjectId && projectView?.project.id === activeProjectId;
  const denied = resolved ? reason("trigger-event:list") : undefined;

  return (
    <div className="page" data-testid="events-page">
      <PageHeader
        title={
          <>
            {resolved ? projectView.project.name : "Project"}
            <span className="shell-page-subtitle"> · Events</span>
          </>
        }
      />
      {!activeProjectId ? (
        <Alert variant="info" data-testid="no-project">
          Choose a project to read what its platforms delivered.
        </Alert>
      ) : !resolved ? (
        <LoadingLabel testId="events-loading" />
      ) : denied ? (
        <Alert variant="info" data-testid="events-denied">
          {denied} Platform events carry what people wrote in every channel, so
          only admins read them. A bot's conversations are on its page.{" "}
          <Link to="/conversations">Conversations</Link>
        </Alert>
      ) : (
        <EventsLog key={activeProjectId} projectId={activeProjectId} />
      )}
    </div>
  );
}
