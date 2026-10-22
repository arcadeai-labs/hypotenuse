import { ListLayout } from "../components/layouts/ListLayout";
import { PreviewPanel } from "../components/routing/PreviewPanel";
import { RoutingRulesCard } from "../components/routing/RuleTable";
import { useAuth } from "../context/AuthContext";
import { useMay } from "../hooks/useMay";
import { Alert } from "../ui";

/**
 * `/routing` — how work is routed: the ordered rules that pick a session's
 * role (reorder, enable, edit — as `can()` allows), and a preview that runs
 * them, and runner eligibility, against a real Linear issue. The timers live
 * in Settings → Routing.
 * @returns The page.
 */
export default function RoutingPage() {
  const { activeProjectId } = useAuth();
  const { may } = useMay();
  if (!activeProjectId) {
    return (
      <ListLayout title="Routing">
        <Alert variant="info" data-testid="no-project">
          Select or create a project to see its routing.
        </Alert>
      </ListLayout>
    );
  }
  return (
    <ListLayout title="Routing">
      <div className="page-stack" data-testid="routing-page">
        {/* `may` answers false until the server has said who you are, so
            gated controls appear then, never before. */}
        <RoutingRulesCard projectId={activeProjectId} may={may} />
        <PreviewPanel projectId={activeProjectId} />
      </div>
    </ListLayout>
  );
}
