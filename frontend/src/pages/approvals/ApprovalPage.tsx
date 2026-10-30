import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useRead } from "../../components/bots/data";
import { GatedButton } from "../../components/GatedButton";
import { JsonBlock } from "../../components/JsonBlock";
import { LoadingLabel } from "../../components/LoadingLabel";
import { DetailLayout } from "../../components/layouts/DetailLayout";
import { ApprovalStatusGlyph } from "../../components/mcp/ApprovalStatusGlyph";
import type { ApprovalDetail } from "../../components/mcp/data";
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
import {
  approvalStatusLabel,
  cannotDecideReason,
  expiresInWords,
} from "../../utils/mcp";

/**
 * Who asked for the call: the person whose message started the turn, a
 * platform participant, or nobody in particular (a timer, a callback).
 * @param approval - The approval.
 * @returns The words.
 */
function askedBy(approval: ApprovalDetail): string {
  if (approval.requestedByName) return approval.requestedByName;
  if (approval.requestedByParticipantId) return "A participant in the channel";
  return "Nobody in particular";
}

/**
 * `/approvals/:approvalId` — one tool call a bot wants to make: which bot,
 * which `server/tool`, the arguments it would send (scrubbed of anything
 * that looks like a secret before they were stored), the conversation it
 * waits in, who asked, and when it expires. Someone who may decide sees
 * Approve, Always allow, and Deny, with an optional note the bot reads.
 *
 * Approving runs exactly this call, once. Always allow also adds
 * `server/tool` to the bot's allowlist, so the next one runs unasked.
 * @returns The page.
 */
