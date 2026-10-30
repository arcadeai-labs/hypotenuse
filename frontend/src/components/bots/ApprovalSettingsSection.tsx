import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Form } from "../../ui";
import { approvalTtlChoices, durationWords } from "../../utils/mcp";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import type { ProjectTag } from "./data";
import { type BotSectionProps, editBot } from "./IdentitySection";

/**
 * Who decides the bot's tool calls that wait for approval, and how long a
 * call waits before it expires. Whoever may change the bot may always
 * decide; an approver tag adds the members holding it. An expired call is
 * refused, and the bot is told so.
 * @param props - See {@link BotSectionProps}, plus the project's tags.
 * @returns The section.
 */
export function ApprovalSettingsSection({
  projectId,
  bot,
  denied,
  onSaved,
  tags,
}: BotSectionProps & { tags: ProjectTag[] | null }) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [approverTag, setApproverTag] = useState(bot.approverTag ?? "");
  const [ttl, setTtl] = useState(bot.approvalTtlSeconds);
  const locked = busy || denied !== undefined;

  useEffect(() => {
    setApproverTag(bot.approverTag ?? "");
    setTtl(bot.approvalTtlSeconds);
  }, [bot]);

  const tagChanged = approverTag !== (bot.approverTag ?? "");
  const ttlChanged = ttl !== bot.approvalTtlSeconds;

  /** Save whichever changed. */
  async function onSave() {
    await save(async () => {
      onSaved(
        await editBot(projectId, bot.id, {
          ...(tagChanged ? { approverTag: approverTag || null } : {}),
          ...(ttlChanged ? { approvalTtlSeconds: ttl } : {}),
        }),
      );
    }, "Saved.");
  }

  return (
    <SectionCard
      title="Approvals"
      testId="bot-approvals"
      idPrefix="bot"
      intro={
        <>
          A tool call no pattern allows waits in{" "}
          <Link to="/approvals">Approvals</Link>, and the conversation pauses
          until someone decides it.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      onSave={onSave}
      canSave={tagChanged || ttlChanged}
      saveDeniedReason={denied}
      busy={busy}
    >
      <div className="bot-budget-fields">
        <Form.Group controlId="bot-approver-tag" className="mb-0">
          <Form.Label>Who may decide</Form.Label>
          <Form.Select
            size="sm"
            className="settings-input"
            value={approverTag}
            disabled={locked}
            title={denied}
            onChange={(e) => {
              setApproverTag(e.target.value);
              setNotice(null);
            }}
            data-testid="bot-approver-tag"
          >
            <option value="">Whoever may change it (admins notified)</option>
            {(tags ?? []).map((tag) => (
              <option key={tag.id} value={tag.name}>
                …and members holding {tag.name}
              </option>
            ))}
            {bot.approverTag &&
              tags !== null &&
              !tags.some((tag) => tag.name === bot.approverTag) && (
                <option value={bot.approverTag}>{bot.approverTag}</option>
              )}
          </Form.Select>
          <Form.Text className="text-meta">
            Whoever may change {bot.name} may always decide. A waiting call
            notifies the members holding this tag, or the project admins when
            none is set.
          </Form.Text>
        </Form.Group>
        <Form.Group controlId="bot-approval-ttl" className="mb-0">
          <Form.Label>A waiting call expires after</Form.Label>
          <Form.Select
            size="sm"
            className="settings-input"
            value={ttl}
            disabled={locked}
            title={denied}
            onChange={(e) => {
              setTtl(Number(e.target.value));
              setNotice(null);
            }}
            data-testid="bot-approval-ttl"
          >
            {approvalTtlChoices(bot.approvalTtlSeconds).map((seconds) => (
              <option key={seconds} value={seconds}>
                {durationWords(seconds * 1000)}
              </option>
            ))}
          </Form.Select>
          <Form.Text className="text-meta">
            An expired call is refused, and {bot.name} is told it was not
            decided in time.
          </Form.Text>
        </Form.Group>
      </div>
    </SectionCard>
  );
}
