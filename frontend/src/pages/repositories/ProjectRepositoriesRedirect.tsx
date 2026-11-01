import type { ProjectView } from "@backend/actions/project/project-view";
import type { ActionResponse } from "keryx";
import { useEffect, useState } from "react";
import { Link, Navigate, useLocation, useParams } from "react-router-dom";
import { LoadingLabel } from "../../components/LoadingLabel";
import { useAuth } from "../../context/AuthContext";
import { Alert } from "../../ui";
import { apiFetch } from "../../utils/client";

/**
 * `/projects/:projectId/repositories` — where GitHub's install flow returns:
 * it names the project the installation was attached to, which need not be
 * the one selected. Selects that project (and its organization, when it is in
 * another one), then shows `/repositories` with the same query, so the page
 * can say how the install went (`?installed=` or `?error=`).
 * @returns The redirect, or what stands in for it while the project is chosen.
 */
export function ProjectRepositoriesRedirect() {
  const { projectId: raw } = useParams();
  const { search } = useLocation();
  const {
    loading,
    projects,
    activeProjectId,
    setActiveProject,
    setActiveOrganization,
  } = useAuth();
  const projectId = Number(raw);
  const valid = Number.isInteger(projectId) && projectId > 0;
  const [failed, setFailed] = useState<string | null>(null);
  const known = projects.some((p) => p.id === projectId);

  useEffect(() => {
    if (loading || !valid || activeProjectId === projectId) return;
    if (known) {
      setActiveProject(projectId);
      return;
    }
    // Another organization's project: learn which, then switch to it. The
    // project is stored first, so the organization switch selects it.
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch<ActionResponse<ProjectView>>(
          `/project/${projectId}`,
        );
        if (cancelled) return;
        setActiveProject(projectId);
        await setActiveOrganization(res.organization.id);
      } catch (err) {
        if (!cancelled) {
          setFailed(
            err instanceof Error ? err.message : "Could not open the project.",
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    loading,
    valid,
    known,
    projectId,
    activeProjectId,
    setActiveProject,
    setActiveOrganization,
  ]);

  if (!valid || failed) {
    return (
      <div className="page" data-testid="project-repositories-missing">
        <Alert variant="warning">
          {failed ?? "That is not a project."}{" "}
          <Link to={`/repositories${search}`}>Repositories</Link>
        </Alert>
      </div>
    );
  }
  if (activeProjectId === projectId && known) {
    return <Navigate to={`/repositories${search}`} replace />;
  }
  return (
    <div className="page" data-testid="project-repositories-loading">
      <LoadingLabel
        block
        testId="project-repositories-opening"
        label="Opening the project"
      />
    </div>
  );
}
