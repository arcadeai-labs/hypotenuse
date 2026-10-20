import { ChevronsUpDown } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../../context/AuthContext";
import { Dropdown } from "../../ui";

/**
 * The sidebar's project switcher: every project the person belongs to, and the
 * project-scoped pages that are not destinations of their own — invites, the
 * audit log, and creating another project.
 *
 * The audit log is listed for everyone rather than gated on `can()`: the
 * switcher has no standing of its own, and the page owns its admin gate and
 * says so. ⌘K's "Open audit log" is the gated twin.
 * @param props - `onNavigate`, called after a choice (the mobile sheet closes on it).
 * @returns The switcher.
 */
export function ProjectSwitcher({ onNavigate }: { onNavigate?: () => void }) {
  const { projects, activeProjectId, setActiveProject } = useAuth();
  const navigate = useNavigate();
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
            onClick={() => {
              setActiveProject(project.id);
              navigate("/home");
              onNavigate?.();
            }}
            data-testid={`project-option-${project.id}`}
          >
            {project.name}
          </Dropdown.Item>
        ))}
        <Dropdown.Divider />
        <Dropdown.Item
          as={Link}
          to="/invites"
          onClick={onNavigate}
          data-testid="invites-link"
        >
          Invites
        </Dropdown.Item>
        <Dropdown.Item
          as={Link}
          to="/audit"
          onClick={onNavigate}
          data-testid="audit-link"
        >
          Audit log
        </Dropdown.Item>
        <Dropdown.Item
          as={Link}
          to="/projects/new"
          onClick={onNavigate}
          data-testid="new-project-link"
        >
          New project
        </Dropdown.Item>
      </Dropdown.Menu>
    </Dropdown>
  );
}
