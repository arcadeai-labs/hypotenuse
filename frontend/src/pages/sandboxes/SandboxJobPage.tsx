import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useRead } from "../../components/bots/data";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { GatedButton } from "../../components/GatedButton";
import { JsonBlock } from "../../components/JsonBlock";
import { LoadingLabel } from "../../components/LoadingLabel";
import { DetailLayout } from "../../components/layouts/DetailLayout";
import { MarkdownBlock } from "../../components/MarkdownBlock";
import { SandboxJobStatusGlyph } from "../../components/sandboxes/SandboxJobStatusGlyph";
import { relativeTime } from "../../components/shell/NotificationBell";
import { useAuth } from "../../context/AuthContext";
import { useMay } from "../../hooks/useMay";
import {
  Alert,
  BotBadge,
  Button,
  Chip,
  Form,
  PropertiesPanel,
  Property,
  StatusGlyph,
} from "../../ui";
import { BOT_WRITE_DENIED } from "../../utils/bots";
import { apiFetch } from "../../utils/client";
import {
  answeredByWords,
  durationWords,
  eventLine,
  eventsQuery,
  formatTokens,
  isLiveJob,
  jobStatusLabel,
  type SandboxJobDetail,
  type SandboxJobEvent,
  type SandboxJobQuestion,
  usageWords,
} from "../../utils/sandboxJobs";

/** How often a live job's page reads it again. */
const POLL_MS = 5000;

/** How many transcript events one read asks for. */
const EVENTS_PAGE = 100;

/**
 * A job's transcript, read forward with the `afterSeq` cursor: the first
 * page on open, the next when asked, and — once caught up, while the job is
 * alive — whatever is new on every poll.
 * @param base - The job's route, or `null` while there is nothing to read.
 * @param live - Whether the job is still running, so new events may arrive.
 * @returns The events read so far, whether more wait, and the reader.
 */
function useJobEvents(base: string | null, live: boolean) {
  const [events, setEvents] = useState<SandboxJobEvent[]>([]);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lastSeq = useRef<number | null>(null);
  // The route a read is in flight for, so two never overlap for one job.
  const reading = useRef<string | null>(null);
  const current = useRef(base);
  current.current = base;

  const readNext = useCallback(async () => {
    if (base === null || reading.current === base) return;
    reading.current = base;
    try {
      const res = await apiFetch<{
        events: SandboxJobEvent[];
        pagination: { pages: number };
      }>(`${base}/events${eventsQuery(lastSeq.current, EVENTS_PAGE)}`);
      // An answer for a job the page has since left is dropped.
      if (current.current !== base) return;
      const last = res.events.at(-1);
      if (last) lastSeq.current = last.seq;
      setEvents((read) => [...read, ...res.events]);
      setMore(res.pagination.pages > 1);
      setError(null);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not read the transcript.",
      );
    } finally {
      if (reading.current === base) reading.current = null;
    }
  }, [base]);

  // A different job starts from the top.
  useEffect(() => {
    lastSeq.current = null;
    setEvents([]);
    setMore(false);
    readNext();
  }, [readNext]);

  useEffect(() => {
    if (!live || more) return;
    const timer = setInterval(readNext, POLL_MS);
    return () => clearInterval(timer);
  }, [live, more, readNext]);

  return { events, more, error, readNext };
}

/**
 * One question the coding agent asked: what, how it was answered, and — for
 * a pending question to the conversation, for someone who may change the bot
 * — a box to answer it here. A question to the team is answered in the Help
 * inbox.
 * @param props.question - The question.
 * @param props.base - The job's route.
 * @param props.denied - Why the reader may not answer, or `undefined`.
 * @param props.onAnswered - Read the job again.
 * @returns The card.
 */
