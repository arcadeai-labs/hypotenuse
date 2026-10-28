import { useNavigate } from "react-router-dom";
import { GatedButton } from "../../components/GatedButton";
import { useOrganization } from "../../components/organization/context";
import { SectionCard } from "../../components/sections/SectionCard";
import { useAuth } from "../../context/AuthContext";
import { Button, Table } from "../../ui";

/**
 * `/organization/projects` — the projects of the active organization the
 * person can see: the ones they belong to, or every one for an owner. New
 * project is an owner's; a member sees it disabled, with the reason.
 * @returns The page.
 */
export function OrganizationProjectsPage() {
  const { organization, standing, reason } = useOrganization();
  const { projects, activeProjectId, setActiveProject } = useAuth();
  const navigate = useNavigate();
  const newProjectDenied = reason("project:create");

  /**
   * Make a project active and open its settings.
   * @param projectId - The project.
   */
  function open(projectId: number) {
    setActiveProject(projectId);
    navigate("/settings/general");
  }

  return (
    <SectionCard
      title="Projects"
      testId="organization-projects"
      idPrefix="organization"
      cardTestId="organization-projects-card"
      intro={
        standing.isOwner ? (
          <>
            As an owner you see every project in {organization.name}, and have
            admin standing in each of them.
          </>
        ) : (
          <>
            You see the projects of {organization.name} you belong to. An admin
            of another one can invite you to it.
          </>
        )
      }
    >
      <div className="d-flex justify-content-between align-items-center mb-3">
        <span className="text-meta" data-testid="organization-project-count">
          {projects.length === 1 ? "1 project" : `${projects.length} projects`}
        </span>
        <GatedButton
          onClick={() => navigate("/projects/new")}
          size="sm"
          variant="primary"
          deniedReason={newProjectDenied}
          data-testid="organization-new-project"
        >
          New project
        </GatedButton>
      </div>
      <Table hover responsive size="sm" data-testid="organization-projects">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Slug</th>
            <th scope="col">Created</th>
            <th scope="col" className="text-end">
              <span className="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {projects.map((project) => (
            <tr
              key={project.id}
              data-testid={`organization-project-${project.id}`}
            >
              <td>
                {project.name}
                {project.id === activeProjectId && (
                  <span className="text-meta"> · active</span>
                )}
              </td>
              <td className="mono">{project.slug}</td>
              <td className="tabular">
                {new Date(project.createdAt).toLocaleDateString()}
              </td>
              <td className="text-end">
                <Button
                  size="sm"
                  variant="outline-secondary"
                  onClick={() => open(project.id)}
                  data-testid={`open-project-${project.id}`}
                >
                  Open settings
                </Button>
              </td>
            </tr>
          ))}
          {projects.length === 0 && (
            <tr>
              <td colSpan={4} className="text-muted" data-testid="no-projects">
                {standing.isOwner
                  ? "No projects yet. Create one with New project."
                  : "You belong to no project here yet. Ask an admin of one to invite you."}
              </td>
            </tr>
          )}
        </tbody>
      </Table>
    </SectionCard>
  );
}
