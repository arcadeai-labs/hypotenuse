import type { AgentSessionList } from "@backend/actions/agent-session/agent-session-list";
import type { RunnerList } from "@backend/actions/runner/runner-list";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { isTypingTarget } from "../commands/keymap";
import { ListLayout } from "../components/layouts/ListLayout";
import { relativeTime } from "../components/NotificationBell";
import { RegisterRunnerModal } from "../components/runners/RegisterRunnerModal";
import { RunnerCard } from "../components/runners/RunnerCard";
import SkeletonRows from "../components/SkeletonRows";
import { useAuth } from "../context/AuthContext";
import { useLiveChannel, useLiveReconnect } from "../context/LiveSocketContext";
import { useFirstLoad } from "../hooks/useFirstLoad";
import { useMay } from "../hooks/useMay";
import {
  AgentBadge,
  Alert,
  Button,
  Chip,
  Form,
  Kbd,
  ListGroup,
  Modal,
  PresenceDot,
  Table,
} from "../ui";
import { apiFetch } from "../utils/client";
import {
  availableAgents,
  capacityLabel,
  groupByOwner,
  type HeldSession,
  isRunnersPayload,
  type ListedRunner,
  presenceOf,
  runnersChannel,
} from "../utils/runners";
import { parseSessionsFrame, sessionsChannel } from "../utils/sessions";

/** Where the chosen view is remembered. */
const VIEW_KEY = "hypotenuse.runnersView";

/**
 * `/runners` — who can take work right now. Cards grouped by owner (the
 * default) or a table, toggled with `v`. Each card's capacity bar links its
 * busy slots to the sessions they hold; a runner that went offline holding
 * work says so. Register mints a token shown once; rename, pause, and revoke
 * are for the runner's owner or an admin (`standing.canManage`, the server's
 * answer). Live on `project:<id>:runners`, and on the sessions channel for
 * what each slot holds.
 * @returns The page.
 */