function QuestionCard({
  question,
  base,
  denied,
  onAnswered,
}: {
  question: SandboxJobQuestion;
  base: string;
  denied: string | undefined;
  onAnswered: () => Promise<void>;
}) {
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = question.status === "pending";
  const toTeam = question.kind === "team";

  /**
   * Send the answer.
   * @param text - The answer.
   */
  async function send(text: string) {
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`${base}/question/${question.id}`, {
        method: "POST",
        body: JSON.stringify({ answer: text.trim() }),
      });
      setAnswer("");
      await onAnswered();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not answer it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="tx-card tx-ask"
      data-testid={`sandbox-question-${question.id}`}
      data-status={question.status}
    >
      <div className="tx-card-title">
        {pending && <StatusGlyph state="waiting" waitingOn="answer" />}
        {toTeam ? "Asked the team" : "Asked the conversation"}
        <Chip>{pending ? "Waiting" : question.status}</Chip>
        {question.blocking && pending && (
          <Chip title="The coding agent is stopped until it is answered">
            Blocking
          </Chip>
        )}
      </div>
      <MarkdownBlock>{question.question}</MarkdownBlock>
      {question.options && question.options.length > 0 && (
        <div className="tx-options">
          {question.options.map((option) => (
            <Button
              key={option}
              size="sm"
              variant="secondary"
              disabled={!pending || toTeam || busy || denied !== undefined}
              title={denied}
              onClick={() => send(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      )}
      {question.answer && (
        <div className="help-answer" data-testid="sandbox-question-answer">
          <span className="text-meta">
            Answered by {answeredByWords(question.answeredBy)}
          </span>
          <MarkdownBlock>{question.answer}</MarkdownBlock>
        </div>
      )}
      {toTeam && question.helpRequestId && (
        <p className="tx-call-note">
          This went to the team:{" "}
          <Link to={`/help/${question.helpRequestId}`}>
            answer it in the Help inbox
          </Link>
          .
        </p>
      )}
      {error && (
        <Alert variant="danger" dismissible onClose={() => setError(null)}>
          {error}
        </Alert>
      )}
      {pending && !toTeam && (
        <form
          className="help-answer-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (answer.trim()) send(answer);
          }}
        >
          <Form.Group
            controlId={`sandbox-answer-${question.id}`}
            className="mb-0"
          >
            <Form.Label>Your answer</Form.Label>
            <Form.Control
              as="textarea"
              rows={3}
              maxLength={10_000}
              placeholder="The coding agent reads this the next time it checks"
              value={answer}
              disabled={busy || denied !== undefined}
              title={denied}
              onChange={(e) => setAnswer(e.target.value)}
              data-testid="sandbox-answer-input"
            />
          </Form.Group>
          <div className="approval-buttons">
            <GatedButton
              type="submit"
              size="sm"
              variant="primary"
              deniedReason={denied}
              disabled={busy || !answer.trim()}
              data-testid="sandbox-answer-submit"
            >
              Send answer
            </GatedButton>
          </div>
        </form>
      )}
    </div>
  );
}

/**
 * `/sandboxes/:jobId` — one sandbox job: the task the bot gave, the briefing
 * the coding agent saw, its status and what it last reported, its closing
 * text and artifacts, the questions it asked (answerable here when they went
 * to the conversation), the messages sent to it, and its own transcript.
 * Whoever may change the bot may cancel a job that is still alive. A live job
 * is read again every few seconds.
 * @returns The page.
 */
export function SandboxJobPage() {
  const { jobId } = useParams();
  const { activeProjectId } = useAuth();
  const { reason } = useMay();
  const base =
    activeProjectId && jobId
      ? `/project/${activeProjectId}/sandbox-job/${jobId}`
      : null;
  const read = useRead<SandboxJobDetail>(base);
  const job = read.data?.sandboxJob;
  const live = job ? isLiveJob(job.status) : false;
  const events = useJobEvents(base, live);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const { reload } = read;

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(reload, POLL_MS);
    return () => clearInterval(timer);
  }, [live, reload]);

  if (!activeProjectId) {
    return (
      <div className="page" data-testid="sandbox-job-page">
        <Alert variant="info" data-testid="no-project">
          Choose a project to see its sandbox jobs.
        </Alert>
      </div>
    );
  }
  if (!read.data || !job || !base) {
    return (
      <div className="page" data-testid="sandbox-job-page">
        {read.error ? (
          <Alert variant="warning" data-testid="sandbox-job-missing">
            {read.error}. It may belong to another project, or to a bot limited
            to tags you do not hold. <Link to="/sandboxes">Sandboxes</Link>
          </Alert>
        ) : (
          <LoadingLabel
            block
            testId="sandbox-job-loading"
            label="Loading the job"
          />
        )}
      </div>
    );
  }

  const { questions, messages, canWrite } = read.data;
  const writeDenied =
    reason("sandbox-job:cancel") ?? (canWrite ? undefined : BOT_WRITE_DENIED);
  const answerDenied =
    reason("sandbox-job:answer") ?? (canWrite ? undefined : BOT_WRITE_DENIED);
  const artifacts = Object.entries(job.artifacts ?? {});

  /** Stop the job, then read it again. */
  async function onCancel() {
    setConfirmCancel(false);
    setBusy(true);
    setError(null);
    try {
      await apiFetch(`${base}/cancel`, { method: "POST" });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="approval-page" data-testid="sandbox-job-page">
      <DetailLayout
        title={
          <span className="bot-page-title">
            <Link to="/sandboxes" className="shell-page-crumb">
              Sandboxes
            </Link>
            <span className="shell-page-subtitle" aria-hidden="true">
              {" "}
              /{" "}
            </span>
            <span data-testid="sandbox-job-title">{job.title}</span>
          </span>
        }
        actions={
          live && (
            <GatedButton
              size="sm"
              variant="outline-danger"
              deniedReason={writeDenied}
              disabled={busy || job.cancelRequested}
              onClick={() => setConfirmCancel(true)}
              data-testid="sandbox-job-cancel"
            >
              {job.cancelRequested ? "Stopping…" : "Cancel job"}
            </GatedButton>
          )
        }
        properties={
          <PropertiesPanel data-testid="sandbox-job-properties">
            <Property label="Status">
              <span
                className="conversation-state"
                data-testid="sandbox-job-status"
                data-status={job.status}
              >
                <SandboxJobStatusGlyph status={job.status} />
                {jobStatusLabel(job.status)}
              </span>
            </Property>
            <Property label="Job">
              <span className="tabular">#{job.id}</span>
            </Property>
            <Property label="Bot">
              <Link to={`/bots/${job.bot.id}`}>
                <BotBadge name={job.bot.name} />
              </Link>
            </Property>
            <Property label="Conversation">
              <Link
                to={`/conversations/${job.parentConversationId}`}
                data-testid="sandbox-job-conversation"
              >
                Conversation #{job.parentConversationId}
              </Link>
            </Property>
            <Property label="Kind">
              {job.interactive ? "Interactive" : "One task"}
            </Property>
            <Property label="Runs on">{job.provider ?? "—"}</Property>
            <Property label="Tokens">
              <span
                className="tabular"
                data-testid="sandbox-job-usage"
                title={`${formatTokens(job.usage.inputTokens)} in, ${formatTokens(job.usage.outputTokens)} out`}
              >
                {usageWords(job.usage, job.budgetTokens)}
              </span>
            </Property>
            <Property label="Model requests">
              <span className="tabular">{job.usage.requests}</span>
            </Property>
            <Property label="Longest run">
              <span className="tabular">
                {durationWords(job.maxDurationMs)}
              </span>
            </Property>
            <Property label="Started">
              <span className="tabular">
                {job.startedAt
                  ? new Date(job.startedAt).toLocaleString()
                  : "Not yet"}
              </span>
            </Property>
            {job.endedAt && (
              <Property label="Ended">
                <span className="tabular">
                  {new Date(job.endedAt).toLocaleString()}
                </span>
              </Property>
            )}
            {job.endReason && (
              <Property label="Why it ended">
                <span data-testid="sandbox-job-end-reason">
                  {job.endReason}
                </span>
              </Property>
            )}
            {job.exitCode !== null && (
              <Property label="Exit code">
                <span className="tabular">{job.exitCode}</span>
              </Property>
            )}
          </PropertiesPanel>
        }
      >
        <div className="conversation-main sandbox-job-main">
          {error && (
            <Alert
              variant="danger"
              dismissible
              onClose={() => setError(null)}
              data-testid="sandbox-job-error"
            >
              {error}
            </Alert>
          )}
          {job.error && (
            <Alert variant="danger" data-testid="sandbox-job-failure">
              {job.error}
            </Alert>
          )}
          <section className="sandbox-block" data-testid="sandbox-job-task">
            <h2 className="sandbox-block-title">Task</h2>
            <MarkdownBlock>{job.task}</MarkdownBlock>
            {job.briefing && (
              <details
                className="tx-fold sandbox-briefing"
                data-testid="sandbox-job-briefing"
              >
                <summary className="text-meta">
                  The briefing the coding agent saw
                </summary>
                <pre className="json-block-body">{job.briefing}</pre>
              </details>
            )}
          </section>
          {(job.reportedStatus || job.statusMessage) && (
            <section
              className="sandbox-block"
              data-testid="sandbox-job-reported"
            >
              <h2 className="sandbox-block-title">Last reported</h2>
              <p className="tx-text">
                {job.reportedStatus && <Chip>{job.reportedStatus}</Chip>}{" "}
                {job.statusMessage}
              </p>
            </section>
          )}
          {job.closingText && (
            <section
              className="sandbox-block"
              data-testid="sandbox-job-closing"
            >
              <h2 className="sandbox-block-title">What it said at the end</h2>
              <MarkdownBlock>{job.closingText}</MarkdownBlock>
            </section>
          )}
          {artifacts.length > 0 && (
            <section
              className="sandbox-block"
              data-testid="sandbox-job-artifacts"
            >
              <h2 className="sandbox-block-title">Artifacts</h2>
              {artifacts.map(([name, artifact]) => (
                <details
                  key={name}
                  className="tx-call"
                  data-testid={`sandbox-artifact-${name}`}
                >
                  <summary className="tx-action tx-call-summary">
                    <span className="tx-verb">{name}</span>
                    <span className="tx-duration tabular">
                      {relativeTime(artifact.updatedAt)}
                    </span>
                  </summary>
                  <div className="tx-call-detail">
                    <pre className="json-block-body">{artifact.content}</pre>
                  </div>
                </details>
              ))}
            </section>
          )}
          {questions.length > 0 && (
            <section
              className="sandbox-block"
              data-testid="sandbox-job-questions"
            >
              <h2 className="sandbox-block-title">Questions</h2>
              {questions.map((q) => (
                <QuestionCard
                  key={q.id}
                  question={q}
                  base={base}
                  denied={answerDenied}
                  onAnswered={reload}
                />
              ))}
            </section>
          )}
          {messages.length > 0 && (
            <section
              className="sandbox-block"
              data-testid="sandbox-job-messages"
            >
              <h2 className="sandbox-block-title">Messages to the agent</h2>
              {messages.map((m) => (
                <div
                  key={m.id}
                  className="tx-note"
                  data-testid={`sandbox-message-${m.id}`}
                >
                  <span className="tx-note-label">
                    From {m.source}
                    {m.deliveredAt ? "" : ", not delivered yet"}:
                  </span>{" "}
                  {m.body}
                </div>
              ))}
            </section>
          )}
          <section
            className="sandbox-block"
            data-testid="sandbox-job-transcript"
          >
            <h2 className="sandbox-block-title">Transcript</h2>
            {events.error && (
              <Alert variant="danger" data-testid="sandbox-events-error">
                {events.error}
              </Alert>
            )}
            {events.events.length === 0 && !events.error && (
              <p className="tx-empty">
                {live
                  ? "The coding agent has not said anything yet."
                  : "The coding agent said nothing."}
              </p>
            )}
            <div className="tx-log sandbox-events">
              {events.events.map((e) => {
                const line = eventLine(e);
                return (
                  <details
                    key={e.id}
                    className="tx-call"
                    data-kind={e.kind}
                    data-status={e.kind === "error" ? "error" : "ok"}
                    data-testid="sandbox-event"
                  >
                    <summary className="tx-action tx-call-summary">
                      <span className="tx-verb">{line.label}</span>
                      {line.text && (
                        <span className="tx-parameter sandbox-event-text">
                          {line.text}
                        </span>
                      )}
                      <span
                        className="tx-duration tabular"
                        title={new Date(e.occurredAt).toLocaleString()}
                      >
                        {e.seq}
                      </span>
                    </summary>
                    <div className="tx-call-detail">
                      {line.text && (
                        <pre className="json-block-body">{line.text}</pre>
                      )}
                      {e.payload !== null && e.payload !== undefined && (
                        <JsonBlock value={e.payload} label="Event" />
                      )}
                    </div>
                  </details>
                );
              })}
            </div>
            {events.more && (
              <Button
                size="sm"
                variant="secondary"
                onClick={events.readNext}
                data-testid="sandbox-events-more"
              >
                Read more
              </Button>
            )}
          </section>
        </div>
      </DetailLayout>
      <ConfirmDialog
        show={confirmCancel}
        title="Cancel this job?"
        confirmLabel="Cancel job"
        busy={busy}
        onConfirm={onCancel}
        onCancel={() => setConfirmCancel(false)}
        testId="sandbox-job-cancel"
      >
        The coding agent stops within a heartbeat and its sandbox is destroyed.
        {` ${job.bot.name}`} is told the job was cancelled.
      </ConfirmDialog>
    </div>
  );
}
