import { useState } from "react";
import { Alert, Form } from "../../ui";
import { apiFetch } from "../../utils/client";
import { estimateTokens, parseKeywords } from "../../utils/prompts";
import { GatedButton } from "../GatedButton";
import { useSectionSave } from "../sections/useSectionSave";
import type { PromptSection } from "./data";

/** See {@link NewSectionForm}. */
export interface NewSectionFormProps {
  projectId: number;
  /** The bot whose prompt gets it, or `null` for a section every bot includes. */
  botId: number | null;
  /** Why the person may not add one, or `undefined` when they may. */
  denied: string | undefined;
  /** Called with the new section. */
  onCreated: (section: PromptSection) => Promise<void> | void;
}

/** An empty form. */
const EMPTY = {
  title: "",
  body: "",
  loading: "always",
  keywords: "",
  agentEditable: false,
};

/**
 * Add a section: a title, its text, whether it always loads or only when its
 * keywords come up, and — for a bot's own section — whether the bot may edit
 * it itself. It goes after the others of its kind; a save that would push
 * the always-included prompt over the bot's budget is refused, and says so
 * here.
 * @param props - See {@link NewSectionFormProps}.
 * @returns The form.
 */
export function NewSectionForm({
  projectId,
  botId,
  denied,
  onCreated,
}: NewSectionFormProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const [draft, setDraft] = useState(EMPTY);
  const locked = busy || denied !== undefined;
  const testId = "prompt-new";

  /**
   * Change one field of the draft.
   * @param key - The field.
   * @param value - Its new value.
   */
  function set<K extends keyof typeof EMPTY>(key: K, value: (typeof EMPTY)[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setNotice(null);
  }

  /** Create the section. */
  async function onCreate() {
    if (draft.title.trim() === "") {
      setError("A section needs a title.");
      return;
    }
    let created: PromptSection | null = null;
    const ok = await save(async () => {
      const res = await apiFetch<{ promptSection: PromptSection }>(
        `/project/${projectId}/prompt-section`,
        {
          method: "PUT",
          body: JSON.stringify({
            ...(botId !== null ? { botId } : {}),
            title: draft.title.trim(),
            body: draft.body,
            loading: draft.loading,
            keywords: parseKeywords(draft.keywords),
            ...(botId !== null ? { agentEditable: draft.agentEditable } : {}),
          }),
        },
      );
      created = res.promptSection;
    }, `Added ${draft.title.trim()}.`);
    if (ok && created) {
      setDraft(EMPTY);
      await onCreated(created);
    }
  }

  return (
    <Form
      className="prompt-new"
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault();
        onCreate();
      }}
    >
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
      <Form.Group controlId="prompt-new-title" className="mb-0">
        <Form.Label>Title</Form.Label>
        <Form.Control
          size="sm"
          value={draft.title}
          maxLength={120}
          placeholder="Release notes"
          disabled={locked}
          title={denied}
          onChange={(e) => set("title", e.target.value)}
          data-testid={`${testId}-title`}
        />
      </Form.Group>
      <Form.Group controlId="prompt-new-body" className="mb-0">
        <Form.Label>Text</Form.Label>
        <Form.Control
          as="textarea"
          rows={4}
          size="sm"
          className="mono"
          value={draft.body}
          maxLength={20_000}
          placeholder="How we write release notes: one line per change, newest first…"
          disabled={locked}
          title={denied}
          onChange={(e) => set("body", e.target.value)}
          data-testid={`${testId}-body`}
        />
        <Form.Text className="text-meta">
          Markdown. About {estimateTokens(draft.body)} tokens.
        </Form.Text>
      </Form.Group>
      <div className="prompt-section-editor-row">
        <Form.Group controlId="prompt-new-loading" className="mb-0">
          <Form.Label>Loads</Form.Label>
          <Form.Select
            size="sm"
            value={draft.loading}
            disabled={locked}
            title={denied}
            onChange={(e) => set("loading", e.target.value)}
            data-testid={`${testId}-loading`}
          >
            <option value="always">Always</option>
            <option value="contextual">When its keywords come up</option>
          </Form.Select>
        </Form.Group>
        {draft.loading === "contextual" && (
          <Form.Group
            controlId="prompt-new-keywords"
            className="mb-0 prompt-section-keywords-field"
          >
            <Form.Label>Keywords</Form.Label>
            <Form.Control
              size="sm"
              value={draft.keywords}
              placeholder="release, changelog"
              disabled={locked}
              title={denied}
              onChange={(e) => set("keywords", e.target.value)}
              data-testid={`${testId}-keywords`}
            />
          </Form.Group>
        )}
      </div>
      {botId !== null && (
        <Form.Check
          type="switch"
          id="prompt-new-agent-editable"
          label="Editable by the bot"
          checked={draft.agentEditable}
          disabled={locked}
          title={denied}
          onChange={(e) => set("agentEditable", e.target.checked)}
          data-testid={`${testId}-agent-editable`}
        />
      )}
      <div>
        <GatedButton
          size="sm"
          type="submit"
          variant="outline-primary"
          disabled={busy || draft.title.trim() === ""}
          deniedReason={denied}
          data-testid={`${testId}-submit`}
        >
          Add section
        </GatedButton>
      </div>
    </Form>
  );
}
