import type { OrganizationCreate } from "@backend/actions/organization/organization-create";
import type { ActionResponse } from "keryx";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GatedButton } from "../components/GatedButton";
import { PageHeader } from "../components/shell/PageHeader";
import { useAuth } from "../context/AuthContext";
import { Alert, Card, Form } from "../ui";
import { apiFetch } from "../utils/client";

/**
 * `/organizations/new` — start a new organization. Anyone signed in may; they
 * become its owner. It starts with no projects, so this lands on its Projects
 * page, where the owner creates the first one.
 * @returns The page.
 */
export function NewOrganizationPage() {
  const { refresh, setActiveOrganization } = useAuth();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Create the organization, re-read the session, make it active, and open
   * its Projects page.
   * @param event - The form's submit event.
   */
  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<ActionResponse<OrganizationCreate>>(
        "/organization",
        { method: "PUT", body: JSON.stringify({ name: name.trim() }) },
      );
      await refresh();
      await setActiveOrganization(res.organization.id);
      navigate("/organization/projects");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page" data-testid="new-organization-page">
      <PageHeader title="New organization" />
      <Card className="page-narrow">
        <Card.Body>
          {error && (
            <Alert variant="danger" data-testid="new-organization-error">
              {error}
            </Alert>
          )}
          <Form onSubmit={onSubmit} noValidate>
            <Form.Group controlId="new-organization-name" className="mb-3">
              <Form.Label>Name</Form.Label>
              <Form.Control
                value={name}
                placeholder="Acme"
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
                data-testid="new-organization-name"
              />
              <Form.Text className="text-muted">
                An organization holds members and projects. You become its
                owner, and create its first project next.
              </Form.Text>
            </Form.Group>
            <GatedButton
              type="submit"
              variant="primary"
              disabled={busy || name.trim().length < 3}
              data-testid="new-organization-submit"
            >
              Create organization
            </GatedButton>
          </Form>
        </Card.Body>
      </Card>
    </div>
  );
}
