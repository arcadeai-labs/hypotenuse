import { useMemo } from "react";
import { Outlet } from "react-router-dom";
import { LoadingLabel } from "../../components/LoadingLabel";
import {
  ORGANIZATION_SECTIONS,
  type OrganizationContext,
} from "../../components/organization/context";
import { SectionNav } from "../../components/sections/SectionNav";
import { PageHeader } from "../../components/shell/PageHeader";
import { useAuth } from "../../context/AuthContext";
import { useStanding } from "../../context/StandingContext";
import { useMay } from "../../hooks/useMay";
import { Alert, Badge } from "../../ui";

/**
 * `/organization/*` — the active organization's projects, members, and
 * settings, under one header and one section sidebar. Withheld until
 * `organization:view` has answered for the organization that is active now.
 * @returns The organization frame.
 */
export function OrganizationPage() {
  const { activeOrganizationId } = useAuth();
  const { organizationView, reloadOrganization } = useStanding();
  const { may, reason } = useMay();

  const context: OrganizationContext | null = useMemo(
    () =>
      activeOrganizationId &&
      organizationView?.organization.id === activeOrganizationId
        ? {
            organizationId: activeOrganizationId,
            organization: organizationView.organization,
            standing: organizationView.standing,
            may,
            reason,
            reloadOrganization,
          }
        : null,
    [activeOrganizationId, organizationView, may, reason, reloadOrganization],
  );

  if (!activeOrganizationId) {
    return (
      <div className="page" data-testid="organization-page">
        <PageHeader title="Organization" />
        <Alert variant="info" data-testid="no-organization">
          You do not belong to an organization. An invitation to one is under
          Invites in the account menu.
        </Alert>
      </div>
    );
  }

  return (
    <div className="page" data-testid="organization-page">
      <PageHeader
        title={organizationView?.organization.name ?? "Organization"}
        actions={
          context && (
            <Badge
              bg={context.standing.isOwner ? "info" : "secondary"}
              data-testid="organization-role"
            >
              {context.standing.isOwner ? "Owner" : "Member"}
            </Badge>
          )
        }
      />
      <div className="page-sections">
        <aside className="page-sections-nav">
          <SectionNav
            testId="organization-section-nav"
            items={ORGANIZATION_SECTIONS.map((s) => ({
              ...s,
              to: `/organization/${s.slug}`,
            }))}
          />
        </aside>
        <div className="page-sections-body">
          {context ? (
            <Outlet context={context} />
          ) : (
            <LoadingLabel testId="organization-loading" />
          )}
        </div>
      </div>
    </div>
  );
}
