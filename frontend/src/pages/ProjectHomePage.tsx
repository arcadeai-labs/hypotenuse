import type { ProjectOverview } from "@backend/actions/project/project-overview";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ListLayout } from "../components/layouts/ListLayout";
import { relativeTime } from "../components/NotificationBell";
import SkeletonBlocks from "../components/SkeletonBlocks";
import { useAuth } from "../context/AuthContext";
import { useLiveChannel, useLiveReconnect } from "../context/LiveSocketContext";
import { useFirstLoad } from "../hooks/useFirstLoad";
import {
  AGENT_SESSION_STATUSES,
  Alert,
  Button,
  Card,
  Chip,
  STATUS_LABELS,
  StatusGlyph,
} from "../ui";
import { apiFetch } from "../utils/client";
import { isRunnersPayload, runnersChannel } from "../utils/runners";
import {
  parseSessionsFrame,
  sessionsChannel,
  waitingLabel,
} from "../utils/sessions";

type Overview = ActionResponse<ProjectOverview>["overview"];

/** The windows the home page counts over. */
const WINDOWS = ["24h", "7d"] as const;

/**
 * A duration in ms as a person reads it.
 * @param ms - The duration, or null.
 * @returns e.g. `3.2s`, `4m`, or `—`.
 */
export function formatMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

/**
 * `/home` — the project at a glance, from one `project:overview` read: is
 * Linear connected and delivering, how many runners are online and how busy,
 * what sessions did in the window (with the median time to acknowledge,
 * which must stay under ten seconds), and what is queued right now and why.
 * Live on both dashboard channels.
 * @returns The page.
 */
