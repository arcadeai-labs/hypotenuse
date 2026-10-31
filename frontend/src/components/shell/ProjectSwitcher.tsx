import { ChevronsUpDown } from "lucide-react";
import { Dropdown } from "../../ui";
import { MenuLinkItem } from "./MenuLinkItem";
import type { ShellProject } from "./shellData";

/** See {@link ProjectSwitcher}. */
export interface ProjectSwitcherProps {
  projects: ShellProject[];
  activeProjectId: number | null;
  /** Make a project active. */
  onSelect: (projectId: number) => void;
  /** Why the project's audit log is refused, or `undefined` when it is offered. */
  auditLogDenied?: string;
  /** Why the project's platform events are refused, or `undefined` when they are offered. */
  eventsDenied?: string;
  /** Called after a choice (the mobile sheet closes on it). */
  onNavigate?: () => void;
}

/**
 * The sidebar's project switcher: every project of the active organization
 * the person can see — the ones they belong to, or all of them for an owner —
 * then the active project's audit log and its platform events, an admin's,
 * each drawn disabled with the reason for everyone else.
 * @param props - See {@link ProjectSwitcherProps}.
 * @returns The switcher.
 */
export function ProjectSwitcher({
  projects,
  activeProjectId,
  onSelect,
  auditLogDenied,
  eventsDenied,
  onNavigate,
}: ProjectSwitcherProps) {
  const active = projects.find((p) => p.id === activeProjectId);
  return (
    <Dropdown className="shell-project-switcher" data-testid="project-switcher">
      <Dropdown.Toggle
        className="shell-project"
        data-testid="project-switcher-toggle"
        title={active?.name}
      >
        <span className="shell-project-name">
          {active?.name ?? "No project"}
        </span>
        <ChevronsUpDown size={14} aria-hidden="true" />
      </Dropdown.Toggle>
      <Dropdown.Menu>
        <Dropdown.Header>Projects</Dropdown.Header>
        {projects.map((project) => (
          <Dropdown.Item
            key={project.id}
            active={project.id === activeProjectId}
            aria-current={project.id === activeProjectId ? "true" : undefined}
            onClick={() => {
              onSelect(project.id);
              onNavigate?.();
            }}
            data-testid={`project-option-${project.id}`}
          >
            {project.name}
          </Dropdown.Item>
        ))}
        {projects.length === 0 && (
          <Dropdown.Item disabled data-testid="project-none">
            No projects you can see
          </Dropdown.Item>
        )}
        <Dropdown.Divider />
        <MenuLinkItem
          to="/audit"
          label="Audit log"
          testId="project-audit-link"
          deniedReason={active ? auditLogDenied : "No project selected"}
          onNavigate={onNavigate}
        />
        <MenuLinkItem
          to="/events"
          label="Events"
          testId="project-events-link"
          deniedReason={active ? eventsDenied : "No project selected"}
          onNavigate={onNavigate}
        />
      </Dropdown.Menu>
    </Dropdown>
  );
}
