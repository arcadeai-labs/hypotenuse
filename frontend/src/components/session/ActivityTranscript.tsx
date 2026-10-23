import { useState } from "react";
import { AgentBadge, Avatar, Button, Chip, Mark, RoleChip } from "../../ui";
import { cx } from "../../ui/cx";
import { waitingLabel } from "../../utils/sessions";
import { noteParts } from "../../utils/telemetry";
import {
  actionOf,
  bodyOf,
  collapseResult,
  type SessionTurn,
  selectOptions,
  type TranscriptEntry,
  type TurnGroup,
  turnDuration,
} from "../../utils/transcript";
import { MarkdownBlock } from "../MarkdownBlock";
import { PlanChecklist, type PlanStep } from "./PlanChecklist";

/** See {@link ActivityTranscript}. */
export interface ActivityTranscriptProps {
  groups: TurnGroup[];
  /** The plan, and the group it is pinned to (-1 for none). */
  plan: PlanStep[] | null;
  planIndex: number;
  /** Who started the session in Linear, for the prompts with no other name. */
  creatorName: string | null;
  /** Where Linear shows the session, for elicitation deep links. */
  linearUrl: string | null;
  now: number;
}

/**
 * The session transcript: a log, not a chat. Turn separators carry the work
 * item; a person's prompts sit flush with an avatar; agent lines carry the
 * mark. Thoughts are dim and one line until opened; an ephemeral line Linear
 * has replaced stays in the log, struck through and collapsed; an action is
 * one row that opens to its result; an elicitation is the one accented card,
 * and its answer happens in Linear. Every body is model-authored Markdown and
 * goes through `MarkdownBlock`.
 * @param props - See {@link ActivityTranscriptProps}.
 * @returns The transcript.
 */
export function ActivityTranscript({
  groups,
  plan,
  planIndex,
  creatorName,
  linearUrl,
  now,
}: ActivityTranscriptProps) {
  if (groups.length === 0) {
    return (
      <p className="text-muted" data-testid="transcript-empty">
        Nothing has been said in this session yet.
      </p>
    );
  }
  return (
    <ol className="transcript" data-testid="transcript">
      {groups.map((group, index) => (
        <li
          key={group.turn?.id ?? "before"}
          className="transcript-turn"
          data-testid={
            group.turn ? `transcript-turn-${group.turn.id}` : "transcript-pre"
          }
        >
          {group.turn && (
            <TurnSeparator
              turn={group.turn}
              ordinal={groups.slice(0, index + 1).filter((g) => g.turn).length}
              now={now}
            />
          )}
          {index === planIndex && plan && plan.length > 0 && (
            <PlanChecklist steps={plan} />
          )}
          <ol className="transcript-lines">
            {group.entries.map((entry) => (
              <TranscriptLine
                key={entry.activity.id}
                entry={entry}
                creatorName={creatorName}
                linearUrl={linearUrl}
              />
            ))}
          </ol>
        </li>
      ))}
    </ol>
  );
}

/**
 * A turn's separator: kind, runner, agent, role, duration, and outcome — and
 * for a waiting turn, why it waits.
 * @param props - The turn, its place in the session (1 for the first), and the clock.
 * @returns The separator.
 */
function TurnSeparator({
  turn,
  ordinal,
  now,
}: {
  turn: SessionTurn;
  ordinal: number;
  now: number;
}) {
  const duration = turnDuration(turn, now);
  const waiting =
    turn.status === "queued" ? waitingLabel(turn.waitingCode) : null;
  return (
    <div className="transcript-separator" data-testid="turn-separator">
      <span className="transcript-separator-label">
        Turn {ordinal} · {turn.kind.replace("_", " ")}
      </span>
      {turn.runnerName && <span>{turn.runnerName}</span>}
      {turn.agentId && <AgentBadge kind={turn.agentId} />}
      {turn.role && <RoleChip role={turn.role} />}
      {duration && <span className="tabular">{duration}</span>}
      <Chip data-testid={`turn-status-${turn.id}`}>{turn.status}</Chip>
      {waiting && <span className="text-muted">{waiting}</span>}
      {turn.telemetry?.note && <TelemetryNote note={turn.telemetry.note} />}
    </div>
  );
}

/**
 * Why a turn's telemetry was exported at less than the project asked — the
 * runner's owner capped it — as one quiet line on the separator.
 * @param props - The server's note, with names in backticks.
 * @returns The note.
 */
export function TelemetryNote({ note }: { note: string }) {
  return (
    <span className="text-muted w-100" data-testid="turn-telemetry-note">
      {noteParts(note).map((part, i) =>
        part.code ? (
          // The parts are fixed for a given note, so the index is stable.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <code key={i}>{part.text}</code>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <span key={i}>{part.text}</span>
        ),
      )}
    </span>
  );
}

/**
 * One line of the transcript, drawn by its content type.
 * @param props - The entry, and what the line needs from the session.
 * @returns The line.
 */
