import type { AgentSessionActivities } from "@backend/actions/agent-session/agent-session-activities";
import type { AgentSessionView } from "@backend/actions/agent-session/agent-session-view";
import type { ActionResponse } from "keryx";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { DetailLayout } from "../components/layouts/DetailLayout";
import SkeletonBlocks from "../components/SkeletonBlocks";
import { ActivityTranscript } from "../components/session/ActivityTranscript";
import type { PlanStep } from "../components/session/PlanChecklist";
import { WorkItemTimeline } from "../components/session/WorkItemTimeline";
import { useAuth } from "../context/AuthContext";
import { useLiveChannel, useLiveReconnect } from "../context/LiveSocketContext";
import { useDisplayClock } from "../hooks/useDisplayClock";
import { useFirstLoad } from "../hooks/useFirstLoad";
import { useMay } from "../hooks/useMay";
import {
  Alert,
  Button,
  Chip,
  Modal,
  PresenceDot,
  PropertiesPanel,
  Property,
  RoleChip,
  STATUS_LABELS,
  StatusGlyph,
} from "../ui";
import { apiFetch } from "../utils/client";
import { isRunnersPayload, presenceOf, runnersChannel } from "../utils/runners";
import {
  frameTouches,
  glyphStatus,
  parseSessionsFrame,
  sessionsChannel,
} from "../utils/sessions";
import {
  canCancelSession,
  groupByTurn,
  LIVE_TURN_STATUSES,
  mergeActivities,
  orderLinks,
  planTurnIndex,
  type TranscriptActivity,
  transcriptEntries,
} from "../utils/transcript";

type View = ActionResponse<AgentSessionView>;

/** How many activities one read asks for. */
const PAGE = 100;

/**
 * `/sessions/:id` — the one place all of a session's histories meet: the
 * mirrored transcript, the plan, the links, and the turns behind them, with
 * the runner, the owner, the issuer, and the dispatch tree in the properties
 * panel. Live: a frame naming this session (or the list) re-reads it, and a
 * runners frame re-reads the runner badge. Cancel stops it as Linear's Stop
 * does and is disabled, not hidden, when there is nothing to stop.
 * @returns The page.
 */
