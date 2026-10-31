import { type FormEvent, type KeyboardEvent, useId, useState } from "react";
import { Alert, Form } from "../../ui";
import { GatedButton } from "../GatedButton";
import { type SkillChoice, skillCompletions } from "./model";

/** See {@link ChatComposer}. */
export interface ChatComposerProps {
  /** Send the text; a thrown error is shown and the text is kept. */
  onSend: (text: string) => Promise<void>;
  placeholder: string;
  /** Why the person may not send, or `undefined` when they may. */
  deniedReason?: string;
  /** The bot's skills, which `/` completes. */
  skills: readonly SkillChoice[];
  /** A line under the box, saying what sending does. */
  hint?: string;
  /** The send button's label. */
  label?: string;
}

/**
 * The chat's message box. Enter sends and Shift+Enter breaks the line. Typing
 * `/` lists the bot's skills, filtered as the name is typed; ↑ and ↓ move
 * through them, and Enter or Tab puts the chosen `/name ` in the box. A
 * person who may not send sees the box disabled with the reason.
 * @param props - See {@link ChatComposerProps}.
 * @returns The form.
 */
export function ChatComposer({
  onSend,
  placeholder,
  deniedReason,
  skills,
  hint,
  label = "Send",
}: ChatComposerProps) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const listId = useId();
  const choices = dismissed === text ? [] : skillCompletions(text, skills);
  const open = choices.length > 0;
  const current = Math.min(active, choices.length - 1);

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

  /**
   * Put a skill's name in the box, ready for its arguments.
   * @param choice - The skill.
   */
  function complete(choice: SkillChoice) {
    setText(`/${choice.name} `);
    setActive(0);
  }

  /** @param event - The form's submit. */
  function onSubmit(event: FormEvent) {
    event.preventDefault();
    send();
  }

  /** @param event - A key in the box. */
  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((current + step + choices.length) % choices.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const choice = choices[current];
        if (choice) {
          event.preventDefault();
          complete(choice);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(text);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      send();
    }
  }

  return (
    <form
      className="tx-composer chat-composer"
      onSubmit={onSubmit}
      data-testid="chat-composer"
    >
      {error && (
        <Alert
          variant="danger"
          dismissible
          onClose={() => setError(null)}
          data-testid="chat-composer-error"
        >
          {error}
        </Alert>
      )}
      {open && (
        <ul
          className="chat-skills"
          id={listId}
          role="listbox"
          aria-label="Skills"
          data-testid="chat-skills"
        >
          {choices.map((choice, i) => (
            <li
              key={choice.name}
              role="option"
              aria-selected={i === current}
              className="chat-skill"
              data-testid={`chat-skill-${choice.name}`}
              onMouseDown={(e) => {
                e.preventDefault();
                complete(choice);
              }}
            >
              <span className="mono">/{choice.name}</span>
              <span className="text-meta">{choice.description}</span>
            </li>
          ))}
        </ul>
      )}
      <Form.Control
        as="textarea"
        rows={2}
        aria-label={placeholder}
        placeholder={placeholder}
        value={text}
        disabled={deniedReason !== undefined || sending}
        title={deniedReason}
        role={open ? "combobox" : undefined}
        aria-expanded={open ? true : undefined}
        aria-controls={open ? listId : undefined}
        onChange={(e) => {
          setText(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        data-testid="chat-composer-input"
      />
      <div className="tx-composer-foot">
        <span className="text-meta">
          {hint ??
            "Enter sends; Shift+Enter starts a new line; / runs a skill."}
        </span>
        <GatedButton
          type="submit"
          size="sm"
          variant="primary"
          deniedReason={deniedReason}
          disabled={sending || !text.trim()}
          data-testid="chat-composer-send"
        >
          {sending ? "Sending…" : label}
        </GatedButton>
      </div>
    </form>
  );
}
