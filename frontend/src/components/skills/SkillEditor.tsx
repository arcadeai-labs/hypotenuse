import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Alert, Button, Form } from "../../ui";
import { checkedTags } from "../../utils/models";
import {
  type ArgumentDraft,
  argumentDraft,
  argumentInputs,
  argumentsProblem,
  skillNameProblem,
  skillUsage,
} from "../../utils/prompts";
import type { ProjectTag } from "../bots/data";
import { TagPicker } from "../bots/TagPicker";
import { GatedButton } from "../GatedButton";
import type { SkillDetail } from "../prompts/data";

/** A skill as the editor holds it. */
export interface SkillDraft {
  name: string;
  description: string;
  arguments: ArgumentDraft[];
  body: string;
  accessRead: string[];
  accessWrite: string[];
  changeNote: string;
}

/** An empty skill. */
export const EMPTY_SKILL: SkillDraft = {
  name: "",
  description: "",
  arguments: [],
  body: "",
  accessRead: [],
  accessWrite: [],
  changeNote: "",
};

/**
 * A skill as the editor's draft.
 * @param skill - The skill, with its body.
 * @returns The draft.
 */
export function skillDraft(skill: SkillDetail): SkillDraft {
  return {
    name: skill.name,
    description: skill.description,
    arguments: skill.arguments.map(argumentDraft),
    body: skill.body ?? "",
    accessRead: checkedTags(skill.accessRead),
    accessWrite: checkedTags(skill.accessWrite),
    changeNote: "",
  };
}

/**
 * A draft as `skill:create` or `skill:edit` takes it.
 * @param draft - The draft.
 * @returns The body to send.
 */
export function skillBody(draft: SkillDraft): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: draft.name.trim().toLowerCase(),
    description: draft.description.trim(),
    arguments: argumentInputs(draft.arguments),
    body: draft.body,
    accessRead: draft.accessRead,
    accessWrite: draft.accessWrite,
  };
  if (draft.changeNote.trim()) body.changeNote = draft.changeNote.trim();
  return body;
}

/** See {@link SkillEditor}. */
export interface SkillEditorProps {
  /** Where the form starts. */
  initial: SkillDraft;
  /** The project's tags, for the access lists. */
  tags: ProjectTag[] | null;
  /** Whether a request is in flight. */
  busy: boolean;
  /** Why the person may not save, or `undefined`. */
  denied: string | undefined;
  /** What the save button says. */
  submitLabel: string;
  /** Whether to ask why it changed (an edit, not a new skill). */
  withChangeNote?: boolean;
  /** Keys the test ids. */
  testId: string;
  /** Save the draft; resolves when the request settles. */
  onSubmit: (draft: SkillDraft) => Promise<void> | void;
  /** Close the editor, when it can be closed. */
  onCancel?: () => void;
}

/**
 * A skill's fields: its name (what `/name` calls), a one-line description
 * every attached bot reads, its arguments in positional order, the template
 * body, and who may see and change it. What the server would refuse —
 * a name that is not lowercase words, an argument name twice — is said
 * before the request is sent.
 * @param props - See {@link SkillEditorProps}.
 * @returns The form.
 */
