import { Building2, ChevronsUpDown } from "lucide-react";
import { Dropdown } from "../../ui";
import { NOT_AVAILABLE } from "./destinations";
import type { ShellOrganization } from "./shellFixtures";

/** See {@link OrganizationSwitcher}. */
export interface OrganizationSwitcherProps {
  organizations: ShellOrganization[];
  activeOrganizationId: number | null;
  /** Called after a choice (the mobile sheet closes on it). */
  onNavigate?: () => void;
}

/**
 * The sidebar's organization switcher, above the project switcher: every
 * organization the person belongs to, its members, and — for an owner — a new
 * project. Choices whose pages do not exist yet are disabled, not absent.
 * @param props - See {@link OrganizationSwitcherProps}.
 * @returns The switcher.
 */
export function OrganizationSwitcher({
  organizations,
  activeOrganizationId,
  onNavigate,
}: OrganizationSwitcherProps) {
  const active = organizations.find((o) => o.id === activeOrganizationId);
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
            onClick={onNavigate}
            data-testid={`organization-option-${organization.id}`}
          >
            {organization.name}
          </Dropdown.Item>
        ))}
        <Dropdown.Divider />
        <Dropdown.Item
          disabled
          title={NOT_AVAILABLE}
          data-testid="organization-members-link"
        >
          Members
        </Dropdown.Item>
        {active?.owner && (
          <Dropdown.Item
            disabled
            title={NOT_AVAILABLE}
            data-testid="new-project-link"
          >
            New project
          </Dropdown.Item>
        )}
      </Dropdown.Menu>
    </Dropdown>
  );
}
