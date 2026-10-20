import type { ProjectCreate } from "@backend/actions/project/project-create";
import type { ActionResponse } from "keryx";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import Alert from "../ui/Alert";
import Button from "../ui/Button";
import Card from "../ui/Card";
import Form from "../ui/Form";
import { useAuth } from "../context/AuthContext";
import { apiFetch } from "../utils/client";

/**
 * `/projects/new` — create a project; the caller becomes its admin. Doubles as the
 * zero-projects empty state, which is where {@link ProtectedRoute} sends a user
 * who has none, so it greets a first-timer differently.
 * @returns The rendered page.
 */
export default function NewProjectPage() {
  const { projects, refresh, setActiveProject } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isFirstProject = projects.length === 0;

  /**
   * Create the project, re-hydrate so the switcher sees it, select it, and land on
   * the project page.
   * @param event - The form's submit event.
   */
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length < 3) {
      return setError("Project names are at least 3 characters.");
    }
    setError(null);
    setSaving(true);
    try {
      const { project } = await apiFetch<ActionResponse<ProjectCreate>>(
        "/project",
        { method: "PUT", body: JSON.stringify({ name: trimmed }) },
      );
      await refresh();
      setActiveProject(project.id);
      navigate("/home");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not create the project.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <h1 className="mt-3">{isFirstProject ? "Welcome" : "New project"}</h1>
      <span className="tx-rule" aria-hidden="true" />

      {isFirstProject && (
        <p className="tx-muted">
          A project holds agents, secrets, and the teammates you invite.
        </p>
      )}

      <Card className="tx-auth-card" data-testid="new-project-card">
        <Card.Header as="h2">Project name</Card.Header>
        <Card.Body>
          {error && (
            <Alert variant="danger" data-testid="form-error">
              {error}
            </Alert>
          )}
          <Form onSubmit={onSubmit} noValidate>
            <Form.Group className="mb-3" controlId="new-project-name">
              <Form.Label>Name</Form.Label>
              <Form.Control
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                data-testid="new-project-name"
                required
              />
              <Form.Text>At least 3 characters.</Form.Text>
            </Form.Group>
            <Button
              type="submit"
              variant="primary"
              disabled={saving}
              data-testid="new-project-submit"
            >
              {saving ? "Creating…" : "Create project"}
            </Button>
          </Form>
        </Card.Body>
      </Card>
    </>
  );
}
