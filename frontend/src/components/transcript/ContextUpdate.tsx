import { useState } from "react";
import { useAuth } from "../../context/AuthContext";
import { Button } from "../../ui";
import { apiFetch } from "../../utils/client";
import { DiffBlock } from "../DiffBlock";
import { MarkdownBlock } from "../MarkdownBlock";
import { type DiffLine, lineDiff } from "../memory/model";
import type {
  PromptSectionVersion,
  PromptSectionVersionsResponse,
} from "../prompts/data";
import { promptChangeSummary, type TranscriptItem } from "./model";

/**
 * A section version as it is compared: its title over its body.
 * @param v - The version, or nothing.
 * @returns The text.
 */
function versionText(v: PromptSectionVersion | undefined): string {
  return v ? `# ${v.title}\n\n${v.body}` : "";
}

/** One changed section's diff, as it loads. */
type ChangeDiff =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "loaded"; diff: DiffLine[] }
  | { state: "failed"; message: string };

/**
 * One section that changed between steps, with **Show the change**: its two
 * versions are read from the section's history and diffed, so the reader
 * sees exactly which words the model was told differently.
 * @param props.sectionId - The section.
 * @param props.label - Its key.
 * @param props.from - The version the previous step had.
 * @param props.to - The version this step had.
 * @returns The row.
 */
function ChangedSection({
  sectionId,
  label,
  from,
  to,
}: {
  sectionId: number;
  label: string;
  from: number;
  to: number;
}) {
  const { activeProjectId } = useAuth();
  const [diff, setDiff] = useState<ChangeDiff>({ state: "idle" });

  /** Read both versions and diff them. */
  async function load() {
    if (!activeProjectId) return;
    setDiff({ state: "loading" });
    try {
      // The history is newest first; both versions are within its reach
      // unless the section has been edited many times since.
      const res = await apiFetch<PromptSectionVersionsResponse>(
        `/project/${activeProjectId}/prompt-section/${sectionId}/versions?limit=100`,
      );
      const find = (n: number) => res.versions.find((v) => v.version === n);
      const after = find(to);
      if (!after) throw new Error(`Version ${to} is no longer in its history.`);
      setDiff({
        state: "loaded",
        diff: lineDiff(versionText(find(from)), versionText(after)),
      });
    } catch (err) {
      setDiff({
        state: "failed",
        message:
          err instanceof Error ? err.message : "Could not read its versions.",
      });
    }
  }

  return (
    <li data-testid={`tx-prompt-changed-${label}`}>
      <span className="mono">{label}</span>{" "}
      <span className="tabular">
        v{from} → v{to}
      </span>{" "}
      {diff.state === "idle" && (
        <Button
          size="sm"
          variant="link"
          onClick={load}
          data-testid={`tx-prompt-diff-${label}`}
        >
          Show the change
        </Button>
      )}
      {diff.state === "loading" && <span>Reading its versions…</span>}
      {diff.state === "failed" && (
        <span className="text-danger">{diff.message}</span>
      )}
      {diff.state === "loaded" && <DiffBlock diff={diff.diff} />}
    </li>
  );
}

/**
 * A step's prompt differing from the one before, collapsed to one system
 * line — "Prompt changed: how-i-work v1 → v2" — that opens to which sections
 * were added, removed, or changed (each change diffable), which contextual
 * ones the budget dropped, its size, and the full text the step was sent.
 * @param props.item - The change.
 * @returns The line.
 */
export function PromptChangeLine({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "prompt" }>;
}) {
  const summary = promptChangeSummary(item);
  return (
    <details className="tx-fold tx-status tx-context" data-testid="tx-prompt">
      <summary>
        <span className="tx-status-text">
          {item.first ? "Prompt set" : "Prompt changed"}
        </span>
        {summary && (
          <span className="tx-status-detail" data-testid="tx-prompt-summary">
            {summary}
          </span>
        )}
      </summary>
      <div className="tx-context-detail">
        {item.changed.length > 0 && (
          <div>
            <span className="tx-context-label">Changed</span>
            <ul className="tx-context-list">
              {item.changed.map((c) => (
                <ChangedSection
                  key={c.id}
                  sectionId={c.id}
                  label={c.key}
                  from={c.previousVersion}
                  to={c.version}
                />
              ))}
            </ul>
          </div>
        )}
        {!item.first && item.added.length > 0 && (
          <SectionList label="Added" refs={item.added} testId="added" />
        )}
        {item.removed.length > 0 && (
          <SectionList label="Removed" refs={item.removed} testId="removed" />
        )}
        {item.first && item.sections.length > 0 && (
          <SectionList label="Sections" refs={item.sections} testId="all" />
        )}
        {item.dropped.length > 0 && (
          <SectionList
            label="Matched, but dropped to fit the budget"
            refs={item.dropped}
            testId="dropped"
          />
        )}
        {item.estimatedTokens !== null && item.budgetTokens !== null && (
          <p className="tx-call-note tabular">
            About {item.estimatedTokens.toLocaleString()} of{" "}
            {item.budgetTokens.toLocaleString()} tokens.
          </p>
        )}
        <details className="tx-fold">
          <summary className="tx-context-label">The text it was sent</summary>
          <pre className="tx-program tx-context-prompt">
            <code>{item.prompt}</code>
          </pre>
        </details>
      </div>
    </details>
  );
}

/**
 * A labelled list of sections by key and version.
 * @param props - The label, the refs, and a test id suffix.
 * @returns The list.
 */
function SectionList({
  label,
  refs,
  testId,
}: {
  label: string;
  refs: readonly { id: number; key: string; version: number }[];
  testId: string;
}) {
  return (
    <div data-testid={`tx-prompt-${testId}`}>
      <span className="tx-context-label">{label}</span>
      <ul className="tx-context-list">
        {refs.map((r) => (
          <li key={r.id}>
            <span className="mono">{r.key}</span>{" "}
            <span className="tabular">v{r.version}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * A person's `/skill` message expanded, as one system line — "Ran skill
 * /release-notes" — that opens to the instructions the model read in place
 * of the message, or to why the skill could not be filled in (a required
 * argument missing), which the bot was told too.
 * @param props.item - The run.
 * @returns The line.
 */
export function SkillRunLine({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "skill" }>;
}) {
  const failed = item.text === null;
  return (
    <details
      className="tx-fold tx-status tx-context"
      data-tone={failed ? "error" : "quiet"}
      data-testid="tx-skill"
      data-skill={item.name}
    >
      <summary>
        <span className="tx-status-text">
          {failed ? "Could not run skill" : "Ran skill"}{" "}
          <span className="mono">/{item.name}</span>
        </span>
        {item.version !== null && (
          <span className="tx-status-detail tabular">v{item.version}</span>
        )}
      </summary>
      <div className="tx-context-detail">
        {failed ? (
          <p className="tx-call-note" data-testid="tx-skill-error">
            {item.error}
          </p>
        ) : (
          <>
            <span className="tx-context-label">
              What the bot read in place of the message
            </span>
            <div className="tx-context-expansion" data-testid="tx-skill-text">
              <MarkdownBlock>{item.text ?? ""}</MarkdownBlock>
            </div>
          </>
        )}
        {item.arguments && (
          <p className="tx-call-note">
            Arguments: <code className="tx-parameter">{item.arguments}</code>
          </p>
        )}
      </div>
    </details>
  );
}
