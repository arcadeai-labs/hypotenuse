import { useState } from "react";
import { Button, Form } from "../../ui";
import { MarkdownBlock } from "../MarkdownBlock";

/** A persona to start from, so an empty box is never the first thing a person sees. */
export const PERSONA_PLACEHOLDER = `You are Ada, the support team's teammate.

- Answer from what this channel already knows before asking.
- Say plainly when you are not sure, and who would know.
- Keep replies short; link rather than paste.`;

/** See {@link PersonaEditor}. */
export interface PersonaEditorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Why it is disabled, as its `title`. */
  title?: string;
  /** Keys the test ids: `<testId>`, `<testId>-preview`, `<testId>-write`, `<testId>-show-preview`. */
  testId: string;
  /** The textarea's id, for its label. */
  id: string;
}

/**
 * A bot's persona: markdown written in a textarea, and a preview drawn the
 * way the bot's own output is — through `MarkdownBlock`, with no raw HTML —
 * so what a person reads here is what they will see quoted back.
 * @param props - See {@link PersonaEditorProps}.
 * @returns The editor.
 */
export function PersonaEditor({
  value,
  onChange,
  disabled,
  title,
  testId,
  id,
}: PersonaEditorProps) {
  const [preview, setPreview] = useState(false);
  return (
    <div className="persona-editor">
      <div
        className="persona-editor-tabs"
        role="group"
        aria-label="Persona view"
      >
        <Button
          size="sm"
          variant={preview ? "link" : "outline-secondary"}
          aria-pressed={!preview}
          onClick={() => setPreview(false)}
          data-testid={`${testId}-write`}
        >
          Write
        </Button>
        <Button
          size="sm"
          variant={preview ? "outline-secondary" : "link"}
          aria-pressed={preview}
          onClick={() => setPreview(true)}
          data-testid={`${testId}-show-preview`}
        >
          Preview
        </Button>
      </div>
      {preview ? (
        <div className="persona-preview" data-testid={`${testId}-preview`}>
          {value.trim() ? (
            <MarkdownBlock>{value}</MarkdownBlock>
          ) : (
            <p className="text-meta">Nothing to preview yet.</p>
          )}
        </div>
      ) : (
        <Form.Control
          as="textarea"
          id={id}
          rows={10}
          className="mono persona-input"
          placeholder={PERSONA_PLACEHOLDER}
          value={value}
          disabled={disabled}
          title={title}
          onChange={(e) => onChange(e.target.value)}
          data-testid={testId}
        />
      )}
    </div>
  );
}
