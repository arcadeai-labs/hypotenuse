import { useEffect, useState } from "react";
import { useAuth } from "../../../context/AuthContext";
import { Form } from "../../../ui";
import { apiFetch } from "../../../utils/client";
import { SectionCard } from "../../sections/SectionCard";
import { useSectionSave } from "../../sections/useSectionSave";
import { useProjectSettings } from "../context";

/**
 * The project's name — the landing section, and the one thing about a project
 * every member can see and an admin can change. A member sees the same field,
 * disabled, with the reason on it.
 * @returns The section.
 */
export function GeneralSection() {
  const { projectId, project, reason, reloadProject } = useProjectSettings();
  const { refresh } = useAuth();
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const denied = reason("project:edit");
  const [name, setName] = useState(project.name);

  // Re-seed only when the server's name changes (a save, or another project).
  useEffect(() => {
    setName(project.name);
  }, [project.name]);

  /** Rename the project, then re-read so the switcher agrees. */
  async function onSave() {
    const ok = await save(
      () =>
        apiFetch(`/project/${projectId}`, {
          method: "POST",
          body: JSON.stringify({ name: name.trim() }),
        }),
      "Project renamed.",
    );
    if (!ok) return;
    await Promise.all([refresh(), reloadProject()]);
  }

  const trimmed = name.trim();

  return (
    <SectionCard
      title="General"
      testId="general"
      idPrefix="settings"
      cardTestId="project-name-card"
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      onSave={onSave}
      saveLabel="Rename"
      canSave={trimmed !== "" && trimmed !== project.name}
      saveDeniedReason={denied}
      busy={busy}
    >
      <Form.Group controlId="project-name">
        <Form.Label>Project name</Form.Label>
        <Form.Control
          className="settings-input"
          value={name}
          disabled={busy || denied !== undefined}
          title={denied}
          onChange={(e) => setName(e.target.value)}
          data-testid="project-name"
        />
        <Form.Text className="text-muted">
          {denied ??
            "Shown in the switcher, in invites, and at the top of this page."}
        </Form.Text>
      </Form.Group>
      <dl className="settings-facts">
        <dt>Slug</dt>
        <dd className="mono" data-testid="project-slug">
          {project.slug}
        </dd>
      </dl>
    </SectionCard>
  );
}
