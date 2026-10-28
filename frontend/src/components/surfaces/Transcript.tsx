import { ChevronRight, ExternalLink } from "lucide-react";
import { PLATFORM_LABELS, type Platform } from "../../../../design/states";
import {
  Avatar,
  Button,
  PlatformChip,
  SandboxJobGlyph,
  StatusGlyph,
  WorkingGlyph,
} from "../../ui";
import { MarkdownBlock } from "../MarkdownBlock";
import type { TranscriptEntry } from "./types";

/**
 * One tool call: verb, parameter in mono, duration. A call whose result has
 * not arrived spins; a finished one is a quiet chevron.
 * @param props - The call.
 * @returns The row.
 */
function ToolRow({
  verb,
  parameter,
  duration,
  running,
}: {
  verb: string;
  parameter: string;
  duration?: string;
  running?: boolean;
}) {
  return (
    <div className={running ? "tx-action tx-ephemeral" : "tx-action"}>
      {running ? (
        <WorkingGlyph label="Running" />
      ) : (
        <ChevronRight size={14} aria-hidden />
      )}
      <span className="tx-verb">{verb}</span>
      <code className="tx-parameter">{parameter}</code>
      {duration && <span className="tx-duration tabular">{duration}</span>}
    </div>
  );
}

/**
 * The link that sends a person to answer where a question was asked. The
 * platform's own permissions decide who may answer, so the dashboard links
 * rather than offering a button that would bypass them.
 * @param props - Platform and the thread's address.
 * @returns The link.
 */
function AnswerWhereAsked({
  platform,
  href,
}: {
  platform: Platform;
  href: string;
}) {
  return (
    <a
      className="tx-where"
      href={href}
      target="_blank"
      rel="noreferrer noopener"
    >
      Answer in {PLATFORM_LABELS[platform]}
      <ExternalLink size={12} aria-hidden />
    </a>
  );
}

/**
 * One transcript entry, drawn as a line of the log.
 * @param props - The entry.
 * @returns The line.
 */
export function TranscriptLine({ entry }: { entry: TranscriptEntry }) {
  switch (entry.kind) {
    case "message":
      return (
        <div className="tx-message">
          <Avatar name={entry.author} size={20} />
          <div className="tx-body">
            <span className="tx-author">{entry.author}</span>
            <PlatformChip platform={entry.platform} />
            <p>{entry.body}</p>
          </div>
        </div>
      );
    case "bot":
      return (
        <div className="tx-bot">
          <Avatar name={entry.bot} bot size={20} />
          <div className="tx-body">
            <MarkdownBlock>{entry.body}</MarkdownBlock>
          </div>
        </div>
      );
    case "thinking":
      return (
        <div className="tx-thought">
          <span aria-hidden>···</span> thinking: {entry.body}
        </div>
      );
    case "tool":
      return <ToolRow {...entry} />;
    case "code":
      return (
        <div className="tx-card tx-code">
          <div className="tx-card-title">
            <span className="tx-verb">run_code</span>
            <span className="tx-duration tabular">{entry.duration}</span>
          </div>
          <pre className="tx-program">
            <code>{entry.program}</code>
          </pre>
          {entry.calls.map((call) => (
            <ToolRow
              key={call.call}
              verb="host"
              parameter={call.call}
              duration={call.duration}
            />
          ))}
        </div>
      );
    case "sandbox":
      return (
        <div className="tx-card tx-sandbox" data-state={entry.state}>
          <div className="tx-card-title">
            <SandboxJobGlyph state={entry.state} />
            <span>Sandbox</span>
            <code className="tx-parameter">{entry.repository}</code>
            <code className="tx-parameter">{entry.branch}</code>
          </div>
          <div className="tx-nested">
            {entry.steps.map((step) => (
              <ToolRow key={`${step.verb} ${step.parameter}`} {...step} />
            ))}
          </div>
          {entry.pullRequest && (
            <a className="tx-where" href={entry.pullRequest.href}>
              {entry.pullRequest.title}
              <ExternalLink size={12} aria-hidden />
            </a>
          )}
        </div>
      );
    case "question":
      return (
        <div className="tx-card tx-ask" data-testid="tx-question">
          <div className="tx-card-title">
            <StatusGlyph state="waiting" waitingOn="answer" />
            Needs an answer
          </div>
          <MarkdownBlock>{entry.body}</MarkdownBlock>
          <div className="tx-options">
            {entry.options.map((option) => (
              <Button key={option} size="sm" variant="secondary" disabled>
                {option}
              </Button>
            ))}
          </div>
          <AnswerWhereAsked platform={entry.platform} href={entry.href} />
        </div>
      );
    case "approval":
      return (
        <div className="tx-card tx-ask" data-testid="tx-approval">
          <div className="tx-card-title">
            <StatusGlyph state="waiting" waitingOn="approval" />
            Needs approval
          </div>
          <ToolRow verb={entry.tool} parameter={entry.parameter} />
          <AnswerWhereAsked platform={entry.platform} href={entry.href} />
        </div>
      );
    case "error":
      return (
        <div className="tx-error" role="note">
          <StatusGlyph state="ended" outcome="failed" />
          <span>{entry.body}</span>
        </div>
      );
  }
}

/**
 * A conversation's transcript: a log, not a chat. People's messages carry
 * their platform name; the bot's lines carry the bot badge; questions and
 * approvals are the only accented cards.
 * @param props - The entries, in order.
 * @returns The log.
 */
export function Transcript({ entries }: { entries: TranscriptEntry[] }) {
  return (
    <div className="tx-log" data-testid="transcript">
      {entries.map((entry, i) => (
        // A transcript is append-only, so position is a stable key.
        // biome-ignore lint/suspicious/noArrayIndexKey: entries have no id here.
        <TranscriptLine key={i} entry={entry} />
      ))}
    </div>
  );
}
