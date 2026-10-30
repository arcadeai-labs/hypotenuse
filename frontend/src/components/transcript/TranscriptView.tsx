import { useEffect, useRef } from "react";
import type { Platform } from "../../../../design/states";
import { Avatar, Button, PlatformChip, StatusGlyph } from "../../ui";
import { MarkdownBlock } from "../MarkdownBlock";
import type { TranscriptItem } from "./model";
import { ToolCall } from "./ToolCall";

/** Who a transcript's speakers are, as the page knows them. */
export interface TranscriptSpeakers {
  /** The bot's name, beside its badge. */
  botName: string;
  /** The bot's avatar URL, when it has one. */
  botAvatar?: string;
  /** Where the conversation lives, for the chip on a person's message. */
  platform: Platform;
  /** A person's display name from their user id. */
  personName: (userId: number | null) => string;
}

/** What the end of a bot's turn adds beside its badge. */
const TOOL_NOTES: Record<string, string | undefined> = {
  complete: "completed",
  fail: "failed",
};

/**
 * One item of the transcript, drawn as a line of the log.
 * @param props.item - The item.
 * @param props.speakers - Who is speaking.
 * @param props.questionOpen - Whether this is the question the bot waits on.
 * @returns The line.
 */
function TranscriptItemLine({
  item,
  speakers,
  questionOpen,
}: {
  item: TranscriptItem;
  speakers: TranscriptSpeakers;
  questionOpen: boolean;
}) {
  switch (item.kind) {
    case "person": {
      const name = speakers.personName(item.userId);
      return (
        <div className="tx-message" data-testid="tx-person">
          <Avatar name={name} size={20} />
          <div className="tx-body">
            <span className="tx-author">{name}</span>
            <PlatformChip platform={speakers.platform} />
            <p className="tx-text">{item.text}</p>
          </div>
        </div>
      );
    }
    case "bot":
      return (
        <div
          className={item.tool === "fail" ? "tx-bot tx-bot-failed" : "tx-bot"}
          data-testid="tx-bot"
          data-tool={item.tool}
        >
          <Avatar
            name={speakers.botName}
            src={speakers.botAvatar}
            bot
            size={20}
          />
          <div className="tx-body">
            {TOOL_NOTES[item.tool] && (
              <span className="tx-bot-note">{TOOL_NOTES[item.tool]}</span>
            )}
            <MarkdownBlock>{item.text}</MarkdownBlock>
          </div>
        </div>
      );
    case "question":
      return (
        <div className="tx-card tx-ask" data-testid="tx-question">
          <div className="tx-card-title">
            <StatusGlyph state="waiting" waitingOn="answer" />
            {questionOpen ? "Needs an answer" : "Asked"}
          </div>
          <MarkdownBlock>{item.question}</MarkdownBlock>
          {item.options.length > 0 && (
            <div className="tx-options">
              {item.options.map((option) => (
                <Button key={option} size="sm" variant="secondary" disabled>
                  {option}
                </Button>
              ))}
            </div>
          )}
          {questionOpen && (
            <p className="tx-call-note">
              Answer with a message below: the next message is the answer.
            </p>
          )}
        </div>
      );
    case "note":
      return (
        <div className="tx-note" data-testid="tx-note">
          <span className="tx-note-label">{speakers.botName}, not posted:</span>{" "}
          {item.text}
        </div>
      );
    case "thinking":
      return (
        <details className="tx-fold tx-thought" data-testid="tx-thinking">
          <summary>
            <span aria-hidden>···</span> thinking: {item.text}
          </summary>
          <p className="tx-text">{item.text}</p>
        </details>
      );
    case "tool":
      return <ToolCall item={item} />;
    case "status":
      return (
        <div
          className="tx-status"
          data-tone={item.tone}
          data-testid="tx-status"
          title={new Date(item.createdAt).toLocaleString()}
        >
          <span className="tx-status-text">{item.text}</span>
          {item.detail && (
            <span className="tx-status-detail">{item.detail}</span>
          )}
        </div>
      );
    case "prompt":
      return (
        <details className="tx-fold tx-status" data-testid="tx-prompt">
          <summary>
            <span className="tx-status-text">Instructions updated</span>
          </summary>
          <pre className="tx-program">
            <code>{item.prompt}</code>
          </pre>
        </details>
      );
    case "compaction":
      return (
        <details className="tx-fold tx-divider" data-testid="tx-compaction">
          <summary>
            <span>Summarized up to entry {item.throughSeq}</span>
          </summary>
          <div className="tx-divider-summary">
            <MarkdownBlock>{item.summary}</MarkdownBlock>
          </div>
        </details>
      );
  }
}

/**
 * A conversation's transcript, drawn from its entries: a log, not a chat.
 * People's messages carry their name and the platform; the bot's carry its
 * avatar and badge; tool calls are collapsed rows; state changes are small
 * system lines; a compaction is a divider.
 *
 * It follows: while the reader is at the bottom, new lines keep the bottom
 * in view; once they scroll up, it stays put.
 * @param props.items - What to draw, in order.
 * @param props.speakers - Who is speaking.
 * @param props.waitingOnAnswer - Whether the conversation waits on an answer, so its last question is open.
 * @param props.highlight - Entries to mark, such as those a memory was learned from.
 * @returns The log.
 */
export function TranscriptView({
  items,
  speakers,
  waitingOnAnswer,
  highlight,
}: {
  items: TranscriptItem[];
  speakers: TranscriptSpeakers;
  waitingOnAnswer: boolean;
  highlight?: ReadonlySet<number>;
}) {
  const end = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);

  useEffect(() => {
    const node = end.current;
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((records) => {
      for (const record of records) atBottom.current = record.isIntersecting;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const count = items.length;
  useEffect(() => {
    if (count > 0 && atBottom.current) {
      end.current?.scrollIntoView?.({ block: "end" });
    }
  }, [count]);

  let lastQuestion = -1;
  items.forEach((item, i) => {
    if (item.kind === "question") lastQuestion = i;
  });

  return (
    <div className="tx-log" data-testid="transcript">
      {items.length === 0 && (
        <p className="tx-empty">Nothing has been said yet.</p>
      )}
      {items.map((item, i) => {
        const line = (
          <TranscriptItemLine
            key={item.key}
            item={item}
            speakers={speakers}
            questionOpen={waitingOnAnswer && i === lastQuestion}
          />
        );
        return highlight?.has(item.seq) ? (
          <div
            key={item.key}
            className="tx-highlight"
            data-seq={item.seq}
            data-testid="tx-highlight"
          >
            {line}
          </div>
        ) : (
          line
        );
      })}
      <div ref={end} className="tx-end" aria-hidden="true" />
    </div>
  );
}
