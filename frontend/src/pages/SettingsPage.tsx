import type { ConnectionList } from "@backend/actions/connection/connection-list";
import type { ProjectView } from "@backend/actions/project/project-view";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Outlet } from "react-router-dom";
import Alert from "../ui/Alert";
import Col from "../ui/Col";
import Row from "../ui/Row";
import LoadingLabel from "../components/LoadingLabel";
import DiscardChangesModal from "../components/sections/DiscardChangesModal";
import { useDirtyGuard } from "../components/sections/useDirtyGuard";
import type {
  Catalog,
  Connection,
  Mcp,
  Project,
  SettingsContext,
} from "../components/settings/context";
import SettingsSectionNav from "../components/settings/SettingsSectionNav";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../utils/client";
import { can, type ProjectStanding } from "../utils/permissions";

/**
 * The standing to assume before `project:view` answers.
 *
 * A module constant rather than an inline literal, so `may`'s identity does not
 * change on every render — a fresh object in a `useCallback` dependency list would
 * rebuild it continuously and re-fire every effect a section keys on it.
 */
const NOT_A_MEMBER: ProjectStanding = { isMember: false, isAdmin: false };

/**
 * `/settings/*` — the project settings shell: section sidebar, and the section
 * itself.
 *
 * This is the merge of two pages that shared nothing but their scaffolding.
 * `/settings` was 910 lines holding twelve pieces of state, four cards, and a
 * single error Alert above all of them; `/project` was 532 more with the same
 * `load()`/`mutate()`/`gate` trio written out a second time. Both had the two
 * failures the agent editor was refactored out of: a card's error rendered
 * hundreds of lines from the control that caused it, and one `load()` re-seeded
 * every field on the page, so a background refresh could revert what somebody was
 * typing. `/settings` had a hand-rolled `formEdited` ref specifically because a
 * concurrency limit typed as 7 was being posted as 3; that ref is now
 * `useSeededDraft`, which is the same fix with a test behind it.
 *
 * **Two loaders, and the shell holds only what more than one simultaneously
 * reachable section needs.** `project:view` is the only source of standing, so the
 * outlet context stays `null` until it answers. `connection:list` is here because
 * three sections read it — Model, Git providers, and Sandbox, which renders
 * the account its chosen provider needs — and one of those three is always the one
 * mounted. Everything else a single section reads, that section fetches, which is
 * what makes "a plain member never calls an admin-only endpoint" a property of the
 * shape rather than of a conditional somebody has to remember.
 *
 * **Which sections report unsaved edits**, since the next reader will otherwise
 * add a fourth: General (the rename), Sandbox (provider, its config, concurrency,
 * egress, *and* the credential box on the account form — one `markDirty` effect
 * per section, aggregating both), Model and Git providers (a pasted PEM lost
 * to a stray sidebar click is exactly the loss the guard exists for). Deliberately not MCP or Sandbox ledger, which
 * have nothing to type; not Tags or Members, where the draft is a ten-character
 * name typed immediately before submitting and a modal in front of that is worse
 * than retyping it; and not Danger zone, where losing the confirmation text is the
 * *point* of asking for it.
 * @returns The rendered settings area.
 */
