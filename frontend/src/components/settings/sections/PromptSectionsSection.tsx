import { useCallback } from "react";
import { assemblyOrder, projectSectionDenied } from "../../../utils/prompts";
import { useRead } from "../../bots/data";
import type { PromptSectionsResponse } from "../../prompts/data";
import { NewSectionForm } from "../../prompts/NewSectionForm";
import { PromptSectionCard } from "../../prompts/PromptSectionCard";
import { SectionCard } from "../../sections/SectionCard";
import { useProjectSettings } from "../context";

/**
 * Settings → Prompt sections: the sections every bot in the project includes
 * in its prompt, after its *Identity* and before its own — how the company
 * writes, what every bot must never do. Every member reads them, with their
 * versions; adding, editing, reverting, and deleting are an admin's, and a
 * member sees those controls disabled with the reason. No bot may edit one.
 * @returns The section.
 */
export function PromptSectionsSection() {
  const { projectId, reason, standing } = useProjectSettings();
  const sections = useRead<PromptSectionsResponse>(
    `/project/${projectId}/prompt-sections?limit=100`,
  );
  const { reload } = sections;
  const onChanged = useCallback(async () => {
    await reload();
  }, [reload]);
  const editDenied = projectSectionDenied(
    reason("prompt-section:edit"),
    standing,
  );
  const createDenied = projectSectionDenied(
    reason("prompt-section:create"),
    standing,
  );
  const ordered = sections.data
    ? assemblyOrder(sections.data.promptSections, [])
    : null;

  return (
    <div data-testid="settings-prompt-sections">
      <SectionCard
        title="Prompt sections"
        testId="prompt-sections"
        idPrefix="settings"
        cardTestId="prompt-sections-card"
        intro={
          <>
            Instructions every bot in this project is given, after who it is and
            before its own sections. One that loads always is in every step of
            every bot; a contextual one only when one of its keywords comes up.
            A bot's own sections are on its Prompt page.
          </>
        }
        error={sections.error}
        loading={sections.data === null && sections.error === null}
        loadingBlocks={2}
      >
        {ordered?.length === 0 && (
          <p className="text-muted" data-testid="no-prompt-sections">
            No project sections yet. Every bot's prompt is its own sections
            alone.
          </p>
        )}
        <div className="prompt-section-list">
          {ordered?.map((section, i) => (
            <PromptSectionCard
              key={section.id}
              projectId={projectId}
              section={section}
              place={i + 1}
              denied={editDenied}
              onChanged={onChanged}
            />
          ))}
        </div>
      </SectionCard>
      <SectionCard
        title="Add a project section"
        testId="prompt-sections-new"
        idPrefix="settings"
      >
        <NewSectionForm
          projectId={projectId}
          botId={null}
          denied={createDenied}
          onCreated={onChanged}
        />
      </SectionCard>
    </div>
  );
}
