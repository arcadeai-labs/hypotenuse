import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GatedButton } from "../../components/GatedButton";
import { useOrganization } from "../../components/organization/context";
import { SectionCard } from "../../components/sections/SectionCard";
import { useSectionSave } from "../../components/sections/useSectionSave";
import { useAuth } from "../../context/AuthContext";
import { Form } from "../../ui";
import { apiFetch } from "../../utils/client";

/**
 * `/organization/settings` — the organization's name and slug, and deleting
 * it. Both are an owner's; a member sees the same controls disabled, with the
 * reason. An organization that still has projects cannot be deleted, and the
 * control says so before the server has to.
 * @returns The page.
 */
export function OrganizationSettingsPage() {
  const { organizationId, organization, reason, reloadOrganization } =
    useOrganization();
  const { refresh, projects } = useAuth();
  const navigate = useNavigate();
  const general = useSectionSave();
  const danger = useSectionSave();
  const [name, setName] = useState(organization.name);
  const [slug, setSlug] = useState(organization.slug);
  const [confirmText, setConfirmText] = useState("");
  const editDenied = reason("organization:edit");
  const deleteDenied = reason("organization:delete");

  useEffect(() => {
    setName(organization.name);
    setSlug(organization.slug);
  }, [organization.name, organization.slug]);

  /** Save whichever of name and slug changed. */
  async function onSave() {
    const body: { name?: string; slug?: string } = {};
    if (name.trim() !== organization.name) body.name = name.trim();
    if (slug.trim() !== organization.slug) body.slug = slug.trim();
    const ok = await general.save(
      () =>
        apiFetch(`/organization/${organizationId}`, {
          method: "POST",
          body: JSON.stringify(body),
        }),
      "Organization saved.",
    );
    if (!ok) return;
    await Promise.all([refresh(), reloadOrganization()]);
  }

  /** Delete the organization, then re-hydrate onto another one. */
  async function onDelete() {
    const ok = await danger.save(
      () => apiFetch(`/organization/${organizationId}`, { method: "DELETE" }),
      "Organization deleted.",
    );
    if (!ok) return;
    await refresh();
    navigate("/organization/projects");
  }

  const changed =
    (name.trim() !== organization.name && name.trim() !== "") ||
    (slug.trim() !== organization.slug && slug.trim() !== "");
  const hasProjects = projects.length > 0;

  return (
    <>
      <SectionCard
        title="General"
        testId="organization-general"
        idPrefix="organization"
        cardTestId="organization-general-card"
        error={general.error}
        notice={general.notice}
        onDismissError={() => general.setError(null)}
        onDismissNotice={() => general.setNotice(null)}
        onSave={onSave}
        canSave={changed}
        saveDeniedReason={editDenied}
        busy={general.busy}
      >
        <Form.Group controlId="organization-name" className="mb-3">
          <Form.Label>Name</Form.Label>
          <Form.Control
            className="settings-input"
            value={name}
            disabled={general.busy || editDenied !== undefined}
            title={editDenied}
            onChange={(e) => setName(e.target.value)}
            data-testid="organization-name"
          />
        </Form.Group>
        <Form.Group controlId="organization-slug">
          <Form.Label>Slug</Form.Label>
          <Form.Control
            className="settings-input mono"
            value={slug}
            disabled={general.busy || editDenied !== undefined}
            title={editDenied}
            onChange={(e) => setSlug(e.target.value)}
            data-testid="organization-slug"
          />
          <Form.Text className="text-muted">
            Lowercase letters, numbers, and dashes; unique across Hypotenuse.
          </Form.Text>
        </Form.Group>
      </SectionCard>

      <SectionCard
        title="Danger zone"
        testId="organization-danger"
        idPrefix="organization"
        cardTestId="organization-danger-card"
        error={danger.error}
        notice={danger.notice}
        onDismissError={() => danger.setError(null)}
        onDismissNotice={() => danger.setNotice(null)}
      >
        <p className="text-muted">
          {hasProjects
            ? `${organization.name} still has projects. Delete each of them first; then the organization can be deleted.`
            : `Deleting ${organization.name} removes its members and invites. It cannot be undone. Type its name to confirm.`}
        </p>
        <div className="d-flex gap-2 flex-wrap">
          <Form.Label visuallyHidden htmlFor="delete-organization-name">
            Organization name, to confirm
          </Form.Label>
          <Form.Control
            id="delete-organization-name"
            size="sm"
            className="w-auto"
            placeholder={organization.name}
            value={confirmText}
            disabled={deleteDenied !== undefined || hasProjects}
            title={deleteDenied}
            onChange={(e) => setConfirmText(e.target.value)}
            data-testid="delete-organization-name"
          />
          <GatedButton
            size="sm"
            variant="danger"
            disabled={danger.busy || confirmText !== organization.name}
            deniedReason={
              deleteDenied ??
              (hasProjects ? "Delete its projects first." : undefined)
            }
            onClick={onDelete}
            data-testid="delete-organization-confirm"
          >
            Delete organization
          </GatedButton>
        </div>
      </SectionCard>
    </>
  );
}
