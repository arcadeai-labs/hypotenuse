import { useEffect, useState } from "react";
import { Form } from "../../ui";
import { SectionCard } from "../sections/SectionCard";
import { useSectionSave } from "../sections/useSectionSave";
import { type BotSectionProps, editBot } from "./IdentitySection";

/** A bot's own code-mode limits, as `bot:edit` takes them. */
export interface CodeLimitFields {
  timeoutMs?: number;
  memoryBytes?: number;
  bridgeRequests?: number;
}

/** The three limit fields, as text. Blank means the deployment's. */
export interface CodeLimitDraft {
  seconds: string;
  memoryMiB: string;
  hostCalls: string;
}

/**
 * The fields' text for a bot's saved limits.
 * @param limits - `bot.codeLimits`.
 * @returns The draft.
 */
export function draftOf(limits: CodeLimitFields): CodeLimitDraft {
  return {
    seconds:
      limits.timeoutMs === undefined ? "" : String(limits.timeoutMs / 1000),
    memoryMiB:
      limits.memoryBytes === undefined
        ? ""
        : String(limits.memoryBytes / (1024 * 1024)),
    hostCalls:
      limits.bridgeRequests === undefined ? "" : String(limits.bridgeRequests),
  };
}

/**
 * Parse the limit fields. A blank field means the deployment's limit; a
 * filled one must be a whole positive number (seconds at least 1, memory at
 * least 8 MiB). Whether it is under the deployment's ceiling is the server's
 * to say.
 * @param draft - The fields.
 * @returns The limits, or a sentence saying what is wrong.
 */
export function parseCodeLimits(
  draft: CodeLimitDraft,
): CodeLimitFields | string {
  const out: CodeLimitFields = {};
  const whole = (text: string) =>
    /^\d+$/.test(text.trim()) ? Number(text.trim()) : null;
  if (draft.seconds.trim()) {
    const n = whole(draft.seconds);
    if (n === null || n < 1)
      return "Time is a whole number of seconds, 1 or more.";
    out.timeoutMs = n * 1000;
  }
  if (draft.memoryMiB.trim()) {
    const n = whole(draft.memoryMiB);
    if (n === null || n < 8)
      return "Memory is a whole number of MiB, 8 or more.";
    out.memoryBytes = n * 1024 * 1024;
  }
  if (draft.hostCalls.trim()) {
    const n = whole(draft.hostCalls);
    if (n === null || n < 1) return "Host calls is a whole number, 1 or more.";
    out.bridgeRequests = n;
  }
  return out;
}

/**
 * Code mode: whether the bot may run short programs (`run_code`) against its
 * memory and MCP tools, and its own limits, which may only lower the
 * deployment's. A blank limit is the deployment's.
 * @param props - See {@link BotSectionProps}.
 * @returns The section.
 */
export function CodeSection({
  projectId,
  bot,
  denied,
  onSaved,
}: BotSectionProps) {
  const { busy, error, notice, setError, setNotice, save } = useSectionSave();
  const saved = draftOf(bot.codeLimits as CodeLimitFields);
  const [enabled, setEnabled] = useState(bot.codeModeEnabled);
  const [draft, setDraft] = useState<CodeLimitDraft>(saved);
  const locked = denied !== undefined;

  useEffect(() => {
    setEnabled(bot.codeModeEnabled);
    setDraft(draftOf(bot.codeLimits as CodeLimitFields));
  }, [bot]);

  const changed =
    enabled !== bot.codeModeEnabled ||
    draft.seconds.trim() !== saved.seconds ||
    draft.memoryMiB.trim() !== saved.memoryMiB ||
    draft.hostCalls.trim() !== saved.hostCalls;

  /** Save the switch and the limits. */
  async function onSave() {
    const limits = parseCodeLimits(draft);
    if (typeof limits === "string") {
      setError(limits);
      return;
    }
    await save(async () => {
      onSaved(
        await editBot(projectId, bot.id, {
          codeModeEnabled: enabled,
          codeLimits: limits,
        }),
      );
    }, "Saved.");
  }

  /**
   * One limit field.
   * @param key - Which.
   * @param label - Its label.
   * @param placeholder - What blank means.
   * @returns The field.
   */
  const field = (
    key: keyof CodeLimitDraft,
    label: string,
    placeholder: string,
  ) => (
    <Form.Group controlId={`bot-code-${key}`} className="mb-0">
      <Form.Label>{label}</Form.Label>
      <Form.Control
        size="sm"
        type="number"
        min={1}
        step={1}
        className="settings-input tabular"
        placeholder={placeholder}
        value={draft[key]}
        disabled={busy || locked || !enabled}
        title={denied}
        onChange={(e) => {
          setDraft((d) => ({ ...d, [key]: e.target.value }));
          setNotice(null);
        }}
        data-testid={`bot-code-${key}`}
      />
    </Form.Group>
  );

  return (
    <SectionCard
      title="Code"
      testId="bot-code"
      idPrefix="bot"
      intro={
        <>
          With code mode, {bot.name} can write a short TypeScript program that
          calls its memory and MCP tools, filters and joins what comes back, and
          returns a small answer. Programs run in an isolated sandbox with no
          network or files, under the same permissions and approvals as its
          tools. Leave a limit blank for the deployment's; a limit can only be
          lowered.
        </>
      }
      error={error}
      notice={notice}
      onDismissError={() => setError(null)}
      onDismissNotice={() => setNotice(null)}
      onSave={onSave}
      canSave={changed}
      saveDeniedReason={denied}
      busy={busy}
    >
      <Form.Check
        type="switch"
        label="Code mode — the bot may run programs (run_code)"
        checked={enabled}
        disabled={busy || locked}
        onChange={(e) => {
          setEnabled(e.target.checked);
          setNotice(null);
        }}
        data-testid="bot-code-enabled"
      />
      <div className="bot-budget-fields mt-3">
        {field("seconds", "Time per program (s)", "30")}
        {field("memoryMiB", "Memory (MiB)", "96")}
        {field("hostCalls", "Host calls per program", "256")}
      </div>
    </SectionCard>
  );
}
