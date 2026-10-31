import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Form } from "../../ui";
import { apiFetch } from "../../utils/client";
import { pinLabel, skillUsage } from "../../utils/prompts";
import { GatedButton } from "../GatedButton";
import type {
  BotSkill,
  BotSkillsResponse,
  SkillsResponse,
} from "../prompts/data";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import type { Bot } from "./data";

/** See {@link SkillsSection}. */
export interface SkillsSectionProps {
  projectId: number;
  bot: Bot;
  /** Why the person may not change its skills, or `undefined`. */
  denied: string | undefined;
}

/**
 * The project's skills this bot may use. An attached skill is named in its
 * prompt with its one-line description; the bot runs it with `use_skill`,
 * and a person runs it by starting a message with `/<name>`. Each follows
 * the skill's latest version unless pinned to one, so a change to the
 * library reaches a pinned bot only when someone moves the pin.
 * @param props - See {@link SkillsSectionProps}.
 * @returns The section.
 */
export function SkillsSection({ projectId, bot, denied }: SkillsSectionProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [attached, setAttached] = useState<BotSkill[] | null>(null);
  const [library, setLibrary] = useState<SkillsResponse["skills"] | null>(null);
  const [adding, setAdding] = useState("");
  const base = `/project/${projectId}/bot/${bot.id}`;

  const reload = useCallback(async () => {
    try {
      const [mine, all] = await Promise.all([
        apiFetch<BotSkillsResponse>(`${base}/skills?limit=100`),
        apiFetch<SkillsResponse>(`/project/${projectId}/skills?limit=100`),
      ]);
      setAttached(mine.botSkills);
      setLibrary(all.skills);
    } catch (err) {
      setAttached((current) => current ?? []);
      setError(err instanceof Error ? err.message : "Could not load skills.");
    }
  }, [base, projectId, setError]);

  useEffect(() => {
    reload();
  }, [reload]);

  const has = new Set(attached?.map((b) => b.skillId));
  const offered = (library ?? []).filter((s) => !has.has(s.id));

  /**
   * Attach a skill, or move its pin.
   * @param skillId - The skill.
   * @param pinnedVersion - The version to use, or `null` for the latest.
   * @param success - What to say when it worked.
   * @returns Whether it worked.
   */
  async function attach(
    skillId: number,
    pinnedVersion: number | null,
    success: string,
  ): Promise<boolean> {
    const ok = await save(
      () =>
        apiFetch(`${base}/skill`, {
          method: "PUT",
          body: JSON.stringify({ skillId, pinnedVersion }),
        }),
      success,
    );
    if (ok) await reload();
    return ok;
  }

  /**
   * Detach a skill.
   * @param binding - The attachment.
   */
  async function onDetach(binding: BotSkill) {
    const ok = await save(
      () => apiFetch(`${base}/skill/${binding.skillId}`, { method: "DELETE" }),
      `${bot.name} no longer has /${binding.name}.`,
    );
    if (ok) await reload();
  }

  return (
    <SectionCard
      title="Skills"
      testId="bot-skills"
      idPrefix="bot"
      intro={
        <>
          Procedures from the project's{" "}
          <Link to="/settings/skills">skill library</Link> this bot may use. It
          sees each by name and description, runs one with{" "}
          <span className="mono">use_skill</span>, and a person runs one by
          starting a message with <span className="mono">/name</span>.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      loading={attached === null && error === null}
      loadingBlocks={2}
    >
      {attached?.length === 0 && (
        <p className="text-muted" data-testid="bot-skills-empty">
          {bot.name} has no skills.{" "}
          {library?.length === 0
            ? "Anyone in the project can write one in Settings → Skills."
            : "Attach one below."}
        </p>
      )}
      <ul className="bot-skill-list" data-testid="bot-skill-list">
        {attached?.map((binding) => (
          <li
            key={binding.id}
            className="bot-skill"
            data-testid={`bot-skill-${binding.name}`}
          >
            <div className="bot-skill-head">
              <span className="mono bot-skill-usage">
                {skillUsage(binding)}
              </span>
              <span
                className="text-meta tabular"
                data-testid={`bot-skill-version-${binding.name}`}
              >
                {pinLabel(binding)}
              </span>
            </div>
            <p className="bot-skill-description">{binding.description}</p>
            <div className="bot-skill-controls">
              <Form.Group
                controlId={`bot-skill-pin-${binding.skillId}`}
                className="mb-0"
              >
                <Form.Label visuallyHidden>
                  Which version of /{binding.name} it uses
                </Form.Label>
                <Form.Select
                  size="sm"
                  className="settings-input"
                  value={binding.pinnedVersion ?? ""}
                  disabled={busy || denied !== undefined}
                  title={denied}
                  onChange={(e) => {
                    const pinned =
                      e.target.value === "" ? null : Number(e.target.value);
                    attach(
                      binding.skillId,
                      pinned,
                      pinned === null
                        ? `${bot.name} follows the latest /${binding.name}.`
                        : `${bot.name} uses version ${pinned} of /${binding.name}.`,
                    );
                  }}
                  data-testid={`bot-skill-pin-${binding.name}`}
                >
                  <option value="">Follow the latest</option>
                  {Array.from(
                    { length: binding.currentVersion },
                    (_, i) => binding.currentVersion - i,
                  ).map((v) => (
                    <option key={v} value={v}>
                      Pin to version {v}
                    </option>
                  ))}
                </Form.Select>
              </Form.Group>
              <GatedButton
                size="sm"
                variant="outline-danger"
                disabled={busy}
                deniedReason={denied}
                aria-label={`Detach /${binding.name} from ${bot.name}`}
                onClick={() => onDetach(binding)}
                data-testid={`bot-skill-detach-${binding.name}`}
              >
                Detach
              </GatedButton>
            </div>
          </li>
        ))}
      </ul>

      <Form
        className="bot-tools-add"
        onSubmit={async (e) => {
          e.preventDefault();
          const skill = offered.find((s) => String(s.id) === adding);
          if (!skill) return;
          if (
            await attach(
              skill.id,
              null,
              `${bot.name} has /${skill.name}, at its latest version.`,
            )
          )
            setAdding("");
        }}
      >
        <Form.Group controlId="bot-skills-add" className="mb-0">
          <Form.Label>Attach a skill</Form.Label>
          <Form.Select
            size="sm"
            className="settings-input"
            value={adding}
            disabled={busy || denied !== undefined || offered.length === 0}
            title={denied}
            onChange={(e) => setAdding(e.target.value)}
            data-testid="bot-skills-add-select"
          >
            <option value="">
              {offered.length === 0
                ? "No other skills in this project"
                : "Choose a skill"}
            </option>
            {offered.map((s) => (
              <option key={s.id} value={s.id}>
                /{s.name} — {s.description}
              </option>
            ))}
          </Form.Select>
        </Form.Group>
        <GatedButton
          size="sm"
          type="submit"
          variant="outline-primary"
          disabled={busy || adding === ""}
          deniedReason={denied}
          data-testid="bot-skills-add-submit"
        >
          Attach
        </GatedButton>
      </Form>
    </SectionCard>
  );
}
