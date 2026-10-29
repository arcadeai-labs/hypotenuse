import type { ProjectCreate } from "@backend/actions/project/project-create";
import type { ActionResponse } from "keryx";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GatedButton } from "../components/GatedButton";
import { PageHeader } from "../components/shell/PageHeader";
import { useAuth } from "../context/AuthContext";
import { useMay } from "../hooks/useMay";
import { Alert, Card, Form } from "../ui";
import { apiFetch } from "../utils/client";

/**
 * `/projects/new` — create a project in the active organization. Only an
 * owner may; a member sees the form disabled, with the reason, and the way
 * forward. The creator becomes the new project's first admin, and it becomes
 * the active project.
 * @returns The page.
 */
export function NewProjectPage() {
  const { organizations, activeOrganizationId, refresh, setActiveProject } =
    useAuth();
  const { reason } = useMay();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const organization = organizations.find((o) => o.id === activeOrganizationId);
  const denied = organization
    ? reason("project:create")
    : "Choose an organization first.";

  /**
   * Create the project, re-read the session, and open its settings.
   * @param event - The form's submit event.
   */
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!organization || denied) return;
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<ActionResponse<ProjectCreate>>("/project", {
        method: "PUT",
        body: JSON.stringify({
          organizationId: organization.id,
          name: name.trim(),
        }),
      });
      await refresh();
      setActiveProject(res.project.id);
      navigate("/settings/general");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" data-testid="new-project-page">
      <PageHeader title="New project" />
      <Card className="page-narrow">
        <Card.Body>
          {error && (
            <Alert variant="danger" data-testid="new-project-error">
              {error}
            </Alert>
          )}
          {denied && organization && (
            <Alert variant="info" data-testid="new-project-denied">
              {denied} Ask an owner of {organization.name} to create the project
              and add you to it.
            </Alert>
          )}
          <Form onSubmit={onSubmit} noValidate>
            <Form.Group controlId="new-project-organization" className="mb-3">
              <Form.Label>Organization</Form.Label>
              <Form.Control
                plaintext
                readOnly
                value={organization?.name ?? "None"}
              />
            </Form.Group>
            <Form.Group controlId="new-project-name" className="mb-3">
              <Form.Label>Name</Form.Label>
              <Form.Control
                value={name}
                placeholder="Support"
                disabled={busy || denied !== undefined}
                title={denied}
                onChange={(e) => setName(e.target.value)}
                data-testid="new-project-name"
              />
              <Form.Text className="text-muted">
                A project holds its own bots, members, and memory. You become
                its first admin.
              </Form.Text>
            </Form.Group>
            <GatedButton
              type="submit"
              variant="primary"
              disabled={busy || name.trim().length < 3}
              deniedReason={denied}
              data-testid="new-project-submit"
            >
              Create project
            </GatedButton>
          </Form>
        </Card.Body>
      </Card>
    </div>
  );
}
