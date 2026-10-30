import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Form } from "../../ui";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import { type BotSectionProps, editBot } from "./IdentitySection";

/** The longest half-life `bot:edit` accepts, in days: ten years. */
export const MAX_HALF_LIFE_DAYS = 3650;

/**
 * Whether a half-life field holds a value `bot:edit` takes.
 * @param text - The field's text.
 * @returns The whole number of days from 1 to {@link MAX_HALF_LIFE_DAYS}, or `null`.
 */
export function parseHalfLife(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const n = Number(text.trim());
  return n >= 1 && n <= MAX_HALF_LIFE_DAYS ? n : null;
}

/**
 * How fast the bot's memories fade with disuse: the half-life of its channel
 * memory, which the decay clock eventually forgets, and of the project's
 * shared memory as this bot ranks it, which only fades in ranking. Both save
 * together; the explorer is a link away.
 * @param props - See {@link BotSectionProps}.
 * @returns The section.
 */
export function MemorySection({
  projectId,
  bot,
  denied,
  onSaved,
}: BotSectionProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [channel, setChannel] = useState(String(bot.memoryChannelHalfLifeDays));
  const [project, setProject] = useState(String(bot.memoryProjectHalfLifeDays));
  const locked = denied !== undefined;

  useEffect(() => {
    setChannel(String(bot.memoryChannelHalfLifeDays));
    setProject(String(bot.memoryProjectHalfLifeDays));
  }, [bot]);

  const channelChanged =
    channel.trim() !== String(bot.memoryChannelHalfLifeDays);
  const projectChanged =
    project.trim() !== String(bot.memoryProjectHalfLifeDays);

  /** Save whichever half-lives changed. */
  async function onSave() {
    const channelDays = parseHalfLife(channel);
    const projectDays = parseHalfLife(project);
    if (channelDays === null || projectDays === null) {
      setError(
        `A half-life is a whole number of days from 1 to ${MAX_HALF_LIFE_DAYS}.`,
      );
      return;
    }
    const fields: Record<string, unknown> = {};
    if (channelChanged) fields.memoryChannelHalfLifeDays = channelDays;
    if (projectChanged) fields.memoryProjectHalfLifeDays = projectDays;
    await save(async () => {
      onSaved(await editBot(projectId, bot.id, fields));
    }, "Saved.");
  }

  return (
    <SectionCard
      title="Memory"
      testId="bot-memory"
      idPrefix="bot"
      intro={
        <>
          A memory nobody uses fades: it loses half its weight in search every
          half-life, and a channel memory that fades far enough unread is
          forgotten. Pinned memories never fade. See what {bot.name} remembers
          in its{" "}
          <Link to={`/bots/${bot.id}/memory`} data-testid="bot-memory-link">
            memory explorer
          </Link>
          .
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      onSave={onSave}
      canSave={channelChanged || projectChanged}
      saveDeniedReason={denied}
      busy={busy}
    >
      <div className="bot-budget-fields">
        <Form.Group controlId="bot-memory-channel" className="mb-0">
          <Form.Label>Channel memory half-life (days)</Form.Label>
          <Form.Control
            size="sm"
            type="number"
            min={1}
            max={MAX_HALF_LIFE_DAYS}
            step={1}
            className="settings-input tabular"
            placeholder="30"
            value={channel}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => {
              setChannel(e.target.value);
              setNotice(null);
            }}
            data-testid="bot-memory-channel"
          />
        </Form.Group>
        <Form.Group controlId="bot-memory-project" className="mb-0">
          <Form.Label>Project memory half-life (days)</Form.Label>
          <Form.Control
            size="sm"
            type="number"
            min={1}
            max={MAX_HALF_LIFE_DAYS}
            step={1}
            className="settings-input tabular"
            placeholder="180"
            value={project}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => {
              setProject(e.target.value);
              setNotice(null);
            }}
            data-testid="bot-memory-project"
          />
        </Form.Group>
      </div>
    </SectionCard>
  );
}
