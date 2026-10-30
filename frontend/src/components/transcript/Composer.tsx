import { type FormEvent, type KeyboardEvent, useState } from "react";
import { Alert, Form } from "../../ui";
import { GatedButton } from "../GatedButton";

/** See {@link Composer}. */
export interface ComposerProps {
  /** Send the text; a thrown error is shown and the text is kept. */
  onSend: (text: string) => Promise<void>;
  /** The button's label: "Send", "Start conversation". */
  label: string;
  placeholder: string;
  /** Why the person may not send, or `undefined` when they may. */
  deniedReason?: string;
  /** Keys the test ids: `<testId>-input`, `<testId>-send`, `<testId>-error`. */
  testId: string;
  /** A line under the box, saying what sending does. */
  hint?: string;
}

/**
 * A message box and its send button. ⌘↩ (Ctrl+↩) sends; a refused send keeps
 * the text and says why. A person who may not send sees the box disabled with
 * the reason — disabled, never absent.
 * @param props - See {@link ComposerProps}.
 * @returns The form.
 */
export function Composer({
  onSend,
  label,
  placeholder,
  deniedReason,
  testId,
  hint,
}: ComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Send what is typed, if anything. */
  async function send() {
    const trimmed = text.trim();
    if (!trimmed || sending || deniedReason) return;
    setSending(true);
    setError(null);
    try {
      await onSend(trimmed);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send it.");
    } finally {
      setSending(false);
    }
  }

  /** @param event - The form's submit. */
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    send();
  }

  /** @param event - A key in the box; ⌘↩ or Ctrl+↩ sends. */
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      send();
    }
  }

  return (
    <form className="tx-composer" onSubmit={onSubmit} data-testid={testId}>
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
      <Form.Control
        as="textarea"
        rows={3}
        aria-label={placeholder}
        placeholder={placeholder}
        value={text}
        disabled={deniedReason !== undefined || sending}
        title={deniedReason}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        data-testid={`${testId}-input`}
      />
      <div className="tx-composer-foot">
        {hint && <span className="text-meta">{hint}</span>}
        <GatedButton
          type="submit"
          size="sm"
          variant="primary"
          deniedReason={deniedReason}
          disabled={sending || !text.trim()}
          data-testid={`${testId}-send`}
        >
          {sending ? "Sending…" : label}
        </GatedButton>
      </div>
    </form>
  );
}