export default function SessionPage() {
  const { id: rawId } = useParams();
  const id = Number(rawId);
  const { activeProjectId } = useAuth();
  const { may } = useMay();
  const [search, setSearch] = useSearchParams();
  const [view, setView] = useState<View | null>(null);
  const [activities, setActivities] = useState<TranscriptActivity[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const { loading, begin, done } = useFirstLoad();
  const activitiesRef = useRef<TranscriptActivity[]>([]);
  activitiesRef.current = activities;

  /** Read the view, then drain the activities since the oldest unsettled one. */
  const load = useCallback(
    async (userInitiated = true) => {
      if (!activeProjectId || !Number.isSafeInteger(id)) return;
      begin(userInitiated);
      try {
        const next = await apiFetch<View>(
          `/agent-session/${id}?projectId=${activeProjectId}`,
        );
        // A pending row can still be sent, fail, or be superseded: re-read
        // from just before the oldest one; otherwise only what is new.
        const held = activitiesRef.current;
        const pending = held.filter((a) => a.deliveryStatus === "pending");
        let afterSeq =
          pending.length > 0
            ? Math.min(...pending.map((a) => a.seq)) - 1
            : held.reduce((max, a) => Math.max(max, a.seq), 0);
        let merged = held;
        for (;;) {
          const page = await apiFetch<ActionResponse<AgentSessionActivities>>(
            `/agent-session/${id}/activities?projectId=${activeProjectId}&afterSeq=${afterSeq}&limit=${PAGE}`,
          );
          merged = mergeActivities(merged, page.activities);
          if (page.activities.length < PAGE) break;
          afterSeq = page.activities[page.activities.length - 1].seq;
        }
        setView(next);
        setActivities(merged);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not load the session.",
        );
      } finally {
        done();
      }
    },
    [activeProjectId, id, begin, done],
  );

  useEffect(() => {
    activitiesRef.current = [];
    setActivities([]);
    setView(null);
    load();
  }, [load]);

  useLiveChannel(
    activeProjectId ? sessionsChannel(activeProjectId) : null,
    (payload) => {
      const frame = parseSessionsFrame(payload);
      if (frame && frameTouches(frame, id)) void load(false);
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

  // The command palette's "Cancel session" lands here with `?cancel=1`.
  useEffect(() => {
    if (search.get("cancel") === "1") {
      setConfirming(true);
      const rest = new URLSearchParams(search);
      rest.delete("cancel");
      setSearch(rest, { replace: true });
    }
  }, [search, setSearch]);

  const turns = view?.workItems ?? [];
  const live = turns.some((t) => LIVE_TURN_STATUSES.has(t.status));
  const now = useDisplayClock(live);
  const groups = useMemo(
    () => groupByTurn(transcriptEntries(activities), turns),
    [activities, turns],
  );
  const planIndex = useMemo(
    () => planTurnIndex(activities, groups),
    [activities, groups],
  );

  // It follows: stick to the bottom while the reader is there.
  const atBottom = useRef(true);
  useEffect(() => {
    const onScroll = () => {
      atBottom.current =
        window.innerHeight + window.scrollY >= document.body.scrollHeight - 40;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useLayoutEffect(() => {
    if (activities.length > 0 && atBottom.current) {
      document
        .querySelector('[data-testid="transcript-end"]')
        ?.scrollIntoView({ block: "end" });
    }
  }, [activities]);

  /** Cancel the session's work, then re-read. */
  async function cancel() {
    if (!activeProjectId) return;
    setConfirming(false);
    setBusy(true);
    try {
      await apiFetch(`/agent-session/${id}/cancel`, {
        method: "POST",
        body: JSON.stringify({ projectId: activeProjectId }),
      });
      setNotice(
        "Asked the session to stop. Linear will show where it was left.",
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel.");
    } finally {
      setBusy(false);
    }
  }

  if (!activeProjectId) {
    return (
      <DetailLayout title="Session">
        <Alert variant="info" data-testid="no-project">
          Select or create a project to see its sessions.
        </Alert>
      </DetailLayout>
    );
  }

  if (loading) {
    return (
      <DetailLayout title="Session">
        <SkeletonBlocks count={4} testId="session-loading" />
      </DetailLayout>
    );
  }

  if (!view) {
    return (
      <DetailLayout title="Session">
        <Alert variant="danger" data-testid="session-error">
          {error ?? "This session could not be found."}
        </Alert>
        <Link to="/sessions">Back to sessions</Link>
      </DetailLayout>
    );
  }

  const s = view.agentSession;
  const status = glyphStatus(s.status);
  const cancellable = canCancelSession(s.status, turns);
  const mayCancel = may("agent-session:cancel");
  const links = orderLinks(s.externalUrls);

  return (
    <DetailLayout
      title={
        <span data-testid="session-title">
          <StatusGlyph status={status} />{" "}
          {s.issueIdentifier && (
            <span className="text-secondary">{s.issueIdentifier} · </span>
          )}
          {s.issueTitle ?? "Untitled issue"}
        </span>
      }
      actions={
        mayCancel && (
          <Button
            size="sm"
            variant="outline-danger"
            disabled={!cancellable || busy}
            title={cancellable ? undefined : "Nothing is running or waiting"}
            onClick={() => setConfirming(true)}
            data-testid="session-cancel"
          >
            Cancel
          </Button>
        )
      }
      properties={
        <PropertiesPanel data-testid="session-properties">
          <Property label="Status" data-testid="session-status">
            <StatusGlyph status={status} label={null} /> {STATUS_LABELS[status]}
          </Property>
          <Property label="Role">
            {s.role ? <RoleChip role={s.role} showLabel /> : "Not routed yet"}
          </Property>
          <Property label="Runner" data-testid="session-runner">
            {view.runner ? (
              <>
                <PresenceDot presence={presenceOf(view.runner.status)} />{" "}
                {view.runner.name}
              </>
            ) : (
              <span className="text-muted">None yet</span>
            )}
          </Property>
          <Property label="Owner">
            {view.runner?.owner?.name ?? <span className="text-muted">—</span>}
          </Property>
          <Property label="Issuer" data-testid="session-issuer">
            {view.issuer.name ?? "An automation"}
            {view.issuer.user && (
              <span className="text-muted"> · {view.issuer.user.name}</span>
            )}
          </Property>
          {s.repository && (
            <Property label="Repository">
              <code>{s.repository}</code>
            </Property>
          )}
          <Property label="Links" data-testid="session-links">
            <ul className="session-links">
              {links.map((link) => (
                <li key={link.url}>
                  <a href={link.url} target="_blank" rel="noreferrer">
                    {link.label} ↗
                  </a>
                </li>
              ))}
              {s.externalUrl && (
                <li>
                  <a href={s.externalUrl} target="_blank" rel="noreferrer">
                    Linear session ↗
                  </a>
                </li>
              )}
              {s.issueUrl && (
                <li>
                  <a href={s.issueUrl} target="_blank" rel="noreferrer">
                    Linear issue ↗
                  </a>
                </li>
              )}
            </ul>
          </Property>
          {view.parent && (
            <Property label="Dispatched by" data-testid="session-parent">
              <Link to={`/sessions/${view.parent.id}`}>
                {view.parent.issueIdentifier ?? `#${view.parent.id}`}
              </Link>
            </Property>
          )}
          {view.children.length > 0 && (
            <Property label="Dispatched" data-testid="session-children">
              <ul className="session-links">
                {view.children.map((child) => (
                  <li key={child.id}>
                    <StatusGlyph status={glyphStatus(child.status)} />{" "}
                    <Link to={`/sessions/${child.id}`}>
                      {child.issueIdentifier ?? `#${child.id}`}
                    </Link>
                    {child.reviewRound > 0 && (
                      <Chip>round {child.reviewRound + 1}</Chip>
                    )}
                    {child.pullRequests.map((pr) => (
                      <a
                        key={pr.url}
                        href={pr.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {" "}
                        PR ↗
                      </a>
                    ))}
                  </li>
                ))}
              </ul>
            </Property>
          )}
        </PropertiesPanel>
      }
    >
      {error && (
        <Alert variant="danger" dismissible onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {notice && (
        <Alert
          variant="success"
          dismissible
          onClose={() => setNotice(null)}
          data-testid="session-notice"
        >
          {notice}
        </Alert>
      )}
      {s.summary && <p className="session-summary">{s.summary}</p>}
      <ActivityTranscript
        groups={groups}
        plan={s.plan as PlanStep[] | null}
        planIndex={planIndex}
        creatorName={s.creatorName}
        linearUrl={s.externalUrl}
        now={now}
      />
      <div data-testid="transcript-end" />
      <h2 className="session-section-title">Turns</h2>
      <WorkItemTimeline turns={turns} now={now} />

      <Modal
        show={confirming}
        onHide={() => setConfirming(false)}
        data-testid="session-cancel-modal"
      >
        <Modal.Header closeButton>
          <Modal.Title>
            Cancel {s.issueIdentifier ?? "this session"}?
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          Work not started is cancelled; a running turn is told to stop and
          report where it left things. Linear shows that it was stopped from the
          dashboard, and by you.
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="outline-secondary"
            onClick={() => setConfirming(false)}
            data-testid="session-cancel-keep"
          >
            Keep it running
          </Button>
          <Button
            variant="danger"
            disabled={!cancellable}
            onClick={cancel}
            data-testid="session-cancel-confirm"
          >
            Cancel session
          </Button>
        </Modal.Footer>
      </Modal>
    </DetailLayout>
  );
}
