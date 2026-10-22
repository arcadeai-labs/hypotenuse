import type { TriggerEventList } from "@backend/actions/trigger-event/trigger-event-list";
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
  Alert,
  Form,
  ListGroup,
  ListRow,
  Pagination,
  RoleChip,
  StatusGlyph,
} from "../ui";
import { apiFetch } from "../utils/client";
import {
  EVENT_OUTCOMES,
  EVENT_TYPES,
  eventsChannel,
  isEventsPayload,
  type ListedEvent,
  OUTCOME_LABELS,
  outcomeGlyph,
  placement,
  roleReason,
} from "../utils/events";
import { parseSessionsFrame, sessionsChannel } from "../utils/sessions";

/** Events per page. */
const PAGE_SIZE = 25;

/**
 * `/events` — every webhook the project's Linear workspace sent, newest
 * first: what each did, and for the ones that touched work, the role it was
 * routed as (and the rule that chose it) and where its turn is now. Filters
 * live in the URL; ignored events are hidden unless asked for. Live: a frame
 * on `project:<id>:events` or `project:<id>:sessions` re-reads the page.
 * @returns The page.
 */
export default function EventsPage() {
  const { activeProjectId } = useAuth();
  const [params, setParams] = useSearchParams();
  const [events, setEvents] = useState<ListedEvent[]>([]);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { loading, begin, done } = useFirstLoad();
  const sequence = useRef(0);

  const eventType = params.get("eventType") ?? "";
  const outcome = params.get("outcome") ?? "";
  const showIgnored = params.get("ignored") === "1";
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
      if (eventType) query.set("eventType", eventType);
      if (outcome) query.set("outcome", outcome);
      else if (!showIgnored) query.set("hideIgnored", "true");
      try {
        const res = await apiFetch<ActionResponse<TriggerEventList>>(
          `/trigger-events?${query}`,
        );
        if (mine !== sequence.current) return;
        setEvents(res.triggerEvents);
        setPages(Math.max(1, res.pagination.pages));
        setTotal(res.pagination.total);
        setError(null);
      } catch (err) {
        if (mine !== sequence.current) return;
        setError(err instanceof Error ? err.message : "Could not load events.");
      } finally {
        if (mine === sequence.current) done();
      }
    },
    [activeProjectId, page, eventType, outcome, showIgnored, begin, done],
  );

  useEffect(() => {
    load();
  }, [load]);

  useLiveChannel(
    activeProjectId ? eventsChannel(activeProjectId) : null,
    (payload) => {
      if (isEventsPayload(payload)) void load(false);
    },
  );
  // A turn's placement changes on the sessions channel, not this one.
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
      <ListLayout title="Events">
        <Alert variant="info" data-testid="no-project">
          Select or create a project to see its events.
        </Alert>
      </ListLayout>
    );
  }

  return (
    <ListLayout
      title="Events"
      filters={
        <div className="session-filters" data-testid="event-filters">
          <Form.Select
            size="sm"
            aria-label="Event type"
            value={eventType}
            onChange={(e) => setFilter("eventType", e.target.value)}
            data-testid="filter-event-type"
          >
            <option value="">Any event</option>
            {EVENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </Form.Select>
          <Form.Select
            size="sm"
            aria-label="Outcome"
            value={outcome}
            onChange={(e) => setFilter("outcome", e.target.value)}
            data-testid="filter-outcome"
          >
            <option value="">Any outcome</option>
            {EVENT_OUTCOMES.map((o) => (
              <option key={o} value={o}>
                {OUTCOME_LABELS[o]}
              </option>
            ))}
          </Form.Select>
          <Form.Check
            type="switch"
            id="events-show-ignored"
            label="Show ignored"
            checked={showIgnored || outcome === "ignored"}
            disabled={outcome !== ""}
            onChange={(e) => setFilter("ignored", e.target.checked ? "1" : "")}
            data-testid="filter-show-ignored"
          />
        </div>
      }
    >
      {error && (
        <Alert
          variant="danger"
          dismissible
          onClose={() => setError(null)}
          data-testid="events-error"
        >
          {error}
        </Alert>
      )}
      {loading ? (
        <SkeletonBlocks
          count={4}
          testId="events-loading"
          label="Loading events"
        />
      ) : events.length === 0 ? (
        <p className="text-muted shell-empty" data-testid="events-empty">
          {eventType || outcome
            ? "No event matches these filters."
            : "No events yet. Linear's webhooks for this workspace appear here as they arrive."}
        </p>
      ) : (
        <ListGroup title="Events" count={total} data-testid="events-list">
          {events.map((e) => {
            const reason = roleReason(e);
            const where = placement(e);
            return (
              <ListRow
                key={e.id}
                as={Link}
                to={`/events/${e.id}`}
                data-testid={`event-row-${e.id}`}
                glyph={<StatusGlyph status={outcomeGlyph(e.outcome)} />}
                identifier={e.issueIdentifier ?? `${e.eventType}`}
                title={e.summary ?? `${e.eventType} ${e.action}`}
                trailing={
                  <>
                    {e.session?.role && <RoleChip role={e.session.role} />}
                    {reason && <span className="text-meta">{reason}</span>}
                    {where && (
                      <span
                        className="text-meta"
                        data-testid={`event-placement-${e.id}`}
                      >
                        {where}
                      </span>
                    )}
                    <span className="text-meta">
                      {e.eventType} · {e.action}
                    </span>
                    <span className="text-meta tabular">
                      {relativeTime(e.receivedAt)}
                    </span>
                  </>
                }
              />
            );
          })}
        </ListGroup>
      )}
      {pages > 1 && (
        <Pagination size="sm" data-testid="events-pages">
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
