import { AllIdentitiesCard } from "../components/account/AllIdentitiesCard";
import { LinkedIdentitiesCard } from "../components/account/LinkedIdentitiesCard";
import { PageHeader } from "../components/shell/PageHeader";
import { useAuth } from "../context/AuthContext";
import { useMay } from "../hooks/useMay";
import { Alert } from "../ui";

/**
 * `/identities` — who in the Linear workspace is whom here. Everyone sees the
 * Linear accounts linked to them (sessions those people start prefer their
 * runners) and can unlink one; an admin also sees and manages every link in
 * the project. A link is a routing preference, never a permission.
 * @returns The page.
 */
export default function IdentitiesPage() {
  const { activeProjectId } = useAuth();
  const { may } = useMay();
  return (
    <div className="page" data-testid="identities-page">
      <PageHeader title="Identities" />
      {activeProjectId === null ? (
        <Alert variant="info" data-testid="no-project">
          Select or create a project to see its identities.
        </Alert>
      ) : (
        <>
          <LinkedIdentitiesCard />
          {may("external-identity:link") && (
            <AllIdentitiesCard projectId={activeProjectId} />
          )}
        </>
      )}
    </div>
  );
}
