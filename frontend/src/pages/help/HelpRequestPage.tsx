import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useRead } from "../../components/bots/data";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { GatedButton } from "../../components/GatedButton";
import {
  type HelpDetail,
  helpStatusLabel,
  urgencyLabel,
} from "../../components/help/model";
import { LoadingLabel } from "../../components/LoadingLabel";
import { DetailLayout } from "../../components/layouts/DetailLayout";
import { MarkdownBlock } from "../../components/MarkdownBlock";
import { useAuth } from "../../context/AuthContext";
import { useMay } from "../../hooks/useMay";
import {
  Alert,
  BotBadge,
  Form,
  PropertiesPanel,
  Property,
  StatusGlyph,
} from "../../ui";
import { apiFetch } from "../../utils/client";
import { expiresInWords } from "../../utils/mcp";

/**
 * `/help/:helpRequestId` — one request a bot made for a person: what it
 * asked, the context it gave, and the conversation it came from, with a box
 * to answer it. The answer reaches the bot as a message from you and wakes
 * the conversation; the bot never posted the question in its channel, since
 * it may be about that channel. Whoever may change the bot may also cancel
 * the request. Both are the server's word: `standing.canAnswer` and
 * `standing.canCancel`, gated again by `can()`.
 * @returns The page.
 */
