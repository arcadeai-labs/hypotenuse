import { useMemo } from "react";
import { Link, Outlet } from "react-router-dom";
import { LoadingLabel } from "../components/LoadingLabel";
import type { SettingsContext } from "../components/settings/context";
import { SettingsSectionNav } from "../components/settings/SettingsSectionNav";
import { PageHeader } from "../components/shell/PageHeader";
import { useAuth } from "../context/AuthContext";
import { useStanding } from "../context/StandingContext";
import { useMay } from "../hooks/useMay";
import { Alert } from "../ui";

/**
 * `/settings/*` — the active project's settings: the section sidebar, and the
 * section itself.
 *
 * The outlet context is withheld until `project:view` has answered **for the
 * active project**, so a section never renders against a guessed standing or
 * against the previous project's row after a switch.
 * @returns The settings area.
 */
export function SettingsPage() {
  const { activeProjectId, activeOrganizationId } = useAuth();
  const { projectView, reloadProject } = useStanding();
  const { may, reason } = useMay();

  const outletContext: SettingsContext | null = useMemo(
    () =>
      activeProjectId && projectView?.project.id === activeProjectId
        ? {
            projectId: activeProjectId,
            project: projectView.project,
            organizationId: projectView.project.organizationId,
            standing: projectView.standing,
            may,
            reason,
            reloadProject,
          }
        : null,
    [activeProjectId, projectView, may, reason, reloadProject],
  );

  if (!activeProjectId) {
    return (
      <div className="page" data-testid="settings-page">
        <PageHeader title="Settings" />
        <Alert variant="info" data-testid="no-project">
          {activeOrganizationId ? (
            <>
              This organization shows you no projects yet. Ask an admin of one
              to invite you, or see the{" "}
              <Link to="/organization/projects">organization's projects</Link>.
            </>
          ) : (
            "Choose an organization, then a project, to change its settings."
          )}
        </Alert>
      </div>
    );
  }

  return (
    <div className="page" data-testid="settings-page">
      <PageHeader
        title={
          <>
            {projectView?.project.name ?? "Settings"}
            <span className="shell-page-subtitle"> · Settings</span>
          </>
        }
      />
      {outletContext?.standing.viaOrganizationOwner && (
        <Alert variant="info" data-testid="owner-standing">
          You are an admin here because you own this project's organization.
        </Alert>
      )}
      <div className="page-sections">
        <aside className="page-sections-nav">
          <SettingsSectionNav />
        </aside>
        <div className="page-sections-body">
          {outletContext ? (
            <Outlet context={outletContext} />
          ) : (
            <LoadingLabel testId="settings-loading" />
          )}
        </div>
      </div>
    </div>
  );
}
