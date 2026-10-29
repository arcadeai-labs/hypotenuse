import { AuditLogView } from "../../components/audit/AuditLogView";
import { useOrganization } from "../../components/organization/context";
import { SectionCard } from "../../components/sections/SectionCard";
import { useAuth } from "../../context/AuthContext";
import { Alert } from "../../ui";

/**
 * `/organization/audit` — the organization's audit log: its own changes and
 * every project's, including projects since deleted. Owners only.
 * @returns The section.
 */
export function OrganizationAuditPage() {
  const { organizationId, reason } = useOrganization();
  const { projects } = useAuth();
  const denied = reason("organization:audit-list");

  return (
    <SectionCard
      title="Audit log"
      testId="audit"
      idPrefix="organization"
      intro="Every decision a person made in this organization and its projects: who, what, and the state before and after."
    >
      {denied ? (
        <Alert
          variant="info"
          className="mb-0"
          data-testid="organization-audit-denied"
        >
          {denied}
        </Alert>
      ) : (
        <AuditLogView
          key={organizationId}
          path={`/organization/${organizationId}/audit`}
          testId="organization-audit"
          projects={projects.map((p) => ({ id: p.id, name: p.name }))}
        />
      )}
    </SectionCard>
  );
}
