import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Form } from "../../ui";
import { checkedTags } from "../../utils/models";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import type { ProjectTag } from "./data";
import { type BotSectionProps, editBot } from "./IdentitySection";
import { TagPicker } from "./TagPicker";

/**
 * Whether two tag lists hold the same names, in any order.
 * @param a - One list.
 * @param b - The other.
 * @returns `true` when they match.
 */
function sameTags(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((name) => b.includes(name));
}

/**
 * Who may read the bot (see it, its settings, and later its transcripts), who
 * may change it, and whom it asks for help. These govern the dashboard and
 * the CLI only: who may *talk* to a bot is decided by the platform it is
 * bound in.
 *
 * The server refuses a list that would lock the person saving it out, unless
 * they are an admin; the refusal lands in this card.
 * @param props - See {@link BotSectionProps}, plus the project's tags.
 * @returns The section.
 */
export function AccessSection({
  projectId,
  bot,
  denied,
  onSaved,
  tags,
}: BotSectionProps & { tags: ProjectTag[] | null }) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [accessRead, setAccessRead] = useState(() =>
    checkedTags(bot.accessRead),
  );
  const [accessWrite, setAccessWrite] = useState(() =>
    checkedTags(bot.accessWrite),
  );
  const [helpNotifyTag, setHelpNotifyTag] = useState(bot.helpNotifyTag ?? "");
  const locked = denied !== undefined;

  useEffect(() => {
    setAccessRead(checkedTags(bot.accessRead));
    setAccessWrite(checkedTags(bot.accessWrite));
    setHelpNotifyTag(bot.helpNotifyTag ?? "");
  }, [bot]);

  const readChanged = !sameTags(accessRead, checkedTags(bot.accessRead));
  const writeChanged = !sameTags(accessWrite, checkedTags(bot.accessWrite));
  const helpChanged = helpNotifyTag !== (bot.helpNotifyTag ?? "");

  /** Save the lists that changed. */
  async function onSave() {
    await save(async () => {
      onSaved(
        await editBot(projectId, bot.id, {
          ...(readChanged ? { accessRead } : {}),
          ...(writeChanged ? { accessWrite } : {}),
          ...(helpChanged ? { helpNotifyTag: helpNotifyTag || null } : {}),
        }),
      );
    }, "Saved.");
  }

  /** Clear the last notice when anything is touched. */
  const touched = () => setNotice(null);

  return (
    <SectionCard
      title="Access"
      testId="bot-access"
      idPrefix="bot"
      intro={
        <>
          Lists of <Link to="/docs/tags">tags</Link>. They decide who may read
          and change this bot here and in the CLI; who may talk to it is up to
          the channel it is bound in.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      onSave={onSave}
      canSave={readChanged || writeChanged || helpChanged}
      saveDeniedReason={denied}
      busy={busy}
    >
      <div className="bot-access-fields">
        <TagPicker
          legend="Who may read it"
          tags={tags}
          value={accessRead}
          onChange={(value) => {
            setAccessRead(value);
            touched();
          }}
          disabled={busy || locked}
          title={denied}
          testId="bot-access-read"
        />
        <TagPicker
          legend="Who may change it"
          tags={tags}
          value={accessWrite}
          onChange={(value) => {
            setAccessWrite(value);
            touched();
          }}
          disabled={busy || locked}
          title={denied}
          testId="bot-access-write"
        />
        <Form.Group controlId="bot-help-tag" className="mb-0">
          <Form.Label>Who it asks for help</Form.Label>
          <Form.Select
            size="sm"
            className="settings-input"
            value={helpNotifyTag}
            disabled={busy || locked}
            title={denied}
            onChange={(e) => {
              setHelpNotifyTag(e.target.value);
              touched();
            }}
            data-testid="bot-help-tag"
          >
            <option value="">Project admins</option>
            {(tags ?? []).map((tag) => (
              <option key={tag.id} value={tag.name}>
                Members holding {tag.name}
              </option>
            ))}
            {bot.helpNotifyTag &&
              tags !== null &&
              !tags.some((tag) => tag.name === bot.helpNotifyTag) && (
                <option value={bot.helpNotifyTag}>{bot.helpNotifyTag}</option>
              )}
          </Form.Select>
          <Form.Text className="text-meta">
            Whom the bot notifies when it needs a person and nobody in the
            channel has answered.
          </Form.Text>
        </Form.Group>
      </div>
    </SectionCard>
  );
}
