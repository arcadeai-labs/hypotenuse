import type { ProjectView } from "@backend/actions/project/project-view";
import type { ActionResponse } from "keryx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Outlet } from "react-router-dom";
import LoadingLabel from "../components/LoadingLabel";
import DiscardChangesModal from "../components/sections/DiscardChangesModal";
import { useDirtyGuard } from "../components/sections/useDirtyGuard";
import type {
  Mcp,
  Project,
  SettingsContext,
} from "../components/settings/context";
import SettingsSectionNav from "../components/settings/SettingsSectionNav";
import { PageHeader } from "../components/shell/PageHeader";
import { useAuth } from "../context/AuthContext";
import { Alert } from "../ui";
import { apiFetch } from "../utils/client";
import { can, type ProjectStanding } from "../utils/permissions";

/**
 * The standing to assume before `project:view` answers. A module constant
 * rather than an inline literal, so `may`'s identity does not change on every
 * render and re-fire every effect a section keys on it.
 */
const NOT_A_MEMBER: ProjectStanding = { isMember: false, isAdmin: false };

/**
 * `/settings/*` — the project settings shell: section sidebar, and the section
 * itself.
 *
 * **One loader, and the shell holds only what more than one simultaneously
 * reachable section needs.** `project:view` is the only source of standing, so
 * the outlet context stays `null` until it answers. Everything else a single
 * section reads, that section fetches.
 *
 * **Which sections report unsaved edits:** General (the rename). Not MCP, which
 * has nothing to type; not Tags or Members, where the draft is a short name typed
 * immediately before submitting and a modal in front of that is worse than
 * retyping it; and not Danger zone, where losing the confirmation text is the
 * *point* of asking for it.
 * @returns The rendered settings area.
 */
export default function SettingsPage() {
  const { activeProjectId, permissions } = useAuth();

  const [project, setProject] = useState<Project | null>(null);
  const [mcp, setMcp] = useState<Mcp | null>(null);
  const [standing, setStanding] = useState<ProjectStanding | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    dirtySlug,
    markDirty,
    onNavigate,
    pendingNav,
    cancelNav,
    confirmNav,
  } = useDirtyGuard("/settings");

  // The project the page is showing *now*, so a `project:view` that answers
  // after a switch cannot write the previous project into this one's sections.
  const currentProjectId = useRef(activeProjectId);
  currentProjectId.current = activeProjectId;

  /** Re-read `project:view` alone: the project, the caller's standing, the MCP URL. */
  const reloadProject = useCallback(async () => {
    if (!activeProjectId) return;
    try {
      const view = await apiFetch<ActionResponse<ProjectView>>(
        `/project?projectId=${activeProjectId}`,
      );
      if (view.project.id !== currentProjectId.current) return;
      setProject(view.project);
      setMcp(view.mcp);
      setStanding(view.standing);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load this project.",
      );
    }
  }, [activeProjectId]);

  useEffect(() => {
    reloadProject();
  }, [reloadProject]);

  // Until `project:view` answers, assume the least. The context is withheld
  // until then, so no section ever sees this fallback; it exists so `may` is a
  // stable function rather than a nullable one.
  const may = useCallback(
    (actionName: string) =>
      can(permissions, actionName, standing ?? NOT_A_MEMBER),
    [permissions, standing],
  );

  // Withheld unless the loaded project *is* the active one: after a switch the
  // previous project's row is still in state until `project:view` answers, and
  // pairing it with the new id would let General save one project's name onto
  // another.
  const outletContext: SettingsContext | null = useMemo(
    () =>
      activeProjectId && project?.id === activeProjectId && standing
        ? {
            projectId: activeProjectId,
            project,
            mcp,
            standing,
            may,
            reloadProject,
            markDirty,
          }
        : null,
    [activeProjectId, project, mcp, standing, may, reloadProject, markDirty],
  );

  if (!activeProjectId) {
    return (
      <div className="page">
        <PageHeader title="Settings" />
        <Alert variant="info" data-testid="no-project">
          Select or create a project to change its settings.
        </Alert>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title={project?.name ?? "Settings"} />

      {/* The shell's own failures only. Everything a section does reports
          inside that section's card. */}
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

      <div className="page-sections">
        {/* Rendered before the project resolves, so the sidebar is there to
            click on during the first fetch. */}
        <aside className="page-sections-nav">
          <SettingsSectionNav dirtySlug={dirtySlug} onNavigate={onNavigate} />
        </aside>
        <div className="page-sections-body">
          {/* `!error` so a read that threw does not look, to anything watching
              the loading locator, like one still in flight. */}
          {outletContext ? (
            <Outlet context={outletContext} />
          ) : (
            !error && <LoadingLabel testId="settings-loading" />
          )}
        </div>
      </div>

      <DiscardChangesModal
        dirtySlug={dirtySlug}
        pendingNav={pendingNav}
        onCancel={cancelNav}
        onConfirm={confirmNav}
      />
    </div>
  );
}
