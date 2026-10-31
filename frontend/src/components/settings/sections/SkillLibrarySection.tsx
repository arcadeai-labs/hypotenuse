import { ChevronDown, ChevronRight } from "lucide-react";
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Table } from "../../../ui";
import { apiFetch } from "../../../utils/client";
import { describeAccess } from "../../../utils/models";
import { skillUsage } from "../../../utils/prompts";
import { useAccessTags, useRead } from "../../bots/data";
import { ConfirmDialog } from "../../ConfirmDialog";
import { DiffBlock } from "../../DiffBlock";
import { GatedButton } from "../../GatedButton";
import { diffStats, lineDiff } from "../../memory/model";
import type {
  SkillDetail,
  SkillRow,
  SkillsResponse,
  SkillVersionsResponse,
} from "../../prompts/data";
import { SkeletonRows } from "../../SkeletonRows";
import { SectionCard } from "../../sections/SectionCard";
import { useSectionSave } from "../../sections/useSectionSave";
import {
  EMPTY_SKILL,
  SkillEditor,
  skillBody,
  skillDraft,
} from "../../skills/SkillEditor";
import { useProjectSettings } from "../context";

/** Why a member may not change a skill whose write list leaves them out. */
export const SKILL_WRITE_DENIED =
  "Your tags do not include one of this skill's write access tags. Ask someone who holds one, or an admin.";

/**
 * Settings → Skills: the project's library of skills — reusable procedures
 * with arguments, which bots are given one by one on their own pages. Any
 * member may write one; each skill's own access lists then decide who sees
 * and who changes it, as a bot's do. Every save is a new version, and a bot
 * pinned to an older one keeps using it.
 * @returns The section.
 */
