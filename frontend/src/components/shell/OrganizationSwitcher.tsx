import { Building2, ChevronsUpDown } from "lucide-react";
import { Link } from "react-router-dom";
import { Dropdown } from "../../ui";
import type { ShellOrganization } from "./shellData";

/** See {@link OrganizationSwitcher}. */
export interface OrganizationSwitcherProps {
  organizations: ShellOrganization[];
  activeOrganizationId: number | null;
  /** Make an organization active. */
  onSelect: (organizationId: number) => void;
  /** Why "New project" is refused, or `undefined` when it is offered. */
  newProjectDenied?: string;
  /** Called after a choice (the mobile sheet closes on it). */
  onNavigate?: () => void;
}

/**
 * One menu entry that goes somewhere: a router link while it is offered, a
 * disabled item carrying its reason while it is not. Disabled, never absent,
 * so the menu's shape is the same for every reader.
 * @param props - The destination, label, test id, and refusal.
 * @returns The item.
 */
function LinkItem({
  to,
  label,
  testId,
  deniedReason,
  onNavigate,
}: {
  to: string;
  label: string;
  testId: string;
  deniedReason?: string;
  onNavigate?: () => void;
}) {
  if (deniedReason) {
    return (
      <Dropdown.Item disabled title={deniedReason} data-testid={testId}>
        {label}
      </Dropdown.Item>
    );
  }
  return (
    <Dropdown.Item as={Link} to={to} onClick={onNavigate} data-testid={testId}>
      {label}
    </Dropdown.Item>
  );
}

/**
 * The sidebar's organization switcher, above the project switcher: every
 * organization the person belongs to, then the active one's projects, members,
 * and settings, and New project — which only an owner may use, and which
 * everyone else sees disabled with the reason.
 * @param props - See {@link OrganizationSwitcherProps}.
 * @returns The switcher.
 */
export function OrganizationSwitcher({
  organizations,
  activeOrganizationId,
  onSelect,
  newProjectDenied,
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
        <LinkItem
          to="/organization/projects"
          label="Projects"
          testId="organization-projects-link"
          deniedReason={noOrganization}
          onNavigate={onNavigate}
        />
        <LinkItem
          to="/organization/members"
          label="Members"
          testId="organization-members-link"
          deniedReason={noOrganization}
          onNavigate={onNavigate}
        />
        <LinkItem
          to="/organization/settings"
          label="Organization settings"
          testId="organization-settings-link"
          deniedReason={noOrganization}
          onNavigate={onNavigate}
        />
        <LinkItem
          to="/projects/new"
          label="New project"
          testId="new-project-link"
          deniedReason={noOrganization ?? newProjectDenied}
          onNavigate={onNavigate}
        />
      </Dropdown.Menu>
    </Dropdown>
  );
}