export function SkillEditor({
  initial,
  tags,
  busy,
  denied,
  submitLabel,
  withChangeNote,
  testId,
  onSubmit,
  onCancel,
}: SkillEditorProps) {
  const [draft, setDraft] = useState<SkillDraft>(initial);
  const [problem, setProblem] = useState<string | null>(null);
  const locked = busy || denied !== undefined;

  /**
   * Change one field.
   * @param key - The field.
   * @param value - Its new value.
   */
  function set<K extends keyof SkillDraft>(key: K, value: SkillDraft[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    setProblem(null);
  }

  /**
   * Change one field of one argument.
   * @param index - The argument's place.
   * @param patch - The fields to change.
   */
  function setArg(index: number, patch: Partial<ArgumentDraft>) {
    set(
      "arguments",
      draft.arguments.map((a, i) => (i === index ? { ...a, ...patch } : a)),
    );
  }

  /** Check the draft, then hand it up. */
  async function submit() {
    const found =
      skillNameProblem(draft.name) ??
      (draft.description.trim() === ""
        ? "A skill needs a one-line description."
        : null) ??
      argumentsProblem(draft.arguments) ??
      (draft.body.trim() === "" ? "A skill needs a body." : null);
    if (found) {
      setProblem(found);
      return;
    }
    await onSubmit(draft);
  }

  return (
    <Form
      className="skill-editor"
      data-testid={testId}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      {problem && (
        <Alert variant="danger" data-testid={`${testId}-problem`}>
          {problem}
        </Alert>
      )}
      <div className="skill-editor-row">
        <Form.Group controlId={`${testId}-name`} className="mb-0">
          <Form.Label>Name</Form.Label>
          <Form.Control
            size="sm"
            className="mono"
            value={draft.name}
            maxLength={64}
            placeholder="release-notes"
            disabled={locked}
            title={denied}
            onChange={(e) => set("name", e.target.value)}
            data-testid={`${testId}-name`}
          />
        </Form.Group>
        <Form.Group
          controlId={`${testId}-description`}
          className="mb-0 skill-editor-grow"
        >
          <Form.Label>Description</Form.Label>
          <Form.Control
            size="sm"
            value={draft.description}
            maxLength={280}
            placeholder="Drafts release notes for a version from its merged pull requests"
            disabled={locked}
            title={denied}
            onChange={(e) => set("description", e.target.value)}
            data-testid={`${testId}-description`}
          />
        </Form.Group>
      </div>

      <fieldset className="settings-fieldset skill-arguments">
        <legend className="form-label">Arguments</legend>
        {draft.arguments.length === 0 && (
          <p className="text-meta mb-0">
            None: <span className="mono">$ARGUMENTS</span> is still everything
            typed after the name.
          </p>
        )}
        {draft.arguments.map((arg, i) => (
          <div
            // An argument's place is its identity until it is saved.
            // biome-ignore lint/suspicious/noArrayIndexKey: arguments are positional
            key={i}
            className="skill-argument"
            data-testid={`${testId}-arg-${i}`}
          >
            <span className="text-meta tabular skill-argument-place">
              ${i + 1}
            </span>
            <Form.Control
              size="sm"
              className="mono"
              aria-label={`Argument ${i + 1} name`}
              placeholder="version"
              value={arg.name}
              maxLength={40}
              disabled={locked}
              onChange={(e) => setArg(i, { name: e.target.value })}
              data-testid={`${testId}-arg-${i}-name`}
            />
            <Form.Control
              size="sm"
              aria-label={`Argument ${i + 1} description`}
              placeholder="What it is"
              value={arg.description}
              maxLength={200}
              disabled={locked}
              onChange={(e) => setArg(i, { description: e.target.value })}
              data-testid={`${testId}-arg-${i}-description`}
            />
            <Form.Control
              size="sm"
              aria-label={`Argument ${i + 1} default`}
              placeholder="Default"
              value={arg.default}
              maxLength={500}
              disabled={locked || arg.required}
              title={
                arg.required ? "A required argument has no default" : undefined
              }
              onChange={(e) => setArg(i, { default: e.target.value })}
              data-testid={`${testId}-arg-${i}-default`}
            />
            <Form.Check
              type="switch"
              id={`${testId}-arg-${i}-required`}
              label="Required"
              checked={arg.required}
              disabled={locked}
              onChange={(e) =>
                setArg(i, {
                  required: e.target.checked,
                  default: e.target.checked ? "" : arg.default,
                })
              }
              data-testid={`${testId}-arg-${i}-required`}
            />
            <Button
              size="sm"
              variant="link"
              aria-label={`Remove argument ${i + 1}`}
              disabled={locked}
              onClick={() =>
                set(
                  "arguments",
                  draft.arguments.filter((_, j) => j !== i),
                )
              }
              data-testid={`${testId}-arg-${i}-remove`}
            >
              <X size={14} aria-hidden="true" />
            </Button>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            variant="outline-secondary"
            disabled={locked || draft.arguments.length >= 20}
            onClick={() =>
              set("arguments", [
                ...draft.arguments,
                argumentDraft({ name: "" }),
              ])
            }
            data-testid={`${testId}-arg-add`}
          >
            <Plus size={14} aria-hidden="true" /> Add argument
          </Button>
        </div>
        {draft.name.trim() && (
          <Form.Text className="text-meta">
            Called as{" "}
            <span className="mono" data-testid={`${testId}-usage`}>
              {skillUsage({
                name: draft.name.trim().toLowerCase(),
                arguments: draft.arguments.filter((a) => a.name.trim()),
              })}
            </span>
          </Form.Text>
        )}
      </fieldset>

      <Form.Group controlId={`${testId}-body`} className="mb-0">
        <Form.Label>Template</Form.Label>
        <Form.Control
          as="textarea"
          rows={8}
          size="sm"
          className="mono"
          value={draft.body}
          maxLength={20_000}
          placeholder={
            "Draft release notes for version $version.\n\nList each merged pull request on one line, newest first, for $audience."
          }
          disabled={locked}
          title={denied}
          onChange={(e) => set("body", e.target.value)}
          data-testid={`${testId}-body`}
        />
        <Form.Text className="text-meta">
          Markdown. <span className="mono">$1</span>,{" "}
          <span className="mono">$2</span>… are the arguments by place,{" "}
          <span className="mono">$name</span> by name, and{" "}
          <span className="mono">$ARGUMENTS</span> all of them. The last
          argument takes the rest of the line.
        </Form.Text>
      </Form.Group>

      <div className="skill-editor-access">
        <TagPicker
          legend="Who may see and attach it"
          tags={tags}
          value={draft.accessRead}
          onChange={(value) => set("accessRead", value)}
          disabled={locked}
          title={denied}
          testId={`${testId}-access-read`}
        />
        <TagPicker
          legend="Who may change it"
          tags={tags}
          value={draft.accessWrite}
          onChange={(value) => set("accessWrite", value)}
          disabled={locked}
          title={denied}
          testId={`${testId}-access-write`}
        />
      </div>

      {withChangeNote && (
        <Form.Group controlId={`${testId}-note`} className="mb-0">
          <Form.Label>
            Why <span className="text-meta">optional</span>
          </Form.Label>
          <Form.Control
            size="sm"
            value={draft.changeNote}
            maxLength={500}
            placeholder="What changed, in a sentence"
            disabled={locked}
            onChange={(e) => set("changeNote", e.target.value)}
            data-testid={`${testId}-note`}
          />
        </Form.Group>
      )}

      <div className="d-flex gap-2">
        <GatedButton
          size="sm"
          type="submit"
          variant="primary"
          disabled={busy}
          deniedReason={denied}
          data-testid={`${testId}-submit`}
        >
          {submitLabel}
        </GatedButton>
        {onCancel && (
          <Button
            size="sm"
            variant="link"
            disabled={busy}
            onClick={onCancel}
            data-testid={`${testId}-cancel`}
          >
            Cancel
          </Button>
        )}
      </div>
    </Form>
  );
}