export default function SettingsPage() {
  const { activeProjectId, permissions } = useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [mcp, setMcp] = useState<Mcp | null>(null);
  const [standing, setStanding] = useState<ProjectStanding | null>(null);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [connectionsLoaded, setConnectionsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const {
    dirtySlug,
    markDirty,
    onNavigate,
    pendingNav,
    cancelNav,
    confirmNav,
  } = useDirtyGuard("/settings");

  /** Re-read `project:view` alone: the project, the caller's standing, the MCP URL. */
  const reloadProject = useCallback(async () => {
    if (!activeProjectId) return;
    try {
      const view = await apiFetch<ActionResponse<ProjectView>>(
        `/project?projectId=${activeProjectId}`,
      );
      setProject(view.project);
      setMcp(view.mcp);
      setStanding(view.standing);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load this project.",
      );
    }
  }, [activeProjectId]);

  const isAdmin = standing?.isAdmin === true;

  /**
   * Re-read `connection:list` alone.
   *
   * Returns early for anyone who is not an admin, because `connection:list` is
   * `AdminMiddleware`-gated and asking as a plain member would only produce a 403
   * to swallow. `isAdmin` is in the dependency list rather than closed over, or an
   * admin whose standing resolves after mount would keep the empty first answer
   * forever.
   */
  const reloadConnections = useCallback(async () => {
    if (!activeProjectId || !isAdmin) return;
    try {
      const response = await apiFetch<ActionResponse<ConnectionList>>(
        `/connections?projectId=${activeProjectId}`,
      );
      setConnections(response.connections);
      setCatalog(response.catalog);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load connections.",
      );
    } finally {
      // Settled, failure included — a read that threw has still had its answer,
      // and a section left waiting on this would hold a skeleton forever with
      // the explanation sitting above it.
      setConnectionsLoaded(true);
    }
  }, [activeProjectId, isAdmin]);

  useEffect(() => {
    reloadProject();
  }, [reloadProject]);

  useEffect(() => {
    reloadConnections();
  }, [reloadConnections]);

  // Until `project:view` answers, assume the least — flashing admin controls on
  // and back off again is worse than a beat of nothing. The context is withheld
  // until then, so no section ever sees this fallback; it exists so `may` is a
  // stable function rather than a nullable one.
  const may = useCallback(
    (actionName: string) =>
      can(permissions, actionName, standing ?? NOT_A_MEMBER),
    [permissions, standing],
  );

  const maySeeSecrets = may("connection:list");

  // Memoized on its actual members: the object's identity would otherwise change
  // on every render of this component, re-firing any effect a section has that
  // depends on it.
  const outletContext: SettingsContext | null = useMemo(
    () =>
      activeProjectId && project && standing
        ? {
            projectId: activeProjectId,
            project,
            mcp,
            standing,
            may,
            connections,
            catalog,
            maySeeSecrets,
            connectionsLoaded,
            reloadProject,
            reloadConnections,
            markDirty,
          }
        : null,
    [
      activeProjectId,
      project,
      mcp,
      standing,
      may,
      connections,
      catalog,
      maySeeSecrets,
      connectionsLoaded,
      reloadProject,
      reloadConnections,
      markDirty,
    ],
  );

  if (!activeProjectId) {
    return (
      <Alert variant="info" className="mt-3" data-testid="no-project">
        Select or create a project to change its settings.
      </Alert>
    );
  }

  return (
    <>
      <h1 className="mt-3">{project?.name ?? "Settings"}</h1>
      <span className="tx-rule" aria-hidden="true" />

      {/* The shell's own failures only. Everything a section does reports inside
          that section's card, which is the whole reason for this refactor. */}
      {error && (
        <Alert
          variant="danger"
          dismissible
          onClose={() => setError(null)}
          data-testid="settings-error"
        >
          {error}
        </Alert>
      )}

      <Row className="g-3">
        <Col md={3}>
          {/* Rendered before the project resolves, so the sidebar is there to
              click on during the first fetch rather than appearing under the
              cursor a moment later. */}
          <SettingsSectionNav dirtySlug={dirtySlug} onNavigate={onNavigate} />
        </Col>
        <Col md={9}>
          {/* `!error` rather than the old `{error ?? "Loading…"}`, which rendered
              a failure under a testid that says "loading" — so a read that threw
              looked, to anything watching that locator, exactly like one still in
              flight. The message itself is not repeated here: the shell's own
              Alert above already carries it, and a second element wearing
              `settings-error` would be a duplicate test id, which Playwright's
              strict mode refuses outright. */}
          {outletContext ? (
            <Outlet context={outletContext} />
          ) : (
            !error && <LoadingLabel testId="settings-loading" />
          )}
        </Col>
      </Row>

      <DiscardChangesModal
        dirtySlug={dirtySlug}
        pendingNav={pendingNav}
        onCancel={cancelNav}
        onConfirm={confirmNav}
      />
    </>
  );
}
