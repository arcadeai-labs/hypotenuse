import { ChevronsUpDown } from "lucide-react";
import { Dropdown } from "../../ui";
import type { ShellProject } from "./shellFixtures";

/** See {@link ProjectSwitcher}. */
export interface ProjectSwitcherProps {
  projects: ShellProject[];
  activeProjectId: number | null;
  /** Called after a choice (the mobile sheet closes on it). */
  onNavigate?: () => void;
}

/**
 * The sidebar's project switcher: every project of the active organization
 * the person belongs to.
 * @param props - See {@link ProjectSwitcherProps}.
 * @returns The switcher.
 */
export function ProjectSwitcher({
  projects,
  activeProjectId,
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
            onClick={onNavigate}
            data-testid={`project-option-${project.id}`}
          >
            {project.name}
          </Dropdown.Item>
        ))}
      </Dropdown.Menu>
    </Dropdown>
  );
}