export default function ProjectHomePage() {
  const { activeProjectId } = useAuth();
  const [span, setSpan] = useState<(typeof WINDOWS)[number]>("24h");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { loading, begin, done } = useFirstLoad();

  const load = useCallback(
    async (userInitiated = true) => {
      if (!activeProjectId) return;
      begin(userInitiated);
      try {
        const res = await apiFetch<ActionResponse<ProjectOverview>>(
          `/project/overview?projectId=${activeProjectId}&window=${span}`,
        );
        setOverview(res.overview);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not load the overview.",
        );
      } finally {
        done();
      }
    },
    [activeProjectId, span, begin, done],
  );

  useEffect(() => {
    load();
  }, [load]);
  useLiveChannel(
    activeProjectId ? sessionsChannel(activeProjectId) : null,
    (payload) => {
      if (parseSessionsFrame(payload)) void load(false);
    },
  );
  useLiveChannel(
    activeProjectId ? runnersChannel(activeProjectId) : null,
    (payload) => {
      if (isRunnersPayload(payload)) void load(false);
    },
  );
  useLiveReconnect(() => {
    void load(false);
  });

  if (!activeProjectId) {
    return (
      <ListLayout title="Home">
        <Alert variant="info" data-testid="no-project">
          Select or create a project to see it here.
        </Alert>
      </ListLayout>
    );
  }

  return (
    <ListLayout
      title="Home"
      actions={
        <div className="home-window" role="group" aria-label="Window">
          {WINDOWS.map((w) => (
            <Button
              key={w}
              size="sm"
              variant={w === span ? "secondary" : "outline-secondary"}
              aria-pressed={w === span}
              onClick={() => setSpan(w)}
              data-testid={`home-window-${w}`}
            >
              {w}
            </Button>
          ))}
        </div>
      }
    >
      {error && (
        <Alert variant="danger" data-testid="home-error">
          {error}
        </Alert>
      )}
      {loading || !overview ? (
        loading && (
          <SkeletonBlocks
            count={4}
            testId="home-loading"
            label="Loading the overview"
          />
        )
      ) : (
        <div className="home-cards" data-testid="home-cards">
          <LinearCard linear={overview.linear} />
          <Card data-testid="home-runners">
            <Card.Header as="h2">Runners</Card.Header>
            <Card.Body>
              <dl className="home-stats">
                <Stat
                  label="Online"
                  value={overview.runners.online}
                  testId="home-runners-online"
                />
                <Stat label="Draining" value={overview.runners.draining} />
                <Stat label="Offline" value={overview.runners.offline} />
                <Stat
                  label="Slots in use"
                  value={`${overview.runners.used}/${overview.runners.total}`}
                  testId="home-runners-capacity"
                />
              </dl>
              <p className="text-meta mb-0">
                Oldest heartbeat:{" "}
                {overview.runners.oldestHeartbeatAt === null
                  ? "—"
                  : relativeTime(overview.runners.oldestHeartbeatAt)}{" "}
                · <Link to="/runners">Runners</Link>
              </p>
            </Card.Body>
          </Card>
          <Card data-testid="home-sessions">
            <Card.Header as="h2">Sessions · {overview.window}</Card.Header>
            <Card.Body>
              <dl className="home-stats">
                <Stat
                  label="Started"
                  value={overview.sessions.total}
                  testId="home-sessions-total"
                />
                <Stat
                  label="Median acknowledgement"
                  value={formatMs(overview.sessions.medianAckMs)}
                  testId="home-ack"
                />
                <Stat
                  label="Median time to claim"
                  value={formatMs(overview.sessions.medianClaimMs)}
                />
              </dl>
              <div className="home-chips">
                {AGENT_SESSION_STATUSES.filter(
                  (s) => overview.sessions.byStatus[s] > 0,
                ).map((s) => (
                  <Link
                    key={s}
                    to={`/sessions?status=${s}`}
                    className="home-chip-link"
                  >
                    <Chip icon={<StatusGlyph status={s} />}>
                      {STATUS_LABELS[s]} {overview.sessions.byStatus[s]}
                    </Chip>
                  </Link>
                ))}
                <Chip>Workers {overview.sessions.byRole.worker}</Chip>
                <Chip>Managers {overview.sessions.byRole.manager}</Chip>
              </div>
            </Card.Body>
          </Card>
          <Card data-testid="home-queue">
            <Card.Header as="h2">Queue</Card.Header>
            <Card.Body>
              {overview.queue.items.length === 0 ? (
                <p className="text-muted mb-0" data-testid="home-queue-empty">
                  Nothing is waiting for a runner.
                </p>
              ) : (
                <ul className="home-queue">
                  {overview.queue.items.map((item) => (
                    <li
                      key={item.workItemId}
                      data-testid={`home-queue-${item.workItemId}`}
                    >
                      <Link to={`/sessions/${item.agentSessionId}`}>
                        {item.issueIdentifier ?? `#${item.agentSessionId}`}
                      </Link>{" "}
                      <Chip>{item.status}</Chip>{" "}
                      <span>
                        {waitingLabel(item.waitingCode) ??
                          item.waitingReason ??
                          "Being placed"}
                      </span>{" "}
                      <span className="text-meta tabular">
                        {formatMs(item.ageMs)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-meta mb-0">
                Expired in the last {overview.window}: {overview.queue.expired}
              </p>
            </Card.Body>
          </Card>
        </div>
      )}
    </ListLayout>
  );
}

/**
 * The Linear card: connected workspace, status, last webhook, failures.
 * @param props - The card's slice of the overview.
 * @returns The card.
 */
function LinearCard({ linear }: { linear: Overview["linear"] }) {
  return (
    <Card data-testid="home-linear">
      <Card.Header as="h2">Linear</Card.Header>
      <Card.Body>
        {linear === null ? (
          <p className="mb-0" data-testid="home-linear-disconnected">
            Not connected.{" "}
            <Link to="/settings/integrations">Connect Linear</Link> so
            delegations reach your runners.
          </p>
        ) : (
          <>
            <p className="mb-2">
              <strong>{linear.workspaceName}</strong>{" "}
              <Chip data-testid="home-linear-status">{linear.status}</Chip>
            </p>
            <dl className="home-stats">
              <Stat
                label="Last webhook"
                value={
                  linear.lastWebhookAt === null
                    ? "never"
                    : relativeTime(linear.lastWebhookAt)
                }
              />
              <Stat label="Failed deliveries" value={linear.failedDeliveries} />
            </dl>
          </>
        )}
      </Card.Body>
    </Card>
  );
}

/**
 * One number with its label.
 * @param props - The label, the value, and an optional test id.
 * @returns The term and its value.
 */
function Stat({
  label,
  value,
  testId,
}: {
  label: string;
  value: string | number;
  testId?: string;
}) {
  return (
    <div className="home-stat">
      <dt className="text-meta">{label}</dt>
      <dd className="tabular" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
