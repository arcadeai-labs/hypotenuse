import type { TriggerEventView } from "@backend/actions/trigger-event/trigger-event-view";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import JsonBlock from "../components/JsonBlock";
import { DetailLayout } from "../components/layouts/DetailLayout";
import SkeletonBlocks from "../components/SkeletonBlocks";
import { useAuth } from "../context/AuthContext";
import { useLiveChannel, useLiveReconnect } from "../context/LiveSocketContext";
import { useFirstLoad } from "../hooks/useFirstLoad";
import {
  Alert,
  Card,
  PropertiesPanel,
  Property,
  RoleChip,
  StatusGlyph,
} from "../ui";
import { apiFetch } from "../utils/client";
import {
  eventsChannel,
  isEventsPayload,
  OUTCOME_LABELS,
  outcomeGlyph,
  placement,
  roleReason,
} from "../utils/events";
import { parseSessionsFrame, sessionsChannel } from "../utils/sessions";

type View = ActionResponse<TriggerEventView>;

/**
 * `/events/:id` — one webhook delivery: what it did, and — beside it — the
 * session and turn it touched, the role it was routed as and why, and where
 * the turn is now; for a project admin, the body Linear sent. Live, like the
 * list.
 * @returns The page.
 */
export default function EventPage() {
  const { id: rawId } = useParams();
  const id = Number(rawId);
  const { activeProjectId } = useAuth();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { loading, begin, done } = useFirstLoad();

  const load = useCallback(
    async (userInitiated = true) => {
      if (!activeProjectId || !Number.isSafeInteger(id)) return;
      begin(userInitiated);
      try {
        setView(
          await apiFetch<View>(
            `/trigger-event/${id}?projectId=${activeProjectId}`,
          ),
        );
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not load the event.",
        );
      } finally {
        done();
      }
    },
    [activeProjectId, id, begin, done],
  );

  useEffect(() => {
    setView(null);
    load();
  }, [load]);

  useLiveChannel(
    activeProjectId ? eventsChannel(activeProjectId) : null,
    (payload) => {
      if (isEventsPayload(payload)) void load(false);
    },
  );
  useLiveChannel(
    activeProjectId ? sessionsChannel(activeProjectId) : null,
    (payload) => {
      if (parseSessionsFrame(payload)) void load(false);
    },
  );
  useLiveReconnect(() => {
    void load(false);
  });

  if (!activeProjectId) {
    return (
      <DetailLayout title="Event">
        <Alert variant="info" data-testid="no-project">
          Select or create a project to see its events.
        </Alert>
      </DetailLayout>
    );
  }

  if (loading) {
    return (
      <DetailLayout title="Event">
        <SkeletonBlocks count={3} testId="event-loading" />
      </DetailLayout>
    );
  }

  if (!view) {
    return (
      <DetailLayout title="Event">
        <Alert variant="danger" data-testid="event-error">
          {error ?? "This event could not be found."}
        </Alert>
        <Link to="/events">Back to events</Link>
      </DetailLayout>
    );
  }

  const e = view.triggerEvent;
  const reason = roleReason(e);
  const where = placement(e);

  return (
    <DetailLayout
      title={
        <span data-testid="event-title">
          <StatusGlyph status={outcomeGlyph(e.outcome)} />{" "}
          {e.issueIdentifier && (
            <span className="text-secondary">{e.issueIdentifier} · </span>
          )}
          {e.eventType} · {e.action}
        </span>
      }
      properties={
        <PropertiesPanel data-testid="event-properties">
          <Property label="Outcome" data-testid="event-outcome">
            <StatusGlyph status={outcomeGlyph(e.outcome)} label={null} />{" "}
            {OUTCOME_LABELS[e.outcome]}
          </Property>
          {e.session && (
            <Property label="Role" data-testid="event-role">
              {e.session.role ? (
                <>
                  <RoleChip role={e.session.role} showLabel />
                  {reason && <span className="text-muted"> · {reason}</span>}
                </>
              ) : (
                <span className="text-muted">Not routed yet</span>
              )}
            </Property>
          )}
          {e.session && (
            <Property label="Turn" data-testid="event-turn">
              {where ?? <span className="text-muted">None queued</span>}
            </Property>
          )}
          {e.turn?.repository && (
            <Property label="Repository">
              <code>{e.turn.repository}</code>
            </Property>
          )}
          <Property label="Received">
            {new Date(e.receivedAt).toLocaleString()}
          </Property>
          <Property label="Processed">
            {e.processedAt ? (
              new Date(e.processedAt).toLocaleString()
            ) : (
              <span className="text-muted">Not yet</span>
            )}
          </Property>
          <Property label="Delivery">
            <code>{e.deliveryId}</code>
          </Property>
          {e.session && (
            <Property label="Session" data-testid="event-session">
              <Link to={`/sessions/${e.session.id}`}>
                {e.issueIdentifier ?? `#${e.session.id}`}
              </Link>
            </Property>
          )}
        </PropertiesPanel>
      }
    >
      {error && (
        <Alert variant="danger" data-testid="event-error">
          {error}
        </Alert>
      )}
      <Card className="mb-4" data-testid="event-summary">
        <Card.Header as="h2">What it did</Card.Header>
        <Card.Body>
          <p className="mb-0">{e.summary ?? "Not processed yet."}</p>
          {e.error && (
            <Alert
              variant="danger"
              className="mt-3 mb-0"
              data-testid="event-failure"
            >
              {e.error}
            </Alert>
          )}
        </Card.Body>
      </Card>
      <Card data-testid="event-payload">
        <Card.Header as="h2">Payload</Card.Header>
        <Card.Body>
          {view.payload ? (
            <JsonBlock value={view.payload} testId="event-payload-json" />
          ) : (
            <p className="text-muted mb-0" data-testid="event-payload-hidden">
              Only project admins see the body Linear sent: it can carry issues
              @hypotenuse does not work on.
            </p>
          )}
        </Card.Body>
      </Card>
    </DetailLayout>
  );
}
