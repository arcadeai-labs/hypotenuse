import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../../../context/AuthContext";
import { Form } from "../../../ui";
import { apiFetch } from "../../../utils/client";
import { GatedButton } from "../../GatedButton";
import { SectionCard } from "../../sections/SectionCard";
import { useSectionSave } from "../../sections/useSectionSave";
import { useProjectSettings } from "../context";

/**
 * Deleting the project, behind typing its name. A member sees the same
 * controls, disabled, with the reason.
 * @returns The section.
 */
export function DangerZoneSection() {
  const { projectId, project, reason } = useProjectSettings();
  const { refresh } = useAuth();
  const navigate = useNavigate();
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [confirmText, setConfirmText] = useState("");
  const denied = reason("project:delete");

  /** Delete the project, re-hydrate onto a surviving one, and leave. */
  async function onDelete() {
    const ok = await save(
      () => apiFetch(`/project/${projectId}`, { method: "DELETE" }),
      "Project deleted.",
    );
    if (!ok) return;
    // Awaited before navigating, so the active project has already healed
    // onto one that exists rather than re-reading the one just deleted.
    await refresh();
    navigate("/organization/projects");
  }

  return (
    <SectionCard
      title="Danger zone"
      testId="danger"
      idPrefix="settings"
      cardTestId="danger-card"
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
    >
      <p className="text-muted">
        Deleting <strong>{project.name}</strong> deletes its tags, memberships,
        invites, and settings. It cannot be undone. Type the project's name to
        confirm.
      </p>
      <div className="d-flex gap-2 flex-wrap">
        <Form.Label visuallyHidden htmlFor="delete-project-name">
          Project name, to confirm
        </Form.Label>
        <Form.Control
          id="delete-project-name"
          size="sm"
          className="w-auto"
          placeholder={project.name}
          value={confirmText}
          disabled={denied !== undefined}
          title={denied}
          onChange={(e) => setConfirmText(e.target.value)}
          data-testid="delete-project-name"
        />
        <GatedButton
          size="sm"
          variant="danger"
          disabled={busy || confirmText !== project.name}
          deniedReason={denied}
          onClick={onDelete}
          data-testid="delete-project-confirm"
        >
          Delete project
        </GatedButton>
      </div>
    </SectionCard>
  );
}
