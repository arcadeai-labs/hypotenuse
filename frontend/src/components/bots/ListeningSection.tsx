import { useEffect, useState } from "react";
import { Form } from "../../ui";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import { type BotSectionProps, editBot } from "./IdentitySection";

/** The kinds of channel a bot may bind itself in, and what each box says. */
const AUTO_BIND_KINDS = [
  {
    key: "public",
    label: "Public channels",
    note: "Anyone in the workspace can read them anyway.",
  },
  {
    key: "private",
    label: "Private channels",
    note: "Off by default: a person binds one, which records who may read it here.",
  },
  {
    key: "dm",
    label: "Direct messages",
    note: "Off by default, for the same reason.",
  },
] as const;

/** The autoBind setting's keys. */
type AutoBind = { public: boolean; private: boolean; dm: boolean };

/**
 * How the bot listens on platforms: whether it starts listening by itself in
 * a channel it is invited to, per kind of channel, and how many messages a
 * minute one person, and one channel, may send it before it ignores the rest
 * of that minute. Saved with `bot:edit`.
 * @param props - See {@link BotSectionProps}.
 * @returns The section.
 */
export function ListeningSection({
  projectId,
  bot,
  denied,
  onSaved,
}: BotSectionProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [autoBind, setAutoBind] = useState<AutoBind>(bot.autoBind);
  const [perPerson, setPerPerson] = useState(String(bot.participantRateLimit));
  const [perChannel, setPerChannel] = useState(String(bot.channelRateLimit));
  const locked = busy || denied !== undefined;

  useEffect(() => {
    setAutoBind(bot.autoBind);
    setPerPerson(String(bot.participantRateLimit));
    setPerChannel(String(bot.channelRateLimit));
  }, [bot]);

  const personLimit = Number(perPerson);
  const channelLimit = Number(perChannel);
  const valid = (n: number) => Number.isInteger(n) && n >= 1 && n <= 10_000;
  const autoChanged = AUTO_BIND_KINDS.some(
    (k) => autoBind[k.key] !== bot.autoBind[k.key],
  );
  const personChanged = personLimit !== bot.participantRateLimit;
  const channelChanged = channelLimit !== bot.channelRateLimit;

  /** Save whichever changed. */
  async function onSave() {
    if (!valid(personLimit) || !valid(channelLimit)) {
      setError("A limit is a whole number from 1 to 10,000 a minute.");
      return;
    }
    await save(async () => {
      onSaved(
        await editBot(projectId, bot.id, {
          ...(autoChanged ? { autoBind } : {}),
          ...(personChanged ? { participantRateLimit: personLimit } : {}),
          ...(channelChanged ? { channelRateLimit: channelLimit } : {}),
        }),
      );
    }, "Saved.");
  }

  return (
    <SectionCard
      title="Listening"
      testId="bot-listening"
      idPrefix="bot"
      intro={
        <>
          Where {bot.name} starts listening by itself when it is invited, and
          how much it takes before it stops answering for the rest of a minute.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      onSave={onSave}
      canSave={autoChanged || personChanged || channelChanged}
      saveDeniedReason={denied}
      busy={busy}
    >
      <fieldset className="bot-listening-auto">
        <legend className="form-label">Binds itself when invited to</legend>
        {AUTO_BIND_KINDS.map((k) => (
          <Form.Check
            key={k.key}
            id={`bot-auto-bind-${k.key}`}
            label={
              <>
                {k.label} <span className="text-meta">— {k.note}</span>
              </>
            }
            checked={autoBind[k.key]}
            disabled={locked}
            title={denied}
            onChange={(e) => {
              setAutoBind({ ...autoBind, [k.key]: e.target.checked });
              setNotice(null);
            }}
            data-testid={`bot-auto-bind-${k.key}`}
          />
        ))}
      </fieldset>
      <div className="bot-budget-fields">
        <Form.Group controlId="bot-participant-rate" className="mb-0">
          <Form.Label>One person, a minute</Form.Label>
          <Form.Control
            size="sm"
            type="number"
            min={1}
            max={10_000}
            className="settings-input"
            value={perPerson}
            disabled={locked}
            title={denied}
            onChange={(e) => {
              setPerPerson(e.target.value);
              setNotice(null);
            }}
            data-testid="bot-participant-rate"
          />
          <Form.Text className="text-meta">
            Messages past it are ignored until the minute ends.
          </Form.Text>
        </Form.Group>
        <Form.Group controlId="bot-channel-rate" className="mb-0">
          <Form.Label>One channel, a minute</Form.Label>
          <Form.Control
            size="sm"
            type="number"
            min={1}
            max={10_000}
            className="settings-input"
            value={perChannel}
            disabled={locked}
            title={denied}
            onChange={(e) => {
              setPerChannel(e.target.value);
              setNotice(null);
            }}
            data-testid="bot-channel-rate"
          />
          <Form.Text className="text-meta">
            Everyone in the channel together.
          </Form.Text>
        </Form.Group>
      </div>
    </SectionCard>
  );
}
