import type { AgentSessionList } from "@backend/actions/agent-session/agent-session-list";
import type { RunnerList } from "@backend/actions/runner/runner-list";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ListLayout } from "../components/layouts/ListLayout";
import { relativeTime } from "../components/NotificationBell";
import SkeletonBlocks from "../components/SkeletonBlocks";
import { useAuth } from "../context/AuthContext";
import { useLiveChannel, useLiveReconnect } from "../context/LiveSocketContext";
import { useFirstLoad } from "../hooks/useFirstLoad";
import {
  AGENT_SESSION_STATUSES,
  Alert,
  Form,
  ListGroup,
  ListRow,
  Pagination,
  RoleChip,
  STATUS_LABELS,
  StatusGlyph,
} from "../ui";
import { apiFetch } from "../utils/client";
import type { ListedRunner } from "../utils/runners";
import {
  glyphStatus,
  type ListedSession,
  parseSessionsFrame,
  sessionsChannel,
} from "../utils/sessions";

/** Sessions per page. */
const PAGE_SIZE = 25;

/**
 * `/sessions` — every agent session of the project, newest first, filtered by
 * status, role, runner, or issue, and paginated. Filters live in the URL, so a
 * filtered list is a link. Live: any frame on `project:<id>:sessions`
 * re-reads the page on screen.
 * @returns The page.
 */
export default function SessionsPage() {
  const { activeProjectId } = useAuth();
  const [params, setParams] = useSearchParams();
  const [sessions, setSessions] = useState<ListedSession[]>([]);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [runners, setRunners] = useState<ListedRunner[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { loading, begin, done } = useFirstLoad();
  const sequence = useRef(0);

  const status = params.get("status") ?? "";
  const role = params.get("role") ?? "";
  const runnerId = params.get("runnerId") ?? "";
  const issue = params.get("issue") ?? "";
  const page = Math.max(1, Number(params.get("page")) || 1);

  const load = useCallback(
    async (userInitiated = true) => {
      if (!activeProjectId) return;
      const mine = ++sequence.current;
      begin(userInitiated);
      const query = new URLSearchParams({
        projectId: String(activeProjectId),
        page: String(page),
        limit: String(PAGE_SIZE),
      });
      if (status) query.set("status", status);
      if (role) query.set("role", role);
      if (runnerId) query.set("runnerId", runnerId);
      if (issue) query.set("issueIdentifier", issue);
      try {
        const res = await apiFetch<ActionResponse<AgentSessionList>>(
          `/agent-sessions?${query}`,
        );
        if (mine !== sequence.current) return;
        setSessions(res.agentSessions);
        setPages(Math.max(1, res.pagination.pages));
        setTotal(res.pagination.total);
        setError(null);
      } catch (err) {
        if (mine !== sequence.current) return;
        setError(
          err instanceof Error ? err.message : "Could not load sessions.",
        );
      } finally {
        if (mine === sequence.current) done();
      }
    },
    [activeProjectId, page, status, role, runnerId, issue, begin, done],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!activeProjectId) return;
    apiFetch<ActionResponse<RunnerList>>(
      `/runners?projectId=${activeProjectId}&limit=100`,
    )
      .then((res) => setRunners(res.runners))
      .catch(() => {
        // The runner filter is optional; the list still works without it.
      });
  }, [activeProjectId]);

  useLiveChannel(
    activeProjectId ? sessionsChannel(activeProjectId) : null,
    (payload) => {
      if (parseSessionsFrame(payload)) void load(false);
    },
  );
  useLiveReconnect(() => {
    void load(false);
  });

  /**
   * Set one filter (an empty value clears it) and go back to page one.
   * @param key - The query key.
   * @param value - Its value.
   */
  function setFilter(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== "page") next.delete("page");
    setParams(next);
  }

  if (!activeProjectId) {
    return (
      <ListLayout title="Sessions">
        <Alert variant="info" data-testid="no-project">
          Select or create a project to see its sessions.
        </Alert>
      </ListLayout>
    );
  }

  return (
    <ListLayout
      title="Sessions"
      searchPlaceholder="Issue, e.g. ENG-123"
      onSearch={(q) => setFilter("issue", q.trim().toUpperCase())}
      filters={
        <div className="session-filters" data-testid="session-filters">
          <Form.Select
            size="sm"
            aria-label="Status"
            value={status}
            onChange={(e) => setFilter("status", e.target.value)}
            data-testid="filter-status"
          >
            <option value="">Any status</option>
            {AGENT_SESSION_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABELS[s]}
              </option>
            ))}
          </Form.Select>
          <Form.Select
            size="sm"
            aria-label="Role"
            value={role}
            onChange={(e) => setFilter("role", e.target.value)}
            data-testid="filter-role"
          >
            <option value="">Any role</option>
            <option value="worker">Worker</option>
            <option value="manager">Manager</option>
          </Form.Select>
          <Form.Select
            size="sm"
            aria-label="Runner"
            value={runnerId}
            onChange={(e) => setFilter("runnerId", e.target.value)}
            data-testid="filter-runner"
          >
            <option value="">Any runner</option>
            {runners.map((r) => (
              <option key={r.id} value={String(r.id)}>
                {r.name}
              </option>
            ))}
          </Form.Select>
        </div>
      }
    >
      {error && (
        <Alert
          variant="danger"
          dismissible
          onClose={() => setError(null)}
          data-testid="sessions-error"
        >
          {error}
        </Alert>
      )}
      {loading ? (
        <SkeletonBlocks
          count={4}
          testId="sessions-loading"
          label="Loading sessions"
        />
      ) : sessions.length === 0 ? (
        <p className="text-muted shell-empty" data-testid="sessions-empty">
          {status || role || runnerId || issue
            ? "No session matches these filters."
            : "No sessions yet. Delegate an issue to @hypotenuse in Linear, or mention it in a comment."}
        </p>
      ) : (
        <ListGroup title="Sessions" count={total} data-testid="sessions-list">
          {sessions.map((s) => (
            <ListRow
              key={s.id}
              as={Link}
              to={`/sessions/${s.id}`}
              data-testid={`session-row-${s.id}`}
              glyph={<StatusGlyph status={glyphStatus(s.status)} />}
              identifier={s.issueIdentifier ?? `#${s.id}`}
              title={s.issueTitle ?? "Untitled issue"}
              trailing={
                <>
                  {s.role && <RoleChip role={s.role} />}
                  <span className="text-meta">{s.origin}</span>
                  <span className="text-meta tabular">
                    {relativeTime(s.createdAt)}
                  </span>
                </>
              }
            />
          ))}
        </ListGroup>
      )}
      {pages > 1 && (
        <Pagination size="sm" data-testid="sessions-pages">
          <Pagination.Prev
            disabled={page <= 1}
            onClick={() => setFilter("page", String(page - 1))}
          />
          <Pagination.Item disabled>
            {page} / {pages}
          </Pagination.Item>
          <Pagination.Next
            disabled={page >= pages}
            onClick={() => setFilter("page", String(page + 1))}
          />
        </Pagination>
      )}
    </ListLayout>
  );
}