export function ApprovalPage() {
  const { approvalId } = useParams();
  const { activeProjectId } = useAuth();
  const { reason } = useMay();
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const read = useRead<{ approval: ApprovalDetail }>(
    activeProjectId === null || !approvalId
      ? null
      : `/project/${activeProjectId}/approval/${approvalId}`,
  );

  if (!activeProjectId) {
    return (
      <div className="page" data-testid="approval-page">
        <Alert variant="info" data-testid="no-project">
          Choose a project to see its approvals.
        </Alert>
      </div>
    );
  }
  if (read.data === null && read.error) {
    return (
      <div className="page" data-testid="approval-page">
        <Alert variant="warning" data-testid="approval-missing">
          {read.error}. It may belong to another project, or to a bot you may
          not read. <Link to="/approvals">Back to approvals</Link>
        </Alert>
      </div>
    );
  }
  if (read.data === null) {
    return (
      <div className="page" data-testid="approval-page">
        <LoadingLabel
          block
          testId="approval-loading"
          label="Loading the approval"
        />
      </div>
    );
  }

  const { approval } = read.data;
  const pending = approval.status === "pending";
  const denied =
    reason("approval:decide") ??
    (approval.canDecide ? undefined : cannotDecideReason(approval.botName));

  /**
   * Send the decision, then read the approval again.
   * @param decision - Approve or deny.
   * @param alwaysAllow - With approve, also allowlist `server/tool`.
   */
  async function decide(decision: "approve" | "deny", alwaysAllow = false) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await apiFetch(`/project/${activeProjectId}/approval/${approval.id}`, {
        method: "POST",
        body: JSON.stringify({
          decision,
          via: "dashboard",
          ...(alwaysAllow ? { alwaysAllow: true } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      setNotice(
        decision === "deny"
          ? `Denied. ${approval.botName} is told not to try it again.`
          : alwaysAllow
            ? `Approved. ${approval.botName} runs it now, and calls ${approval.name} without asking from now on.`
            : `Approved. ${approval.botName} runs it now, once.`,
      );
      setNote("");
      await read.reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not decide it.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="approval-page" data-testid="approval-page">
      <DetailLayout
        title={
          <span className="bot-page-title">
            <Link to="/approvals" className="shell-page-crumb">
              Approvals
            </Link>
            <span className="shell-page-subtitle" aria-hidden="true">
              {" "}
              /{" "}
            </span>
            <span className="mono" data-testid="approval-title">
              {approval.name}
            </span>
          </span>
        }
        properties={
          <PropertiesPanel data-testid="approval-properties">
            <Property label="Status">
              <span
                className="conversation-state"
                data-testid="approval-status"
                data-status={approval.status}
              >
                <ApprovalStatusGlyph status={approval.status} />
                {approvalStatusLabel(approval.status)}
              </span>
            </Property>
            <Property label="Bot">
              <Link to={`/bots/${approval.botId}`}>
                <BotBadge name={approval.botName} />
              </Link>
            </Property>
            <Property label="Server">
              <span className="mono">{approval.server}</span>
            </Property>
            <Property label="Tool">
              <span className="mono">{approval.tool}</span>
            </Property>
            <Property label="Conversation">
              <Link
                to={`/conversations/${approval.conversationId}`}
                data-testid="approval-conversation"
              >
                Conversation #{approval.conversationId}
              </Link>
            </Property>
            <Property label="Asked by">
              <span data-testid="approval-asked-by">{askedBy(approval)}</span>
            </Property>
            <Property label="Asked">
              <span className="tabular">
                {new Date(approval.createdAt).toLocaleString()}
              </span>
            </Property>
            {pending ? (
              <Property label="Expires">
                <span
                  className="tabular"
                  title={new Date(approval.expiresAt).toLocaleString()}
                  data-testid="approval-expires"
                >
                  {expiresInWords(approval.expiresAt)}
                </span>
              </Property>
            ) : (
              <Property label="Decided">
                <span className="tabular" data-testid="approval-decided">
                  {approval.decidedAt
                    ? new Date(approval.decidedAt).toLocaleString()
                    : "Not decided"}
                  {approval.decidedByName && ` by ${approval.decidedByName}`}
                  {approval.decidedVia && ` · ${approval.decidedVia}`}
                </span>
              </Property>
            )}
          </PropertiesPanel>
        }
      >
        <div className="approval-main">
          {error && (
            <Alert
              variant="danger"
              dismissible
              onClose={() => setError(null)}
              data-testid="approval-error"
            >
              {error}
            </Alert>
          )}
          {notice && (
            <Alert
              variant="success"
              dismissible
              onClose={() => setNotice(null)}
              data-testid="approval-notice"
            >
              {notice}
            </Alert>
          )}
          <div
            className={`tx-card${pending ? " tx-ask" : ""}`}
            data-testid="approval-card"
          >
            <div className="tx-card-title">
              {pending ? (
                <StatusGlyph state="waiting" waitingOn="approval" />
              ) : (
                <ApprovalStatusGlyph status={approval.status} />
              )}
              {pending
                ? "Needs approval"
                : approvalStatusLabel(approval.status)}
            </div>
            <p className="approval-sentence">
              <BotBadge name={approval.botName} /> wants to call{" "}
              <span className="mono">{approval.name}</span> with these
              arguments.
            </p>
            <JsonBlock
              value={approval.args}
              label="Arguments (secrets scrubbed)"
              testId="approval-args"
            />
            {approval.note && (
              <p className="approval-note" data-testid="approval-note">
                Note: {approval.note}
              </p>
            )}
            {pending && (
              <div className="approval-decide">
                <Form.Group controlId="approval-note" className="mb-0">
                  <Form.Label>
                    Note <span className="text-meta">optional</span>
                  </Form.Label>
                  <Form.Control
                    as="textarea"
                    rows={2}
                    size="sm"
                    maxLength={500}
                    placeholder="What to do instead, read by the bot with a denial"
                    value={note}
                    disabled={busy || denied !== undefined}
                    title={denied}
                    onChange={(e) => setNote(e.target.value)}
                    data-testid="approval-note-input"
                  />
                </Form.Group>
                <div className="approval-buttons">
                  <GatedButton
                    size="sm"
                    variant="primary"
                    disabled={busy}
                    deniedReason={denied}
                    onClick={() => decide("approve")}
                    data-testid="approval-approve"
                  >
                    Approve once
                  </GatedButton>
                  <GatedButton
                    size="sm"
                    variant="outline-primary"
                    disabled={busy}
                    deniedReason={denied}
                    title={`Approve, and let ${approval.botName} call ${approval.name} without asking from now on`}
                    onClick={() => decide("approve", true)}
                    data-testid="approval-always"
                  >
                    Always allow
                  </GatedButton>
                  <GatedButton
                    size="sm"
                    variant="outline-danger"
                    disabled={busy}
                    deniedReason={denied}
                    onClick={() => decide("deny")}
                    data-testid="approval-deny"
                  >
                    Deny
                  </GatedButton>
                </div>
              </div>
            )}
          </div>
        </div>
      </DetailLayout>
    </div>
  );
}