export function HelpRequestPage() {
  const { helpRequestId } = useParams();
  const { activeProjectId } = useAuth();
  const { reason } = useMay();
  const read = useRead<HelpDetail>(
    activeProjectId && helpRequestId
      ? `/project/${activeProjectId}/help/${helpRequestId}`
      : null,
  );
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  if (!activeProjectId) {
    return (
      <div className="page" data-testid="help-request-page">
        <Alert variant="info" data-testid="no-project">
          Choose a project to see what its bots asked.
        </Alert>
      </div>
    );
  }
  if (!read.data) {
    return (
      <div className="page" data-testid="help-request-page">
        {read.error ? (
          <Alert variant="warning" data-testid="help-request-missing">
            {read.error}. It may belong to another project, or to a bot limited
            to tags you do not hold. <Link to="/help">Help inbox</Link>
          </Alert>
        ) : (
          <LoadingLabel
            block
            testId="help-request-loading"
            label="Loading the request"
          />
        )}
      </div>
    );
  }

  const { helpRequest: request, standing } = read.data;
  const pending = request.status === "pending";
  const answerDenied =
    reason("help:answer") ??
    (standing.canAnswer
      ? undefined
      : pending
        ? `Only the people ${request.botName} notifies, and those who may change it, answer it.`
        : `This request is ${helpStatusLabel(request.status).toLowerCase()}.`);
  const cancelDenied =
    reason("help:cancel") ??
    (standing.canCancel
      ? undefined
      : `Only people who may change ${request.botName} cancel its requests.`);
  const base = `/project/${activeProjectId}/help/${request.id}`;

  /** Send the answer, then read the request again. */
  async function onAnswer() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(base, {
        method: "POST",
        body: JSON.stringify({ answer: answer.trim() }),
      });
      setAnswer("");
      setNotice(`Answered. ${request.botName} reads it now.`);
      await read.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not answer it.");
    } finally {
      setBusy(false);
    }
  }

  /** Cancel the request, then read it again. */
  async function onCancel() {
    setConfirmCancel(false);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(base, { method: "DELETE" });
      setNotice("Cancelled.");
      await read.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not cancel it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="approval-page" data-testid="help-request-page">
      <DetailLayout
        title={
          <span className="bot-page-title">
            <Link to="/help" className="shell-page-crumb">
              Help inbox
            </Link>
            <span className="shell-page-subtitle" aria-hidden="true">
              {" "}
              /{" "}
            </span>
            <span data-testid="help-request-title">Request #{request.id}</span>
          </span>
        }
        actions={
          pending && (
            <GatedButton
              size="sm"
              variant="outline-danger"
              deniedReason={cancelDenied}
              disabled={busy}
              onClick={() => setConfirmCancel(true)}
              data-testid="help-cancel"
            >
              Cancel request
            </GatedButton>
          )
        }
        properties={
          <PropertiesPanel data-testid="help-request-properties">
            <Property label="Status">
              <span
                className="conversation-state"
                data-testid="help-request-status"
                data-status={request.status}
              >
                {pending && <StatusGlyph state="waiting" waitingOn="answer" />}
                {helpStatusLabel(request.status)}
              </span>
            </Property>
            <Property label="Bot">
              <Link to={`/bots/${request.botId}`}>
                <BotBadge name={request.botName} />
              </Link>
            </Property>
            <Property label="Urgency">{urgencyLabel(request.urgency)}</Property>
            <Property label="The bot">
              {request.blocking
                ? "Stopped until someone answers"
                : "Carrying on meanwhile"}
            </Property>
            <Property label="Conversation">
              <Link
                to={`/conversations/${request.conversationId}`}
                data-testid="help-request-conversation"
              >
                Conversation #{request.conversationId}
              </Link>
            </Property>
            <Property label="Asked">
              <span className="tabular">
                {new Date(request.createdAt).toLocaleString()}
              </span>
            </Property>
            {pending ? (
              <Property label="Expires">
                <span
                  className="tabular"
                  title={new Date(request.expiresAt).toLocaleString()}
                >
                  {expiresInWords(request.expiresAt)}
                </span>
              </Property>
            ) : (
              request.answeredAt && (
                <Property label="Answered">
                  <span className="tabular">
                    {new Date(request.answeredAt).toLocaleString()}
                  </span>
                </Property>
              )
            )}
          </PropertiesPanel>
        }
      >
        <div className="conversation-main">
          {error && (
            <Alert
              variant="danger"
              dismissible
              onClose={() => setError(null)}
              data-testid="help-request-error"
            >
              {error}
            </Alert>
          )}
          {notice && (
            <Alert
              variant="success"
              dismissible
              onClose={() => setNotice(null)}
              data-testid="help-request-notice"
            >
              {notice}
            </Alert>
          )}
          <div className="tx-card tx-ask" data-testid="help-request-card">
            <div className="tx-card-title">
              {pending && <StatusGlyph state="waiting" waitingOn="answer" />}
              <BotBadge name={request.botName} /> asks
            </div>
            <div data-testid="help-request-question">
              <MarkdownBlock>{request.question}</MarkdownBlock>
            </div>
            {request.context && (
              <div className="help-context" data-testid="help-request-context">
                <span className="text-meta">Context</span>
                <MarkdownBlock>{request.context}</MarkdownBlock>
              </div>
            )}
            {request.answer && (
              <div className="help-answer" data-testid="help-request-answer">
                <span className="text-meta">Answer</span>
                <MarkdownBlock>{request.answer}</MarkdownBlock>
              </div>
            )}
            {pending && (
              <form
                className="help-answer-form"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (answer.trim()) onAnswer();
                }}
              >
                <Form.Group controlId="help-answer" className="mb-0">
                  <Form.Label>Your answer</Form.Label>
                  <Form.Control
                    as="textarea"
                    rows={4}
                    maxLength={10_000}
                    placeholder={`${request.botName} reads this as a message from you`}
                    value={answer}
                    disabled={busy || answerDenied !== undefined}
                    title={answerDenied}
                    onChange={(e) => setAnswer(e.target.value)}
                    data-testid="help-answer-input"
                  />
                  <Form.Text className="text-meta">
                    Markdown. It is delivered into the conversation, not posted
                    in the channel.
                  </Form.Text>
                </Form.Group>
                <div className="approval-buttons">
                  <GatedButton
                    type="submit"
                    size="sm"
                    variant="primary"
                    deniedReason={answerDenied}
                    disabled={busy || !answer.trim()}
                    data-testid="help-answer-submit"
                  >
                    Send answer
                  </GatedButton>
                </div>
              </form>
            )}
          </div>
        </div>
      </DetailLayout>
      <ConfirmDialog
        show={confirmCancel}
        title="Cancel this request?"
        confirmLabel="Cancel request"
        busy={busy}
        onConfirm={onCancel}
        onCancel={() => setConfirmCancel(false)}
        testId="help-cancel"
      >
        {request.botName} is told the request was withdrawn, and carries on
        without an answer.
      </ConfirmDialog>
    </div>
  );
}
