import { Bot } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Chip } from "../../ui";
import { apiFetch } from "../../utils/client";
import { versionSourceLabel } from "../../utils/prompts";
import { useRead } from "../bots/data";
import { DiffBlock } from "../DiffBlock";
import { GatedButton } from "../GatedButton";
import { diffStats, lineDiff } from "../memory/model";
import type {
  PromptSection,
  PromptSectionVersion,
  PromptSectionVersionsResponse,
} from "./data";

/** How many versions the history reads; a section with more shows the newest. */
const HISTORY_LIMIT = 50;

/**
 * The text a version is compared as: its title as a heading over its body,
 * so a renamed section shows the rename in the diff as well.
 * @param v - The version, or nothing before the first.
 * @returns The text.
 */
function versionText(v: Pick<PromptSectionVersion, "title" | "body"> | null) {
  return v ? `# ${v.title}\n\n${v.body}` : "";
}

/**
 * One section's versions, newest first: who wrote each — a person, the bot
 * (marked, and linked to the conversation it wrote it in), a revert — with
 * its change note; the line diff between a chosen version and the one before
 * it; and **Revert** to put an earlier version's text back as a new version.
 * @param props.projectId - The project.
 * @param props.section - The section.
 * @param props.denied - Why the person may not revert, or `undefined`.
 * @param props.onReverted - Called with the section after a revert.
 * @returns The history.
 */
export function SectionHistory({
  projectId,
  section,
  denied,
  onReverted,
}: {
  projectId: number;
  section: PromptSection;
  denied: string | undefined;
  onReverted: (section: PromptSection) => void;
}) {
  const versions = useRead<PromptSectionVersionsResponse>(
    `/project/${projectId}/prompt-section/${section.id}/versions?limit=${HISTORY_LIMIT}`,
  );
  const [chosen, setChosen] = useState<number>(section.currentVersion);
  const { reload } = versions;
  const currentVersion = section.currentVersion;
  // A save or a revert anywhere makes a new version: read the history again,
  // and show the new one.
  const seen = useRef(currentVersion);
  useEffect(() => {
    if (seen.current === currentVersion) return;
    seen.current = currentVersion;
    setChosen(currentVersion);
    reload();
  }, [currentVersion, reload]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = versions.data?.versions ?? [];
  const shown = list.find((v) => v.version === chosen) ?? list[0] ?? null;
  const before = shown
    ? (list.find((v) => v.version === shown.version - 1) ?? null)
    : null;
  const diff = useMemo(
    () =>
      shown && (before || shown.version === 1)
        ? lineDiff(versionText(before), versionText(shown))
        : null,
    [shown, before],
  );

  /**
   * Put a version's text back, as a new version.
   * @param v - The version.
   */
  async function onRevert(v: PromptSectionVersion) {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFetch<{ promptSection: PromptSection }>(
        `/project/${projectId}/prompt-section/${section.id}/revert`,
        { method: "POST", body: JSON.stringify({ version: v.version }) },
      );
      setChosen(res.promptSection.currentVersion);
      onReverted(res.promptSection);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revert it.");
    } finally {
      setBusy(false);
    }
  }

  const testId = `prompt-history-${section.key}`;
  return (
    <div className="prompt-history" data-testid={testId}>
      {versions.error && (
        <p className="text-danger mb-0" data-testid={`${testId}-error`}>
          {versions.error}
        </p>
      )}
      {error && (
        <p className="text-danger mb-0" data-testid={`${testId}-revert-error`}>
          {error}
        </p>
      )}
      {!versions.data && !versions.error && (
        <p className="text-meta mb-0">Loading its versions…</p>
      )}
      <ol className="prompt-history-list">
        {list.map((v) => {
          const current = v.version === section.currentVersion;
          const selected = shown?.version === v.version;
          return (
            <li
              key={v.id}
              className="prompt-history-version"
              data-source={v.source}
              aria-current={selected ? "true" : undefined}
              data-testid={`${testId}-v${v.version}`}
            >
              <button
                type="button"
                className="prompt-history-pick"
                aria-pressed={selected}
                onClick={() => setChosen(v.version)}
                data-testid={`${testId}-pick-v${v.version}`}
              >
                <span className="tabular">v{v.version}</span>
              </button>
              {v.source === "agent" ? (
                <Chip
                  className="prompt-chip-agent"
                  icon={<Bot size={12} aria-hidden="true" />}
                  data-testid={`${testId}-agent-v${v.version}`}
                >
                  {versionSourceLabel(v.source)}
                </Chip>
              ) : (
                <span className="text-meta">
                  {versionSourceLabel(v.source)}
                </span>
              )}
              <span className="text-meta tabular">
                {new Date(v.createdAt).toLocaleString()}
              </span>
              {v.conversationId !== null && (
                <Link
                  to={`/conversations/${v.conversationId}`}
                  className="text-meta"
                  data-testid={`${testId}-conversation-v${v.version}`}
                >
                  In conversation #{v.conversationId}
                </Link>
              )}
              {v.changeNote && (
                <span className="prompt-history-note">{v.changeNote}</span>
              )}
              <span className="prompt-history-actions">
                {current ? (
                  <Chip>Current</Chip>
                ) : (
                  <GatedButton
                    size="sm"
                    variant="outline-secondary"
                    disabled={busy}
                    deniedReason={denied}
                    onClick={() => onRevert(v)}
                    data-testid={`${testId}-revert-v${v.version}`}
                  >
                    Revert to this
                  </GatedButton>
                )}
              </span>
            </li>
          );
        })}
      </ol>
      {shown && diff && (
        <section
          className="prompt-history-diff"
          data-testid={`${testId}-diff`}
          aria-label={`Changes in version ${shown.version}`}
        >
          <h4 className="prompt-history-diff-title">
            {shown.version === 1
              ? "Version 1, as first written"
              : `Changes from v${shown.version - 1} to v${shown.version}`}
            <span className="text-meta tabular">
              {" "}
              +{diffStats(diff).added} −{diffStats(diff).removed}
            </span>
          </h4>
          <DiffBlock diff={diff} />
        </section>
      )}
      {shown && !diff && shown.version > 1 && (
        <p className="text-meta mb-0">
          The version before v{shown.version} is older than this history shows.{" "}
          <Button
            size="sm"
            variant="link"
            onClick={() =>
              setChosen(list[0]?.version ?? section.currentVersion)
            }
          >
            Show the newest
          </Button>
        </p>
      )}
    </div>
  );
}
