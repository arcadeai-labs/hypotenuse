import { Building2, ChevronsUpDown } from "lucide-react";
import { Dropdown } from "../../ui";
import { MenuLinkItem } from "./MenuLinkItem";
import type { ShellOrganization } from "./shellData";

/** See {@link OrganizationSwitcher}. */
export interface OrganizationSwitcherProps {
  organizations: ShellOrganization[];
  activeOrganizationId: number | null;
  /** Make an organization active. */
  onSelect: (organizationId: number) => void;
  /** Why "New project" is refused, or `undefined` when it is offered. */
  newProjectDenied?: string;
  /** Why "New organization" is refused, or `undefined` when it is offered. */
  newOrganizationDenied?: string;
  /** Why the organization's audit log is refused, or `undefined` when it is offered. */
  organizationAuditDenied?: string;
  /** Called after a choice (the mobile sheet closes on it). */
  onNavigate?: () => void;
}

/**
 * The sidebar's organization switcher, above the project switcher: every
 * organization the person belongs to, then the active one's projects, members,
 * settings, and audit log (an owner's), and New project — which only an owner may use, and which
 * everyone else sees disabled with the reason — then New organization, which
 * anyone signed in may start.
 * @param props - See {@link OrganizationSwitcherProps}.
 * @returns The switcher.
 */
export function OrganizationSwitcher({
  organizations,
  activeOrganizationId,
  onSelect,
  newProjectDenied,
  newOrganizationDenied,
  organizationAuditDenied,
  onNavigate,
}: OrganizationSwitcherProps) {
  const active = organizations.find((o) => o.id === activeOrganizationId);
  const noOrganization = active ? undefined : "No organization selected";
  return (
    <Dropdown
      className="shell-project-switcher shell-organization-switcher"
      data-testid="organization-switcher"
    >
      <Dropdown.Toggle
        className="shell-project shell-organization"
        data-testid="organization-switcher-toggle"
        title={active?.name}
      >
        <Building2 size={14} aria-hidden="true" />
        <span className="shell-project-name">
          {active?.name ?? "No organization"}
        </span>
        <ChevronsUpDown size={14} aria-hidden="true" />
      </Dropdown.Toggle>
      <Dropdown.Menu>
        <Dropdown.Header>Organizations</Dropdown.Header>
        {organizations.map((organization) => (
          <Dropdown.Item
            key={organization.id}
            active={organization.id === activeOrganizationId}
            aria-current={
              organization.id === activeOrganizationId ? "true" : undefined
            }
            onClick={() => {
              if (organization.id !== activeOrganizationId) {
                onSelect(organization.id);
              }
              onNavigate?.();
            }}
            data-testid={`organization-option-${organization.id}`}
          >
            {organization.name}
          </Dropdown.Item>
        ))}
        {organizations.length === 0 && (
          <Dropdown.Item disabled data-testid="organization-none">
            No organizations
          </Dropdown.Item>
        )}
        <Dropdown.Divider />
        <MenuLinkItem
          to="/organization/projects"
          label="Projects"
          testId="organization-projects-link"
          deniedReason={noOrganization}
          onNavigate={onNavigate}
        />
        <MenuLinkItem
          to="/organization/members"
          label="Members"
          testId="organization-members-link"
          deniedReason={noOrganization}
          onNavigate={onNavigate}
        />
        <MenuLinkItem
          to="/organization/settings"
          label="Organization settings"
          testId="organization-settings-link"
          deniedReason={noOrganization}
          onNavigate={onNavigate}
        />
        <MenuLinkItem
          to="/organization/audit"
          label="Audit log"
          testId="organization-audit-link"
          deniedReason={noOrganization ?? organizationAuditDenied}
          onNavigate={onNavigate}
        />
        <MenuLinkItem
          to="/projects/new"
          label="New project"
          testId="new-project-link"
          deniedReason={noOrganization ?? newProjectDenied}
          onNavigate={onNavigate}
        />
        <Dropdown.Divider />
        <MenuLinkItem
          to="/organizations/new"
          label="New organization"
          testId="new-organization-link"
          deniedReason={newOrganizationDenied}
          onNavigate={onNavigate}
        />
      </Dropdown.Menu>
    </Dropdown>
  );
}