export default function RunnersPage() {
  const { activeProjectId } = useAuth();
  const { may } = useMay();
  const [search, setSearch] = useSearchParams();
  const [runners, setRunners] = useState<ListedRunner[]>([]);
  const [held, setHeld] = useState<Map<number, HeldSession[]>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<ListedRunner | null>(null);
  const [renaming, setRenaming] = useState<ListedRunner | null>(null);
  const [newName, setNewName] = useState("");
  const [registering, setRegistering] = useState(false);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"cards" | "table">(() =>
    localStorage.getItem(VIEW_KEY) === "table" ? "table" : "cards",
  );
  const { loading, begin, done } = useFirstLoad();

  const load = useCallback(
    async (userInitiated = true) => {
      if (!activeProjectId) return;
      begin(userInitiated);
      try {
        const [res, active, stopping] = await Promise.all([
          apiFetch<ActionResponse<RunnerList>>(
            `/runners?projectId=${activeProjectId}&limit=100`,
          ),
          apiFetch<ActionResponse<AgentSessionList>>(
            `/agent-sessions?projectId=${activeProjectId}&status=active&limit=100`,
          ),
          apiFetch<ActionResponse<AgentSessionList>>(
            `/agent-sessions?projectId=${activeProjectId}&status=stopping&limit=100`,
          ),
        ]);
        const byRunner = new Map<number, HeldSession[]>();
        for (const s of [...active.agentSessions, ...stopping.agentSessions]) {
          if (s.runnerId === null) continue;
          byRunner.set(s.runnerId, [
            ...(byRunner.get(s.runnerId) ?? []),
            { id: s.id, issueIdentifier: s.issueIdentifier },
          ]);
        }
        setRunners(res.runners);
        setHeld(byRunner);
        setError(null);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : "Could not load runners.",
        );
      } finally {
        done();
      }
    },
    [activeProjectId, begin, done],
  );

  useEffect(() => {
    load();
  }, [load]);

  useLiveChannel(
    activeProjectId ? runnersChannel(activeProjectId) : null,
    (payload) => {
      if (isRunnersPayload(payload)) void load(false);
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

  // `v` toggles the view, unless someone is typing.
  useEffect(() => {
    /**
     * @param event - The key event.
     */
    function onKey(event: KeyboardEvent) {
      if (event.key !== "v" || event.metaKey || event.ctrlKey || event.altKey)
        return;
      if (
        isTypingTarget(event.target) ||
        document.querySelector("[role=dialog]")
      )
        return;
      setView((v) => {
        const next = v === "cards" ? "table" : "cards";
        try {
          localStorage.setItem(VIEW_KEY, next);
        } catch {
          // Unavailable storage only costs persistence.
        }
        return next;
      });
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The command palette's "Register runner" lands here with `?register=1`.
  useEffect(() => {
    if (search.get("register") === "1") {
      setRegistering(true);
      const rest = new URLSearchParams(search);
      rest.delete("register");
      setSearch(rest, { replace: true });
    }
  }, [search, setSearch]);

  const groups = useMemo(() => groupByOwner(runners), [runners]);

  /**
   * Run one change, then re-read.
   * @param change - The request.
   * @param failure - What to say if it fails.
   */
  async function mutate(change: () => Promise<unknown>, failure: string) {
    setBusy(true);
    try {
      await change();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : failure);
    } finally {
      setBusy(false);
    }
  }

  /** Revoke the runner being confirmed. */
  async function revoke() {
    if (!confirming || !activeProjectId) return;
    const target = confirming;
    setConfirming(null);
    await mutate(
      () =>
        apiFetch(`/runner/${target.id}`, {
          method: "DELETE",
          body: JSON.stringify({ projectId: activeProjectId }),
        }),
      "Could not revoke.",
    );
  }

  /** Save the rename in the modal. */
  async function rename() {
    if (!renaming || !activeProjectId) return;
    const target = renaming;
    setRenaming(null);
    await mutate(
      () =>
        apiFetch(`/runner/${target.id}`, {
          method: "POST",
          body: JSON.stringify({
            projectId: activeProjectId,
            name: newName.trim(),
          }),
        }),
      "Could not rename.",
    );
  }

  /**
   * Pause a runner (it stays connected and is offered nothing) or resume it.
   * @param runner - The runner.
   */
  async function togglePause(runner: ListedRunner) {
    await mutate(
      () =>
        apiFetch(`/runner/${runner.id}`, {
          method: "POST",
          body: JSON.stringify({
            projectId: activeProjectId,
            enabled: !runner.enabled,
          }),
        }),
      "Could not change the runner.",
    );
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

  const openRename = (runner: ListedRunner) => {
    setNewName(runner.name);
    setRenaming(runner);
  };

  return (
    <ListLayout
      title="Runners"
      display={
        <Button
          size="sm"
          variant="outline-secondary"
          onClick={() =>
            setView((v) => {
              const next = v === "cards" ? "table" : "cards";
              localStorage.setItem(VIEW_KEY, next);
              return next;
            })
          }
          data-testid="runners-view-toggle"
          aria-label={`Show as ${view === "cards" ? "table" : "cards"}`}
        >
          {view === "cards" ? "Table" : "Cards"} <Kbd keys="v" />
        </Button>
      }
      actions={
        may("runner:register") && (
          <Button
            size="sm"
            variant="primary"
            onClick={() => setRegistering(true)}
            data-testid="register-runner"
          >
            Register runner
          </Button>
        )
      }
    >
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
        <p className="text-muted shell-empty" data-testid="runners-empty">
          No runners yet. On the machine that should run coding agents, run{" "}
          <code>hypotenuse runner register</code>, or use Register runner.
        </p>
      ) : view === "cards" && !loading ? (
        <div data-testid="runners-cards" data-view="cards">
          {groups.map(([owner, theirs]) => (
            <ListGroup key={owner} title={owner} count={theirs.length}>
              <div className="runner-cards">
                {theirs.map((runner) => (
                  <RunnerCard
                    key={runner.id}
                    runner={runner}
                    held={held.get(runner.id) ?? []}
                    busy={busy}
                    onEdit={openRename}
                    onTogglePause={togglePause}
                    onRevoke={setConfirming}
                  />
                ))}
              </div>
            </ListGroup>
          ))}
        </div>
      ) : (
        <Table
          size="sm"
          hover
          responsive
          data-testid="runners-table"
          data-view="table"
        >
          <thead>
            <tr>
              <th scope="col">Runner</th>
              <th scope="col">Owner</th>
              <th scope="col">Status</th>
              <th scope="col">Capacity</th>
              <th scope="col">Agents</th>
              <th scope="col">Version</th>
              <th scope="col">Last heartbeat</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {loading && (
              <SkeletonRows columns={8} rows={3} testId="runners-loading" />
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
                <td className="text-meta">{runner.daemonVersion ?? "—"}</td>
                <td className="tabular">
                  {runner.lastHeartbeatAt === null
                    ? "never"
                    : relativeTime(runner.lastHeartbeatAt)}
                </td>
                <td className="text-nowrap">
                  {runner.standing?.canManage && (
                    <>
                      <Button
                        size="sm"
                        variant="link"
                        disabled={busy}
                        onClick={() => openRename(runner)}
                        data-testid={`rename-runner-${runner.id}`}
                      >
                        Rename
                      </Button>
                      <Button
                        size="sm"
                        variant="link"
                        disabled={busy}
                        onClick={() => togglePause(runner)}
                        data-testid={`pause-runner-${runner.id}`}
                      >
                        {runner.enabled ? "Pause" : "Resume"}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline-danger"
                        disabled={busy}
                        onClick={() => setConfirming(runner)}
                        data-testid={`revoke-runner-${runner.id}`}
                      >
                        Revoke
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <RegisterRunnerModal
        show={registering}
        projectId={activeProjectId}
        onHide={() => setRegistering(false)}
        onRegistered={() => void load()}
      />

      <Modal
        show={renaming !== null}
        onHide={() => setRenaming(null)}
        data-testid="runner-rename-modal"
      >
        <Modal.Header closeButton>
          <Modal.Title>Rename {renaming?.name}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <Form
            onSubmit={(e) => {
              e.preventDefault();
              void rename();
            }}
          >
            <Form.Control
              aria-label="New name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              data-testid="runner-rename-input"
            />
          </Form>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={() => setRenaming(null)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!newName.trim()}
            onClick={rename}
            data-testid="runner-rename-save"
          >
            Save
          </Button>
        </Modal.Footer>
      </Modal>

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