export function SkillLibrarySection() {
  const { projectId, reason } = useProjectSettings();
  const tags = useAccessTags(projectId);
  const [skills, setSkills] = useState<SkillRow[] | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [formKey, setFormKey] = useState(0);
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const created = useSectionSave();

  const reload = useCallback(async () => {
    try {
      const res = await apiFetch<SkillsResponse>(
        `/project/${projectId}/skills?limit=100`,
      );
      setSkills(res.skills);
    } catch (err) {
      setSkills((current) => current ?? []);
      setError(err instanceof Error ? err.message : "Could not load skills.");
    }
  }, [projectId, setError]);

  useEffect(() => {
    reload();
  }, [reload]);

  const [deleting, setDeleting] = useState<SkillRow | null>(null);

  /** Delete the skill being confirmed. */
  async function onDelete() {
    const target = deleting;
    if (!target) return;
    setDeleting(null);
    const ok = await save(
      () =>
        apiFetch(`/project/${projectId}/skill/${target.id}`, {
          method: "DELETE",
        }),
      `Deleted /${target.name}. Bots that had it no longer do.`,
    );
    if (ok) {
      if (expanded === target.id) setExpanded(null);
      await reload();
    }
  }

  const createDenied = reason("skill:create");
  const editDenied = reason("skill:edit");
  const deleteDenied = reason("skill:delete");

  return (
    <div data-testid="settings-skills">
      <SectionCard
        title="Skills"
        testId="skills"
        idPrefix="settings"
        cardTestId="skills-card"
        intro={
          <>
            A skill is a procedure written once and shared: a name, the
            arguments it takes, and a template. A bot it is attached to sees its
            name and description, and runs it with{" "}
            <span className="mono">use_skill</span>; a person runs it by
            starting a message with <span className="mono">/name</span>. Bots
            never edit skills.
          </>
        }
        error={error}
        notice={notice}
        onDismissError={() => setError(null)}
        onDismissNotice={() => setNotice(null)}
      >
        <Table size="sm" responsive data-testid="skill-list">
          <thead>
            <tr>
              <th scope="col">Skill</th>
              <th scope="col">Version</th>
              <th scope="col">Who may see it</th>
              <th scope="col" className="text-end">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {skills === null && (
              <SkeletonRows
                columns={4}
                rows={2}
                testId="skills-skeleton"
                label="Loading skills"
              />
            )}
            {skills?.length === 0 && (
              <tr>
                <td colSpan={4} className="text-muted" data-testid="no-skills">
                  No skills yet. Write the first one below.
                </td>
              </tr>
            )}
            {skills?.map((skill) => {
              const open = expanded === skill.id;
              const writeDenied =
                editDenied ?? (skill.canWrite ? undefined : SKILL_WRITE_DENIED);
              return (
                <Fragment key={skill.id}>
                  <tr data-testid={`skill-row-${skill.name}`}>
                    <td className="skill-name-cell">
                      <button
                        type="button"
                        className="mcp-server-toggle"
                        aria-expanded={open}
                        onClick={() => setExpanded(open ? null : skill.id)}
                        data-testid={`skill-expand-${skill.name}`}
                      >
                        {open ? (
                          <ChevronDown size={14} aria-hidden="true" />
                        ) : (
                          <ChevronRight size={14} aria-hidden="true" />
                        )}
                        <span className="mono">{skillUsage(skill)}</span>
                      </button>
                      <span className="skill-description">
                        {skill.description}
                      </span>
                    </td>
                    <td className="tabular">v{skill.currentVersion}</td>
                    <td>{describeAccess(skill.accessRead)}</td>
                    <td className="text-end">
                      <GatedButton
                        size="sm"
                        variant="outline-danger"
                        disabled={busy}
                        deniedReason={
                          deleteDenied ??
                          (skill.canWrite ? undefined : SKILL_WRITE_DENIED)
                        }
                        aria-label={`Delete the skill ${skill.name}`}
                        onClick={() => setDeleting(skill)}
                        data-testid={`skill-delete-${skill.name}`}
                      >
                        Delete
                      </GatedButton>
                    </td>
                  </tr>
                  {open && (
                    <tr className="mcp-server-detail-row">
                      <td colSpan={4}>
                        <SkillDetailPanel
                          projectId={projectId}
                          skillId={skill.id}
                          tags={tags}
                          denied={writeDenied}
                          onSaved={reload}
                        />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </Table>
      </SectionCard>

      <SectionCard
        title="Write a skill"
        testId="skills-new"
        idPrefix="settings"
        error={created.error}
        notice={created.notice}
        onDismissError={() => created.setError(null)}
        onDismissNotice={() => created.setNotice(null)}
      >
        <SkillEditor
          key={formKey}
          initial={EMPTY_SKILL}
          tags={tags}
          busy={created.busy}
          denied={createDenied}
          submitLabel="Add skill"
          testId="skill-new"
          onSubmit={async (draft) => {
            let id: number | null = null;
            const ok = await created.save(async () => {
              const res = await apiFetch<{ skill: SkillDetail }>(
                `/project/${projectId}/skill`,
                { method: "PUT", body: JSON.stringify(skillBody(draft)) },
              );
              id = res.skill.id;
            }, `Added /${draft.name.trim().toLowerCase()}. Attach it to a bot on the bot's page.`);
            if (ok) {
              setFormKey((k) => k + 1);
              await reload();
              setExpanded(id);
            }
          }}
        />
      </SectionCard>

      <ConfirmDialog
        show={deleting !== null}
        title={`Delete /${deleting?.name ?? ""}?`}
        confirmLabel="Delete skill"
        busy={busy}
        onConfirm={onDelete}
        onCancel={() => setDeleting(null)}
        testId="skill-delete"
      >
        Every bot it is attached to loses it, including bots pinned to an older
        version.
      </ConfirmDialog>
    </div>
  );
}

/**
 * An opened skill: its template, an editor when the person may change it,
 * and its versions with a diff of each against the one before.
 * @param props - The skill and the section's context.
 * @returns The panel.
 */
function SkillDetailPanel({
  projectId,
  skillId,
  tags,
  denied,
  onSaved,
}: {
  projectId: number;
  skillId: number;
  tags: ReturnType<typeof useAccessTags>;
  denied: string | undefined;
  onSaved: () => Promise<void>;
}) {
  const path = `/project/${projectId}/skill/${skillId}`;
  const detail = useRead<{ skill: SkillDetail }>(path);
  const versions = useRead<SkillVersionsResponse>(`${path}/versions?limit=50`);
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [editing, setEditing] = useState(false);
  const [chosen, setChosen] = useState<number | null>(null);
  const skill = detail.data?.skill ?? null;
  const list = versions.data?.versions ?? [];
  const shown = list.find((v) => v.version === chosen) ?? list[0] ?? null;
  const before = shown
    ? (list.find((v) => v.version === shown.version - 1) ?? null)
    : null;
  const diff = useMemo(
    () =>
      shown && (before || shown.version === 1)
        ? lineDiff(before?.body ?? "", shown.body)
        : null,
    [shown, before],
  );
  const testId = `skill-detail-${skillId}`;

  if (detail.error) {
    return <p className="text-danger mb-0">{detail.error}</p>;
  }
  if (!skill) return <p className="text-meta mb-0">Loading the skill…</p>;

  return (
    <div className="skill-detail" data-testid={`skill-detail-${skill.name}`}>
      {error && (
        <p className="text-danger mb-0" data-testid={`${testId}-error`}>
          {error}
        </p>
      )}
      {notice && (
        <p className="text-success mb-0" data-testid={`${testId}-notice`}>
          {notice}
        </p>
      )}
      {editing ? (
        <SkillEditor
          initial={skillDraft(skill)}
          tags={tags}
          busy={busy}
          denied={denied}
          submitLabel="Save as a new version"
          withChangeNote
          testId={`skill-edit-${skill.name}`}
          onCancel={() => setEditing(false)}
          onSubmit={async (draft) => {
            const ok = await save(
              () =>
                apiFetch(path, {
                  method: "POST",
                  body: JSON.stringify(skillBody(draft)),
                }),
              "Saved.",
            );
            if (ok) {
              setEditing(false);
              setChosen(null);
              await Promise.all([
                detail.reload(),
                versions.reload(),
                onSaved(),
              ]);
            }
          }}
        />
      ) : (
        <>
          <div className="skill-detail-head">
            <span className="text-meta">Template</span>
            <GatedButton
              size="sm"
              variant="outline-secondary"
              disabled={busy}
              deniedReason={denied}
              onClick={() => {
                setEditing(true);
                setError(null);
                setNotice(null);
              }}
              data-testid={`skill-edit-${skill.name}-open`}
            >
              Edit
            </GatedButton>
          </div>
          {skill.arguments.length > 0 && (
            <ul className="skill-detail-args">
              {skill.arguments.map((a) => (
                <li key={a.name}>
                  <span className="mono">${a.name}</span>
                  {a.required ? " (required)" : ""}
                  {a.default !== undefined ? ` — default "${a.default}"` : ""}
                  {a.description ? ` — ${a.description}` : ""}
                </li>
              ))}
            </ul>
          )}
          <pre className="skill-detail-body">{skill.body}</pre>
        </>
      )}

      <div
        className="skill-history"
        data-testid={`skill-history-${skill.name}`}
      >
        <h4 className="prompt-history-diff-title">Versions</h4>
        <ol className="prompt-history-list">
          {list.map((v) => (
            <li
              key={v.id}
              className="prompt-history-version"
              aria-current={shown?.version === v.version ? "true" : undefined}
            >
              <button
                type="button"
                className="prompt-history-pick"
                aria-pressed={shown?.version === v.version}
                onClick={() => setChosen(v.version)}
                data-testid={`skill-history-${skill.name}-v${v.version}`}
              >
                <span className="tabular">v{v.version}</span>
              </button>
              <span className="text-meta tabular">
                {new Date(v.createdAt).toLocaleString()}
              </span>
              {v.changeNote && (
                <span className="prompt-history-note">{v.changeNote}</span>
              )}
            </li>
          ))}
        </ol>
        {shown && diff && (
          <>
            <p className="text-meta mb-0">
              {shown.version === 1
                ? "Version 1, as first written"
                : `Changes from v${shown.version - 1} to v${shown.version}`}{" "}
              <span className="tabular">
                +{diffStats(diff).added} −{diffStats(diff).removed}
              </span>
            </p>
            <DiffBlock diff={diff} testId={`skill-diff-${skill.name}`} />
          </>
        )}
        {shown && shown.description !== skill.description && (
          <p className="text-meta mb-0">
            Its description then: {shown.description}
          </p>
        )}
      </div>
    </div>
  );
}
