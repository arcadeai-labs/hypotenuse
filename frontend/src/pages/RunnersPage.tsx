import type { RunnerList } from "@backend/actions/runner/runner-list";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useState } from "react";
import { ListLayout } from "../components/layouts/ListLayout";
import { relativeTime } from "../components/NotificationBell";
import SkeletonRows from "../components/SkeletonRows";
import { useAuth } from "../context/AuthContext";
import { useLiveChannel, useLiveReconnect } from "../context/LiveSocketContext";
import { useFirstLoad } from "../hooks/useFirstLoad";
import {
  AgentBadge,
  Alert,
  Button,
  Chip,
  Modal,
  PresenceDot,
  Table,
} from "../ui";
import { apiFetch } from "../utils/client";
import {
  availableAgents,
  capacityLabel,
  isRunnersPayload,
  type ListedRunner,
  presenceOf,
  runnersChannel,
} from "../utils/runners";

/**
 * `/runners` — the machines connected to the active project: who owns each,
 * whether it is heartbeating, how many of its slots are busy, which agents it
 * can run, and when it last checked in. Live: a frame on
 * `project:<id>:runners` re-reads the list.
 *
 * Whether a person may revoke a runner is the server's answer
 * (`standing.canManage` — its owner or a project admin), not a rule restated
 * here.
 * @returns The page.
 */
export default function RunnersPage() {
  const { activeProjectId } = useAuth();
  const [runners, setRunners] = useState<ListedRunner[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ListedRunner | null>(null);
  const [busy, setBusy] = useState(false);
  const { loading, begin, done } = useFirstLoad();

  const load = useCallback(async () => {
    if (!activeProjectId) return;
    begin();
    try {
      const res = await apiFetch<ActionResponse<RunnerList>>(
        `/runners?projectId=${activeProjectId}&limit=100`,
      );
      setRunners(res.runners);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load runners.");
    } finally {
      done();
    }
  }, [activeProjectId, begin, done]);

  useEffect(() => {
    load();
  }, [load]);

  useLiveChannel(
    activeProjectId ? runnersChannel(activeProjectId) : null,
    (payload) => {
      if (isRunnersPayload(payload)) void load();
    },
  );
  useLiveReconnect(() => {
    void load();
  });

  /** Revoke the runner being confirmed, then re-read. */
  async function revoke() {
    if (!confirming || !activeProjectId) return;
    const target = confirming;
    setConfirming(null);
    setBusy(true);
    try {
      await apiFetch(`/runner/${target.id}`, {
        method: "DELETE",
        body: JSON.stringify({ projectId: activeProjectId }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke.");
    } finally {
      setBusy(false);
    }
  }

  if (!activeProjectId) {
    return (
      <ListLayout title="Runners">
        <Alert variant="info" data-testid="no-project">
          Select or create a project to see its runners.
        </Alert>
      </ListLayout>
    );
  }

  return (
    <ListLayout title="Runners">
      {error && (
        <Alert
          variant="danger"
          dismissible
          onClose={() => setError(null)}
          data-testid="runners-error"
        >
          {error}
        </Alert>
      )}
      {!loading && runners.length === 0 ? (
        <p className="text-muted" data-testid="runners-empty">
          No runners yet. On the machine that should run coding agents, run{" "}
          <code>hypotenuse runner register</code>.
        </p>
      ) : (
        <Table size="sm" hover responsive data-testid="runners-table">
          <thead>
            <tr>
              <th scope="col">Runner</th>
              <th scope="col">Owner</th>
              <th scope="col">Status</th>
              <th scope="col">Capacity</th>
              <th scope="col">Agents</th>
              <th scope="col">Last heartbeat</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <SkeletonRows columns={7} rows={3} testId="runners-loading" />
            )}
            {runners.map((runner) => (
              <tr key={runner.id} data-testid={`runner-${runner.id}`}>
                <td>
                  <PresenceDot presence={presenceOf(runner.status)} />{" "}
                  {runner.name}
                </td>
                <td>{runner.owner?.name ?? "—"}</td>
                <td data-testid={`runner-status-${runner.id}`}>
                  {runner.status}{" "}
                  {!runner.enabled && <Chip tone="subtle">Paused</Chip>}
                </td>
                <td className="tabular">{capacityLabel(runner)}</td>
                <td>
                  {availableAgents(runner).map((agent) => (
                    <AgentBadge key={agent} kind={agent} />
                  ))}
                </td>
                <td className="tabular">
                  {runner.lastHeartbeatAt === null
                    ? "never"
                    : relativeTime(runner.lastHeartbeatAt)}
                </td>
                <td>
                  {runner.standing?.canManage && (
                    <Button
                      size="sm"
                      variant="outline-danger"
                      disabled={busy}
                      onClick={() => setConfirming(runner)}
                      data-testid={`revoke-runner-${runner.id}`}
                    >
                      Revoke
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Modal
        show={confirming !== null}
        onHide={() => setConfirming(null)}
        data-testid="runner-revoke-modal"
      >
        <Modal.Header closeButton>
          <Modal.Title>Revoke {confirming?.name}?</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          Its token stops working at once and its daemon is told to stop. The
          machine can join again only by registering a new runner.
        </Modal.Body>
        <Modal.Footer>
          <Button
            variant="outline-secondary"
            onClick={() => setConfirming(null)}
            data-testid="runner-revoke-cancel"
          >
            Keep it
          </Button>
          <Button
            variant="danger"
            onClick={revoke}
            data-testid="runner-revoke-confirm"
          >
            Revoke
          </Button>
        </Modal.Footer>
      </Modal>
    </ListLayout>
  );
}
