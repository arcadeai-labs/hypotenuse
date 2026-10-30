import { type ReactNode, useState } from "react";
import { Alert, Button, Form } from "../../ui";
import { GatedButton } from "../GatedButton";
import { MarkdownBlock } from "../MarkdownBlock";
import { pathProblem } from "./model";

/** What the editor hands its owner to write. */
export interface MemoryDraft {
  path: string;
  description: string;
  content: string;
  changeNote: string;
}

/** See {@link MemoryEditor}. */
export interface MemoryEditorProps {
  /** What the fields start with. */
  initial: MemoryDraft;
  /** Whether the path may be typed: a new document's, never an existing one's. */
  newDocument?: boolean;
  /** Write it; resolves when the server has answered. */
  onSubmit: (draft: MemoryDraft) => Promise<void> | void;
  onCancel: () => void;
  /** Whether a write is in flight. */
  busy: boolean;
  /** Why the write is refused, as the save button's title. */
  deniedReason?: string;
  /** The last failure, drawn above the buttons. */
  error?: string | null;
  /** Something the person can do about the failure, beside it. */
  errorAction?: ReactNode;
  /** Keys the editor's test ids. */
  testId: string;
}

/**
 * Write or rewrite a memory document: its path (only when new), a one-line
 * description, the markdown with a preview drawn the way the explorer draws
 * it, and a note saying why it changed, kept with the version.
 * @param props - See {@link MemoryEditorProps}.
 * @returns The form.
 */
export function MemoryEditor({
  initial,
  newDocument = false,
  onSubmit,
  onCancel,
  busy,
  deniedReason,
  error,
  errorAction,
  testId,
}: MemoryEditorProps) {
  const [draft, setDraft] = useState<MemoryDraft>(initial);
  const [preview, setPreview] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  /** Check what the server would refuse outright, then write. */
  function submit() {
    const bad = newDocument ? pathProblem(draft.path) : null;
    if (bad) {
      setProblem(bad);
      return;
    }
    if (draft.content.trim() === "") {
      setProblem("A memory needs some text.");
      return;
    }
    setProblem(null);
    onSubmit(draft);
  }

  return (
    <Form
      className="memory-editor"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      data-testid={testId}
    >
      {newDocument && (
        <Form.Group controlId={`${testId}-path`} className="mb-0">
          <Form.Label>Path</Form.Label>
          <Form.Control
            size="sm"
            className="mono"
            placeholder="facts/deploy-process.md"
            value={draft.path}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, path: e.target.value })}
            data-testid={`${testId}-path`}
          />
        </Form.Group>
      )}
      <Form.Group controlId={`${testId}-description`} className="mb-0">
        <Form.Label>
          Description <span className="text-meta">optional, one line</span>
        </Form.Label>
        <Form.Control
          size="sm"
          maxLength={240}
          placeholder="What this document is about"
          value={draft.description}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          data-testid={`${testId}-description`}
        />
      </Form.Group>
      <div className="memory-editor-body">
        <div className="memory-tabs" role="group" aria-label="Document view">
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
            data-testid={`${testId}-preview`}
          >
            Preview
          </Button>
        </div>
        {preview ? (
          <div className="memory-content">
            {draft.content.trim() ? (
              <MarkdownBlock>{draft.content}</MarkdownBlock>
            ) : (
              <p className="text-meta">Nothing to preview yet.</p>
            )}
          </div>
        ) : (
          <Form.Control
            as="textarea"
            rows={12}
            aria-label="Content"
            className="mono memory-editor-input"
            placeholder={"# Deploy process\n\nDeploys go out on Tuesdays…"}
            value={draft.content}
            disabled={busy}
            onChange={(e) => setDraft({ ...draft, content: e.target.value })}
            data-testid={`${testId}-content`}
          />
        )}
      </div>
      <Form.Group controlId={`${testId}-note`} className="mb-0">
        <Form.Label>
          Why <span className="text-meta">optional, kept with the version</span>
        </Form.Label>
        <Form.Control
          size="sm"
          maxLength={500}
          placeholder="Corrected the deploy day"
          value={draft.changeNote}
          disabled={busy}
          onChange={(e) => setDraft({ ...draft, changeNote: e.target.value })}
          data-testid={`${testId}-note`}
        />
      </Form.Group>
      {(problem || error) && (
        <Alert variant="danger" data-testid={`${testId}-error`}>
          {problem ?? error} {errorAction}
        </Alert>
      )}
      <div className="d-flex gap-2">
        <GatedButton
          size="sm"
          type="submit"
          variant="primary"
          disabled={busy}
          deniedReason={deniedReason}
          data-testid={`${testId}-save`}
        >
          {newDocument ? "Write document" : "Save version"}
        </GatedButton>
        <Button
          size="sm"
          variant="outline-secondary"
          disabled={busy}
          onClick={onCancel}
          data-testid={`${testId}-cancel`}
        >
          Cancel
        </Button>
      </div>
    </Form>
  );
}
