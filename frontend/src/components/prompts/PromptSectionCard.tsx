import { Bot } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, Button, Chip, Form } from "../../ui";
import { apiFetch } from "../../utils/client";
import {
  estimateTokens,
  isIdentity,
  loadingSummary,
  parseKeywords,
  sectionLocks,
  versionSourceLabel,
} from "../../utils/prompts";
import { ConfirmDialog } from "../ConfirmDialog";
import { GatedButton } from "../GatedButton";
import { MarkdownBlock } from "../MarkdownBlock";
import { useSectionSave } from "../sections/useSectionSave";
import type { PromptSection } from "./data";
import { SectionHistory } from "./SectionHistory";

/** See {@link PromptSectionCard}. */
export interface PromptSectionCardProps {
  projectId: number;
  section: PromptSection;
  /** Its place in the assembled prompt, from 1, or `undefined` where order is not shown. */
  place?: number;
  /** Why the person may not change it, or `undefined` when they may. */
  denied: string | undefined;
  /** Called after any change, so the page reads its sections (and its preview) again. */
  onChanged: () => Promise<void> | void;
}

/** The text fields of a section, as typed. */
interface Draft {
  title: string;
  body: string;
  loading: string;
  keywords: string;
  changeNote: string;
}

/**
 * A section as its draft.
 * @param section - The section.
 * @returns The draft.
 */
function draftOf(section: PromptSection): Draft {
  return {
    title: section.title,
    body: section.body ?? "",
    loading: section.loading,
    keywords: section.keywords.join(", "),
    changeNote: "",
  };
}

/**
 * One prompt section: its title, when it loads (always, or when one of its
 * keywords comes up), whether the bot may edit it itself, its version and
 * who wrote it, and its text. **Edit** changes the text and when it loads —
 * a text change is a new version, saved against the version it was read at,
 * so a change the bot made meanwhile is never overwritten. **History** lists
 * every version with a diff and a **Revert**. **Delete** archives it.
 *
 * What the server never allows is never offered: *Identity* always loads, is
 * never the bot's to edit, and is never deleted; no bot edits a section every
 * bot includes. A save the bot's prompt budget refuses says so here, in the
 * card.
 * @param props - See {@link PromptSectionCardProps}.
 * @returns The card.
 */