function TranscriptLine({
  entry,
  creatorName,
  linearUrl,
}: {
  entry: TranscriptEntry;
  creatorName: string | null;
  linearUrl: string | null;
}) {
  const { activity, replaced, live } = entry;
  const [open, setOpen] = useState(false);
  const type = activity.contentType ?? "thought";
  const className = cx(
    "transcript-line",
    `transcript-${type}`,
    replaced && "transcript-replaced",
    live && "transcript-live",
  );
  const testId = `activity-${activity.id}`;

  if (activity.direction === "inbound") {
    const who = creatorName ?? "Someone in Linear";
    return (
      <li className={className} data-testid={testId}>
        <Avatar name={who} />
        <div className="transcript-body">
          <span className="transcript-who">{who}</span>
          {activity.signal && <Chip>{activity.signal}</Chip>}
          <MarkdownBlock>{bodyOf(activity.content)}</MarkdownBlock>
        </div>
      </li>
    );
  }

  // A replaced line is collapsed to one struck-through line until opened.
  if (replaced && !open) {
    return (
      <li className={className} data-testid={testId}>
        <Mark size={12} label={null} className="transcript-mark" />
        <button
          type="button"
          className="transcript-toggle"
          onClick={() => setOpen(true)}
          aria-label="Show the replaced line"
          data-testid={`${testId}-expand`}
        >
          <s>{lineSummary(activity.content, type)}</s>
        </button>
      </li>
    );
  }

  return (
    <li className={className} data-testid={testId}>
      <Mark size={12} label={null} className="transcript-mark" />
      <div className="transcript-body">
        {type === "action" ? (
          <ActionRow content={activity.content} />
        ) : type === "thought" ? (
          <ThoughtLine body={bodyOf(activity.content)} />
        ) : type === "elicitation" ? (
          <div className="transcript-elicitation" data-testid="elicitation">
            <div className="text-meta">Needs an answer in Linear</div>
            <MarkdownBlock>{bodyOf(activity.content)}</MarkdownBlock>
            <div className="transcript-options">
              {selectOptions(activity.signalMetadata).map((option) =>
                linearUrl ? (
                  <a
                    key={option}
                    className="ui-button btn btn-outline-secondary ui-variant-outline-secondary ui-button-sm btn-sm"
                    href={linearUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {option}
                  </a>
                ) : (
                  <Chip key={option}>{option}</Chip>
                ),
              )}
              {activity.signal === "auth" && <Chip>sign-in requested</Chip>}
              {linearUrl && (
                <a href={linearUrl} target="_blank" rel="noreferrer">
                  Answer in Linear ↗
                </a>
              )}
            </div>
          </div>
        ) : (
          <MarkdownBlock>{bodyOf(activity.content)}</MarkdownBlock>
        )}
        {activity.deliveryStatus === "pending" && (
          <span className="text-meta">sending…</span>
        )}
        {activity.deliveryStatus === "failed" && (
          <span className="transcript-failed text-meta">
            not delivered to Linear
            {activity.lastError ? `: ${activity.lastError}` : ""}
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * A replaced line's one-line summary.
 * @param content - The activity content.
 * @param type - Its content type.
 * @returns The summary.
 */
function lineSummary(content: unknown, type: string): string {
  if (type === "action") {
    const a = actionOf(content);
    return `${a.action} ${a.parameter}`.trim();
  }
  return bodyOf(content).split("\n")[0];
}

/**
 * A thought: dim, one line with a `···` lead until opened.
 * @param props - The body.
 * @returns The line.
 */
function ThoughtLine({ body }: { body: string }) {
  const [open, setOpen] = useState(false);
  const multiline = body.includes("\n") || body.length > 140;
  if (!multiline || open) {
    return <MarkdownBlock>{body}</MarkdownBlock>;
  }
  return (
    <button
      type="button"
      className="transcript-toggle"
      onClick={() => setOpen(true)}
    >
      ··· {body.split("\n")[0].slice(0, 140)}
    </button>
  );
}

/**
 * An action: verb, the parameter in mono, and the result folded past eight
 * lines.
 * @param props - The activity content.
 * @returns The row.
 */
function ActionRow({ content }: { content: unknown }) {
  const { action, parameter, result } = actionOf(content);
  const [open, setOpen] = useState(false);
  const collapsed = result ? collapseResult(result) : null;
  return (
    <div className="transcript-action-row">
      <div>
        <span className="transcript-verb">{action}</span>{" "}
        <code>{parameter}</code>
      </div>
      {collapsed && (
        <pre className="transcript-result" data-testid="action-result">
          {open ? result : collapsed.head}
        </pre>
      )}
      {collapsed && collapsed.hidden > 0 && (
        <Button
          size="sm"
          variant="link"
          onClick={() => setOpen((v) => !v)}
          data-testid="action-result-toggle"
        >
          {open ? "Show less" : `Show ${collapsed.hidden} more lines`}
        </Button>
      )}
    </div>
  );
}
