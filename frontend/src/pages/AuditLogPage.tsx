import { Link } from "react-router-dom";
import { AuditLogView } from "../components/audit/AuditLogView";
import { LoadingLabel } from "../components/LoadingLabel";
import { PageHeader } from "../components/shell/PageHeader";
import { useAuth } from "../context/AuthContext";
import { useStanding } from "../context/StandingContext";
import { useMay } from "../hooks/useMay";
import { Alert } from "../ui";

/**
 * `/audit` — the active project's audit log: every decision a person made in
 * it. Admins only, which the page asks `can()` about once `project:view` has
 * answered for the active project, so a member sees why rather than a failed
 * request.
 * @returns The page.
 */
export function AuditLogPage() {
  const { activeProjectId } = useAuth();
  const { projectView } = useStanding();
  const { reason } = useMay();
  const resolved =
    activeProjectId && projectView?.project.id === activeProjectId;
  const denied = resolved ? reason("audit:list") : undefined;

  return (
    <div className="page" data-testid="audit-page">
      <PageHeader
        title={
          <>
            {resolved ? projectView.project.name : "Project"}
            <span className="shell-page-subtitle"> · Audit log</span>
          </>
        }
      />
      {!activeProjectId ? (
        <Alert variant="info" data-testid="no-project">
          Choose a project to read its audit log. An organization's whole log is
          under <Link to="/organization/audit">Organization</Link>.
        </Alert>
      ) : !resolved ? (
        <LoadingLabel testId="audit-loading" />
      ) : denied ? (
        <Alert variant="info" data-testid="audit-denied">
          {denied} The audit log names every member and every change, so only
          admins read it.
        </Alert>
      ) : (
        <AuditLogView
          key={activeProjectId}
          path={`/project/${activeProjectId}/audit`}
          testId="audit"
        />
      )}
    </div>
  );
}