export function PromptSectionCard({
  projectId,
  section,
  place,
  denied,
  onChanged,
}: PromptSectionCardProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [editing, setEditing] = useState(false);
  const [history, setHistory] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => draftOf(section));
  const [agentEditable, setAgentEditable] = useState(section.agentEditable);
  const locks = sectionLocks(section);
  const locked = denied !== undefined;
  const path = `/project/${projectId}/prompt-section/${section.id}`;
  const testId = `prompt-section-${section.scope}-${section.key}`;

  // A section read again (after any save) resets a closed editor's draft.
  useEffect(() => {
    if (!editing) setDraft(draftOf(section));
  }, [section, editing]);
  useEffect(() => {
    setAgentEditable(section.agentEditable);
  }, [section.agentEditable]);

  const keywords = parseKeywords(draft.keywords);
  const fields: Record<string, unknown> = {};
  if (draft.title.trim() !== section.title) fields.title = draft.title.trim();
  if (draft.body !== (section.body ?? "")) fields.body = draft.body;
  if (draft.loading !== section.loading) fields.loading = draft.loading;
  if (keywords.join(",") !== section.keywords.join(","))
    fields.keywords = keywords;
  const changed = Object.keys(fields).length > 0;

  /**
   * Change one field of the draft.
   * @param key - The field.
   * @param value - Its new value.
   */
  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setNotice(null);
  }

  /** Save the changed fields against the version the editor opened at. */
  async function onSave() {
    if (draft.title.trim() === "") {
      setError("A section needs a title.");
      return;
    }
    const body: Record<string, unknown> = {
      ...fields,
      baseVersion: section.currentVersion,
    };
    if (draft.changeNote.trim()) body.changeNote = draft.changeNote.trim();
    const ok = await save(
      () => apiFetch(path, { method: "POST", body: JSON.stringify(body) }),
      fields.title !== undefined || fields.body !== undefined
        ? `Saved as version ${section.currentVersion + 1}.`
        : "Saved.",
    );
    if (ok) {
      setEditing(false);
      await onChanged();
    }
  }

  /**
   * Let the bot edit this section itself, or stop it — saved at once.
   * @param agentEditable - The new setting.
   */
  async function onAgentEditable(agentEditable: boolean) {
    // The switch moves at once; a refusal puts it back.
    setAgentEditable(agentEditable);
    const ok = await save(
      () =>
        apiFetch(path, {
          method: "POST",
          body: JSON.stringify({ agentEditable }),
        }),
      agentEditable
        ? "The bot may now edit this section itself. Every edit is a version you can revert."
        : "Only people may edit this section now.",
    );
    if (ok) await onChanged();
    else setAgentEditable(section.agentEditable);
  }

  /** Delete (archive) the section. */
  async function onDelete() {
    setDeleting(false);
    const ok = await save(
      () => apiFetch(path, { method: "DELETE" }),
      `Deleted ${section.title}.`,
    );
    if (ok) await onChanged();
  }

  const scopeWord = section.scope === "project" ? "Every bot" : null;
  return (
    <section
      className="prompt-section"
      data-scope={section.scope}
      data-loading={section.loading}
      data-testid={testId}
      aria-label={section.title}
    >
      <header className="prompt-section-head">
        {place !== undefined && (
          <span className="prompt-section-place tabular" aria-hidden="true">
            {place}
          </span>
        )}
        <h3 className="prompt-section-title">{section.title}</h3>
        {scopeWord && <Chip data-testid={`${testId}-scope`}>{scopeWord}</Chip>}
        <Chip
          tone={section.loading === "always" ? "subtle" : "accent"}
          title={loadingSummary(section)}
          data-testid={`${testId}-loading`}
        >
          {section.loading === "always" ? "Always" : "Contextual"}
        </Chip>
        <span className="text-meta tabular prompt-section-version">
          v{section.currentVersion}
          {section.versionSource && (
            <>
              {" · "}
              {section.versionSource === "agent" ? (
                <span className="prompt-section-agent">
                  <Bot size={12} aria-hidden="true" />{" "}
                  {versionSourceLabel(section.versionSource)}
                </span>
              ) : (
                versionSourceLabel(section.versionSource)
              )}
            </>
          )}
          {" · "}~{estimateTokens(section.body ?? "")} tokens
        </span>
        <span className="prompt-section-actions">
          <Button
            size="sm"
            variant={history ? "outline-secondary" : "link"}
            aria-expanded={history}
            onClick={() => setHistory((h) => !h)}
            data-testid={`${testId}-history`}
          >
            History
          </Button>
          <GatedButton
            size="sm"
            variant="outline-secondary"
            disabled={busy || editing}
            deniedReason={denied}
            onClick={() => {
              setDraft(draftOf(section));
              setEditing(true);
              setNotice(null);
            }}
            data-testid={`${testId}-edit`}
          >
            Edit
          </GatedButton>
          {locks.canDelete && (
            <GatedButton
              size="sm"
              variant="outline-danger"
              disabled={busy}
              deniedReason={denied}
              aria-label={`Delete the ${section.title} section`}
              onClick={() => setDeleting(true)}
              data-testid={`${testId}-delete`}
            >
              Delete
            </GatedButton>
          )}
        </span>
      </header>

      {section.loading === "contextual" && (
        <p className="prompt-section-keywords text-meta">
          {loadingSummary(section)}
        </p>
      )}

      {locks.canBeAgentEditable ? (
        <Form.Check
          type="switch"
          id={`${testId}-agent-editable`}
          className="prompt-section-switch"
          label="Editable by the bot — it may rewrite this section itself"
          checked={agentEditable}
          disabled={busy || locked}
          title={denied}
          onChange={(e) => onAgentEditable(e.target.checked)}
          data-testid={`${testId}-agent-editable`}
        />
      ) : (
        <p className="text-meta prompt-section-switch mb-0">
          {isIdentity(section)
            ? "Always included, and never editable by the bot."
            : "In every bot's prompt; only people edit it, and only admins."}
        </p>
      )}

      {error && (
        <Alert
          variant="danger"
          dismissible
          onClose={() => setError(null)}
          data-testid={`${testId}-error`}
        >
          {error}
        </Alert>
      )}
      {notice && (
        <Alert
          variant="success"
          dismissible
          onClose={() => setNotice(null)}
          data-testid={`${testId}-notice`}
        >
          {notice}
        </Alert>
      )}

      {editing ? (
        <div className="prompt-section-editor">
          <Form.Group controlId={`${testId}-title-input`} className="mb-0">
            <Form.Label>Title</Form.Label>
            <Form.Control
              size="sm"
              value={draft.title}
              maxLength={120}
              disabled={busy}
              onChange={(e) => set("title", e.target.value)}
              data-testid={`${testId}-title-input`}
            />
          </Form.Group>
          <Form.Group controlId={`${testId}-body-input`} className="mb-0">
            <Form.Label>Text</Form.Label>
            <Form.Control
              as="textarea"
              rows={Math.min(
                16,
                Math.max(5, draft.body.split("\n").length + 1),
              )}
              size="sm"
              className="mono"
              value={draft.body}
              maxLength={20_000}
              disabled={busy}
              onChange={(e) => set("body", e.target.value)}
              data-testid={`${testId}-body-input`}
            />
            <Form.Text className="text-meta">
              Markdown. About {estimateTokens(draft.body)} tokens.
            </Form.Text>
          </Form.Group>
          <div className="prompt-section-editor-row">
            <Form.Group controlId={`${testId}-loading-input`} className="mb-0">
              <Form.Label>Loads</Form.Label>
              <Form.Select
                size="sm"
                value={draft.loading}
                disabled={busy || !locks.canBeContextual}
                title={
                  locks.canBeContextual
                    ? undefined
                    : "The Identity section is always included."
                }
                onChange={(e) => set("loading", e.target.value)}
                data-testid={`${testId}-loading-input`}
              >
                <option value="always">Always</option>
                <option value="contextual">When its keywords come up</option>
              </Form.Select>
            </Form.Group>
            {draft.loading === "contextual" && (
              <Form.Group
                controlId={`${testId}-keywords-input`}
                className="mb-0 prompt-section-keywords-field"
              >
                <Form.Label>Keywords</Form.Label>
                <Form.Control
                  size="sm"
                  value={draft.keywords}
                  placeholder="Its title's words"
                  disabled={busy}
                  onChange={(e) => set("keywords", e.target.value)}
                  data-testid={`${testId}-keywords-input`}
                />
              </Form.Group>
            )}
          </div>
          <Form.Group controlId={`${testId}-note-input`} className="mb-0">
            <Form.Label>
              Why <span className="text-meta">optional</span>
            </Form.Label>
            <Form.Control
              size="sm"
              value={draft.changeNote}
              maxLength={500}
              placeholder="What changed, in a sentence"
              disabled={busy}
              onChange={(e) => set("changeNote", e.target.value)}
              data-testid={`${testId}-note-input`}
            />
          </Form.Group>
          <div className="d-flex gap-2">
            <GatedButton
              size="sm"
              variant="primary"
              disabled={busy || !changed}
              deniedReason={denied}
              onClick={onSave}
              data-testid={`${testId}-save`}
            >
              Save
            </GatedButton>
            <Button
              size="sm"
              variant="link"
              disabled={busy}
              onClick={() => {
                setEditing(false);
                setError(null);
              }}
              data-testid={`${testId}-cancel`}
            >
              Cancel
            </Button>
          </div>
        </div>
      ) : section.body ? (
        <div className="prompt-section-body" data-testid={`${testId}-body`}>
          <MarkdownBlock>{section.body}</MarkdownBlock>
        </div>
      ) : (
        <p className="text-meta mb-0" data-testid={`${testId}-body`}>
          Empty — nothing of it is in the prompt yet.
        </p>
      )}

      {history && (
        <SectionHistory
          projectId={projectId}
          section={section}
          denied={denied}
          onReverted={async () => {
            setNotice("Reverted. The old text is the newest version now.");
            await onChanged();
          }}
        />
      )}

      <ConfirmDialog
        show={deleting}
        title={`Delete ${section.title}?`}
        confirmLabel="Delete section"
        busy={busy}
        onConfirm={onDelete}
        onCancel={() => setDeleting(false)}
        testId={`${testId}-delete`}
      >
        {section.scope === "project"
          ? "It leaves every bot's prompt from their next step. Its versions are kept."
          : "It leaves this bot's prompt from its next step. Its versions are kept."}
      </ConfirmDialog>
    </section>
  );
}
