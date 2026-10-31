import { ChevronRight, TriangleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { Platform } from "../../../../design/states";
import {
  Avatar,
  Button,
  Chip,
  CompleteGlyph,
  FailedGlyph,
  PlatformChip,
  StatusGlyph,
  WorkingGlyph,
} from "../../ui";
import { approvalStatusLabel, expiresInWords } from "../../utils/mcp";
import { GatedButton } from "../GatedButton";
import { JsonBlock } from "../JsonBlock";
import { MarkdownBlock } from "../MarkdownBlock";
import type { ApprovalRow } from "../mcp/data";
import {
  type ChatItem,
  diagnosticsLine,
  type LiveSurface,
  type PlanStep,
  type StepDiagnostics,
  stepsHref,
  stepsLabel,
} from "./model";

/** Who the chat's speakers are, as the page knows them. */
export interface ChatSpeakers {
  botName: string;
  botAvatar?: string;
  /** Where the conversation lives, for the chip on a platform person's message. */
  platform: Platform;
  /** The name on a person's message. */
  speakerName: (who: {
    userId: number | null;
    participantId: number | null;
  }) => string;
}

/** What the person reading may do in place, as the server decided it. */
export interface ChatStanding {
  /** Answer the open question with one of its options. */
  canAnswer: boolean;
  /** Approve or deny the calls the conversation waits on. */
  canDecideApprovals: boolean;
}

/** See {@link ChatLog}. */
export interface ChatLogProps {
  conversationId: number;
  items: ChatItem[];
  speakers: ChatSpeakers;
  standing: ChatStanding;
  /** The live surface, while the bot works. */
  live: LiveSurface | null;
  /** The conversation's approvals, read with `approval:list`. */
  approvals: readonly ApprovalRow[];
  /** Ids the conversation waits on now, for a card whose approvals are not read yet. */
  waitingApprovalIds: readonly number[];
  /** Send an option's label as the answer. */
  onAnswer: (option: string) => Promise<void>;
  /** Approve or deny one call. */
  onDecide: (approvalId: number, decision: "approve" | "deny") => Promise<void>;
}

/**
 * A bubble's diagnostics, collapsed: the step's model, tokens, duration, and
 * prompt hash.
 * @param props.diagnostics - What the step recorded.
 * @returns The fold, or nothing when the step recorded nothing.
 */
function Diagnostics({ diagnostics }: { diagnostics: StepDiagnostics | null }) {
  if (!diagnostics) return null;
  const line = diagnosticsLine(diagnostics);
  if (!line) return null;
  return (
    <details className="chat-diagnostics" data-testid="chat-diagnostics">
      <summary>
        <ChevronRight size={12} aria-hidden="true" className="tx-chevron" />
        Details
      </summary>
      <span className="chat-diagnostics-line mono">{line}</span>
    </details>
  );
}

/**
 * The bot's avatar column, beside a bubble.
 * @param props.speakers - Who is speaking.
 * @returns The avatar, with its badge.
 */
function BotAvatar({ speakers }: { speakers: ChatSpeakers }) {
  return (
    <Avatar name={speakers.botName} src={speakers.botAvatar} bot size={24} />
  );
}

/**
 * One call the conversation waits on, decidable in place.
 * @param props.approval - The approval.
 * @param props.canDecide - Whether the reader may decide it.
 * @param props.onDecide - Decide it.
 * @returns The row.
 */
function ApprovalLine({
  approval,
  canDecide,
  onDecide,
}: {
  approval: ApprovalRow;
  canDecide: boolean;
  onDecide: ChatLogProps["onDecide"];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = approval.status === "pending";
  const denied = canDecide
    ? undefined
    : "Only people who may change this bot, or hold its approver tag, decide its calls.";

  /**
   * @param decision - Approve or deny.
   */
  async function decide(decision: "approve" | "deny") {
    setBusy(true);
    setError(null);
    try {
      await onDecide(approval.id, decision);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not decide it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="chat-approval-line"
      data-testid={`chat-approval-${approval.id}`}
      data-status={approval.status}
    >
      <div className="chat-approval-head">
        <span className="mono">{approval.name}</span>
        {pending ? (
          <span className="text-meta tabular">
            {expiresInWords(approval.expiresAt)}
          </span>
        ) : (
          <Chip data-testid="chat-approval-status">
            {approvalStatusLabel(approval.status)}
          </Chip>
        )}
      </div>
      <JsonBlock value={approval.args} label="Arguments" />
      {pending && (
        <div className="tx-options">
          <GatedButton
            size="sm"
            variant="primary"
            deniedReason={denied}
            disabled={busy}
            onClick={() => decide("approve")}
            data-testid="chat-approve"
          >
            Approve
          </GatedButton>
          <GatedButton
            size="sm"
            variant="outline-danger"
            deniedReason={denied}
            disabled={busy}
            onClick={() => decide("deny")}
            data-testid="chat-deny"
          >
            Deny
          </GatedButton>
          <Link to={`/approvals/${approval.id}`} className="chat-approval-link">
            Open the approval
          </Link>
        </div>
      )}
      {error && (
        <p className="chat-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * The plan of the turn under way: one row per tool step, with its state.
 * @param props.steps - The steps.
 * @returns The list.
 */
function PlanList({ steps }: { steps: readonly PlanStep[] }) {
  return (
    <ol className="chat-plan" data-testid="chat-plan">
      {steps.map((step) => (
        <li key={step.seq} data-state={step.state}>
          {step.state === "running" ? (
            <WorkingGlyph label="Running" />
          ) : step.state === "error" ? (
            <FailedGlyph label="Failed" />
          ) : (
            <CompleteGlyph label="Done" />
          )}
          <span className="mono">{step.tool}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * A question the bot asked. Its options are buttons while it is the open
 * question and the reader may answer; a click sends the option's label.
 * @param props.item - The question.
 * @param props.speakers - Who is speaking.
 * @param props.live - Whether it can be answered now.
 * @param props.onAnswer - Send an option as the answer.
 * @returns The card.
 */
function QuestionCard({
  item,
  speakers,
  live,
  onAnswer,
}: {
  item: Extract<ChatItem, { kind: "question" }>;
  speakers: ChatSpeakers;
  live: boolean;
  onAnswer: ChatLogProps["onAnswer"];
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * @param option - The option chosen.
   */
  async function answer(option: string) {
    setBusy(true);
    setError(null);
    try {
      await onAnswer(option);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not answer it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="chat-row chat-row-bot" data-testid="chat-question">
      <BotAvatar speakers={speakers} />
      <div className="tx-card tx-ask chat-card">
        <div className="tx-card-title">
          <StatusGlyph state="waiting" waitingOn="answer" />
          {live ? "Needs an answer" : "Asked"}
        </div>
        <MarkdownBlock>{item.question}</MarkdownBlock>
        {item.options.length > 0 && (
          <div className="tx-options">
            {item.options.map((option) => (
              <Button
                key={option}
                size="sm"
                variant="secondary"
                disabled={!live || busy}
                onClick={() => answer(option)}
                data-testid="chat-option"
              >
                {option}
              </Button>
            ))}
          </div>
        )}
        {live && (
          <p className="tx-call-note">
            {item.options.length > 0
              ? "Choose one, or write your own answer below."
              : "Write your answer below."}
          </p>
        )}
        {error && (
          <p className="chat-error" role="alert">
            {error}
          </p>
        )}
        <Diagnostics diagnostics={item.diagnostics} />
      </div>
    </div>
  );
}

/**
 * One item of the chat.
 * @param props - The item, and everything {@link ChatLog} has.
 * @returns The line.
 */
function ChatLine({
  item,
  ...props
}: Omit<ChatLogProps, "items" | "live"> & { item: ChatItem }) {
  const { speakers, standing } = props;
  switch (item.kind) {
    case "person": {
      const name = speakers.speakerName(item);
      return (
        <div className="chat-row chat-row-person" data-testid="chat-person">
          <div className="chat-bubble chat-bubble-person">
            <div className="chat-bubble-head">
              <span className="chat-author">{name}</span>
              {item.participantId !== null && (
                <PlatformChip platform={speakers.platform} />
              )}
            </div>
            <p className="tx-text">{item.text}</p>
          </div>
          <Avatar name={name} size={24} />
        </div>
      );
    }
    case "system":
      return (
        <div
          className="chat-system"
          data-tone={item.tone}
          data-testid="chat-system"
          title={new Date(item.createdAt).toLocaleString()}
        >
          {item.text}
        </div>
      );
    case "bot":
      return (
        <div
          className="chat-row chat-row-bot"
          data-testid="chat-bot"
          data-tool={item.tool}
        >
          <BotAvatar speakers={speakers} />
          <div
            className="chat-bubble chat-bubble-bot"
            data-outcome={item.outcome ?? undefined}
          >
            <MarkdownBlock>{item.text}</MarkdownBlock>
            <div className="chat-bubble-foot">
              {item.outcome && (
                <Chip
                  tone={item.outcome === "completed" ? "accent" : "subtle"}
                  className="chat-outcome"
                  data-outcome={item.outcome}
                  data-testid="chat-outcome"
                  icon={
                    item.outcome === "completed" ? (
                      <CompleteGlyph label={null} />
                    ) : (
                      <FailedGlyph label={null} />
                    )
                  }
                >
                  {item.outcome === "completed" ? "Completed" : "Failed"}
                </Chip>
              )}
              <Diagnostics diagnostics={item.diagnostics} />
            </div>
          </div>
        </div>
      );
    case "question":
      return (
        <QuestionCard
          item={item}
          speakers={speakers}
          live={item.latest && standing.canAnswer}
          onAnswer={props.onAnswer}
        />
      );
    case "approval": {
      const matched = props.approvals.filter(
        (a) => a.entryId !== null && item.callEntryIds.includes(a.entryId),
      );
      return (
        <div className="chat-row chat-row-bot" data-testid="chat-approval">
          <BotAvatar speakers={speakers} />
          <div className="tx-card tx-ask chat-card">
            <div className="tx-card-title">
              <StatusGlyph state="waiting" waitingOn="approval" />
              {matched.some((a) => a.status === "pending")
                ? "Waiting for approval"
                : matched.length > 0
                  ? "Waited for approval"
                  : "Waiting for approval"}
            </div>
            {matched.length > 0
              ? matched.map((a) => (
                  <ApprovalLine
                    key={a.id}
                    approval={a}
                    canDecide={standing.canDecideApprovals}
                    onDecide={props.onDecide}
                  />
                ))
              : props.waitingApprovalIds.map((id) => (
                  <Link key={id} to={`/approvals/${id}`}>
                    See the approval
                  </Link>
                ))}
          </div>
        </div>
      );
    }
    case "steps":
      return (
        <div className="chat-steps" data-testid="chat-steps">
          {item.running ? (
            <WorkingGlyph label="Working" />
          ) : item.warning ? (
            <TriangleAlert
              size={14}
              className="chat-steps-warning"
              aria-label="A step failed or was interrupted"
              data-testid="chat-steps-warning"
            />
          ) : null}
          <Link
            to={stepsHref(props.conversationId, item.seqs)}
            data-testid="chat-steps-link"
          >
            {stepsLabel(item.count)}
          </Link>
        </div>
      );
    case "compaction":
      return (
        <details className="tx-fold tx-divider" data-testid="chat-compaction">
          <summary>
            <span>Earlier messages summarized</span>
          </summary>
          <div className="tx-divider-summary">
            <MarkdownBlock>{item.summary}</MarkdownBlock>
          </div>
        </details>
      );
  }
}

/**
 * A conversation as a chat: people's messages and the bot's replies as
 * bubbles, its questions and approvals as cards a person answers in place,
 * and the work between them as one "worked through N steps" line that opens
 * the transcript there. While the bot works, its live surface follows: the
 * text it is writing as a provisional bubble, its plan, and its status line.
 *
 * It follows: while the reader is at the bottom, new lines keep the bottom in
 * view; once they scroll up, it stays put.
 * @param props - See {@link ChatLogProps}.
 * @returns The chat.
 */
export function ChatLog({ items, live, ...props }: ChatLogProps) {
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

  const streamed = live?.stream?.text ?? "";
  const steps = (live?.plan?.steps ?? []) as PlanStep[];
  const growth = `${items.length}:${streamed.length}:${steps.length}:${live?.status?.text ?? ""}`;
  useEffect(() => {
    if (growth && atBottom.current) {
      end.current?.scrollIntoView?.({ block: "end" });
    }
  }, [growth]);

  return (
    <div className="chat-log" data-testid="chat">
      {items.length === 0 && !streamed && (
        <p className="tx-empty">Nothing has been said yet.</p>
      )}
      {items.map((item) => (
        <ChatLine key={item.key} item={item} {...props} />
      ))}
      {steps.length > 0 && <PlanList steps={steps} />}
      {streamed && (
        <div
          className="chat-row chat-row-bot chat-row-streaming"
          data-testid="chat-stream"
        >
          <BotAvatar speakers={props.speakers} />
          <div className="chat-bubble chat-bubble-bot" aria-live="polite">
            <MarkdownBlock>{streamed}</MarkdownBlock>
            <span className="chat-bubble-note">writing…</span>
          </div>
        </div>
      )}
      {live?.status?.text && (
        <div className="chat-status" data-testid="chat-status" role="status">
          <WorkingGlyph label={null} />
          <span>{live.status.text}</span>
        </div>
      )}
      <div ref={end} className="tx-end" aria-hidden="true" />
    </div>
  );
}
