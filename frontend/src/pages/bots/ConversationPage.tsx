import type { BotView } from "@backend/actions/bot/bot-view";
import type { ActionResponse } from "keryx";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useRead } from "../../components/bots/data";
import { ChatPanel } from "../../components/chat/ChatPanel";
import { conversationViewOf } from "../../components/chat/model";
import { usePeople } from "../../components/chat/usePeople";
import { GatedButton } from "../../components/GatedButton";
import { LoadingLabel } from "../../components/LoadingLabel";
import { DetailLayout } from "../../components/layouts/DetailLayout";
import { parseSeqs } from "../../components/memory/model";
import { relativeTime } from "../../components/shell/NotificationBell";
import { ApprovalWait } from "../../components/transcript/ApprovalWait";
import type { CodeRunDetail } from "../../components/transcript/CodeRun";
import { Composer } from "../../components/transcript/Composer";
import {
  buildTranscript,
  conversationStateLabel,
  conversationStatus,
  conversationTitle,
  platformOf,
} from "../../components/transcript/model";
import { TranscriptView } from "../../components/transcript/TranscriptView";
import { useConversation } from "../../components/transcript/useConversation";
import { useAuth } from "../../context/AuthContext";
import { useMay } from "../../hooks/useMay";
import {
  Alert,
  Avatar,
  PlatformChip,
  PropertiesPanel,
  Property,
  StatusGlyph,
} from "../../ui";
import { botAvatarSrc } from "../../utils/avatar";
import { API_URL, apiFetch } from "../../utils/client";
import { isLiveJob, type SandboxJobRow } from "../../utils/sandboxJobs";

/** What the Cancel button says when the conversation is already over. */
const ENDED = "This conversation has ended. Writing to it starts a new turn.";

/**
 * `/conversations/:conversationId` — one conversation: its transcript, live,
 * with a box to write into it and a way to stop it; its state, bot, and
 * channel beside it.
 *
 * The transcript follows the conversation's content-free channel and
 * re-reads entries after the newest it holds. Cancel is gated twice, both by
 * the server: `can()` on `conversation:cancel`, and the conversation's own
 * `standing.canCancel` (an ended conversation has nothing to cancel).
 * @returns The page.
 */
export function ConversationPage() {
  const { conversationId } = useParams();
  const { activeProjectId } = useAuth();
  const { reason } = useMay();
  const id = Number(conversationId);
  const { view, entries, live, error, loaded, refresh } = useConversation(
    activeProjectId,
    Number.isSafeInteger(id) && id > 0 ? id : null,
  );
  const [search, setSearch] = useSearchParams();
  const seqsParam = search.get("seqs");
  const highlight = useMemo(() => parseSeqs(seqsParam), [seqsParam]);
  const scrolledTo = useRef<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const bot = useRead<ActionResponse<BotView>>(
    activeProjectId && view
      ? `/project/${activeProjectId}/bot/${view.bot.id}`
      : null,
  );
  const people = usePeople(activeProjectId, entries);

  const conversation = view?.conversation;
  const items = useMemo(
    () => buildTranscript(entries, conversation?.state === "working"),
    [entries, conversation?.state],
  );

  // A program's journal and approvals live on its code run: read them again
  // whenever the transcript moves, if it has a program in it.
  const hasCode = items.some(
    (item) => item.kind === "tool" && item.toolName === "run_code",
  );
  const lastSeq = conversation?.lastSeq ?? 0;
  const [codeRuns, setCodeRuns] = useState<Map<number, CodeRunDetail>>(
    () => new Map(),
  );
  useEffect(() => {
    if (!hasCode || !activeProjectId || !conversation) return;
    let cancelled = false;
    apiFetch<{ codeRuns: CodeRunDetail[] }>(
      `/project/${activeProjectId}/conversation/${conversation.id}/code-runs?limit=100`,
    )
      .then((res) => {
        if (!cancelled) {
          setCodeRuns(new Map(res.codeRuns.map((r) => [r.entryId, r])));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    hasCode,
    activeProjectId,
    conversation?.id,
    lastSeq,
    conversation?.state,
  ]);

  // A sandbox job's status lives on the job: read the conversation's jobs
  // again whenever the transcript moves, if it started any. A live job is
  // read again every few seconds, since its progress moves no entry.
  const hasSandbox = items.some(
    (item) =>
      item.kind === "tool" &&
      (item.toolName === "sandbox_start" || item.toolName === "sandbox_wait"),
  );
  const [sandboxJobs, setSandboxJobs] = useState<Map<number, SandboxJobRow>>(
    () => new Map(),
  );
  const [sandboxTick, setSandboxTick] = useState(0);
  const sandboxLive = [...sandboxJobs.values()].some((j) =>
    isLiveJob(j.status),
  );
  useEffect(() => {
    if (!sandboxLive) return;
    const timer = setInterval(() => setSandboxTick((n) => n + 1), 5000);
    return () => clearInterval(timer);
  }, [sandboxLive]);
  useEffect(() => {
    if (!hasSandbox || !activeProjectId || !conversation) return;
    let cancelled = false;
    apiFetch<{ sandboxJobs: SandboxJobRow[] }>(
      `/project/${activeProjectId}/sandbox-jobs?conversationId=${conversation.id}&limit=100`,
    )
      .then((res) => {
        if (!cancelled) {
          setSandboxJobs(new Map(res.sandboxJobs.map((j) => [j.id, j])));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [
    hasSandbox,
    activeProjectId,
    conversation?.id,
    lastSeq,
    conversation?.state,
    sandboxTick,
  ]);

  // A link from a memory marks the entries it was learned from: bring the
  // first into view once it has been drawn, and only once per link.
  const marked = items.some((item) => highlight.has(item.seq));
  useEffect(() => {
    if (!marked || scrolledTo.current === seqsParam) return;
    scrolledTo.current = seqsParam;
    document
      .querySelector(".tx-highlight")
      ?.scrollIntoView?.({ block: "center" });
  }, [marked, seqsParam]);

  if (!activeProjectId) {
    return (
      <div className="page" data-testid="conversation-page">
        <Alert variant="info" data-testid="no-project">
          Choose a project to see its conversations.
        </Alert>
      </div>
    );
  }
  if (!loaded || (!view && !error)) {
    return (
      <div className="page" data-testid="conversation-page">
        <LoadingLabel
          block
          testId="conversation-loading"
          label="Loading the conversation"
        />
      </div>
    );
  }
  if (!view || !conversation) {
    return (
      <div className="page" data-testid="conversation-page">
        <Alert variant="warning" data-testid="conversation-missing">
          {error}. It may belong to another project, or to a bot limited to tags
          you do not hold. <Link to="/conversations">Conversations</Link>
        </Alert>
      </div>
    );
  }

  const platform = platformOf(view.channel.type);
  const shown = conversationViewOf(search.get("view"), view.channel.type);
  const status = conversationStatus(conversation);
  const stateLabel = conversationStateLabel(conversation);
  const cancelDenied =
    reason("conversation:cancel") ??
    (view.standing.canCancel ? undefined : ENDED);
  const messageDenied =
    reason("conversation:message") ??
    (view.standing.canMessage
      ? undefined
      : "You may not write to this conversation.");
  const base = `/project/${activeProjectId}/conversation/${conversation.id}`;
  const botAvatar = bot.data
    ? botAvatarSrc(API_URL, bot.data.bot.avatarUrl)
    : undefined;

  /** Stop the conversation; the transcript says when it has. */
  async function onCancel() {
    setCancelling(true);
    setActionError(null);
    try {
      await apiFetch(`${base}/cancel`, { method: "POST" });
      await refresh();
    } catch (err) {
      setActionError(
        err instanceof Error ? err.message : "Could not cancel it.",
      );
    } finally {
      setCancelling(false);
    }
  }

  /**
   * Write into the conversation.
   * @param text - The message.
   */
  async function onSend(text: string) {
    await apiFetch(`${base}/message`, {
      method: "PUT",
      body: JSON.stringify({ text }),
    });
    await refresh();
  }

  return (
    <div className="conversation-page" data-testid="conversation-page">
      <DetailLayout
        title={
          <span className="bot-page-title">
            <Link
              to={`/bots/${view.bot.id}/conversations`}
              className="shell-page-crumb"
            >
              {view.bot.name}
            </Link>
            <span className="shell-page-subtitle" aria-hidden="true">
              {" "}
              /{" "}
            </span>
            <span data-testid="conversation-title">
              {conversationTitle(conversation, entries)}
            </span>
          </span>
        }
        actions={
          <GatedButton
            size="sm"
            variant="outline-danger"
            deniedReason={cancelDenied}
            disabled={cancelling || conversation.cancelRequested}
            onClick={onCancel}
            data-testid="cancel-conversation"
          >
            {conversation.cancelRequested ? "Stopping…" : "Cancel"}
          </GatedButton>
        }
        properties={
          <PropertiesPanel data-testid="conversation-properties">
            <Property label="State">
              <span
                className="conversation-state"
                data-testid="conversation-state"
                data-state={conversation.state}
                data-outcome={conversation.outcome ?? undefined}
              >
                <StatusGlyph {...status} label={stateLabel} />
                {stateLabel}
              </span>
            </Property>
            {conversation.state === "waiting" &&
              conversation.waitingOn?.kind === "sandbox" && (
                <Property label="Waits on">
                  <Link
                    to={`/sandboxes/${conversation.waitingOn.sandboxJobId}`}
                    data-testid="conversation-sandbox-job"
                  >
                    Sandbox job #{conversation.waitingOn.sandboxJobId}
                  </Link>
                </Property>
              )}
            <Property label="Bot">
              <Link to={`/bots/${view.bot.id}`} className="conversation-bot">
                <Avatar name={view.bot.name} src={botAvatar} bot size={20} />
              </Link>
            </Property>
            <Property label="Channel">
              <span className="conversation-channel">
                <PlatformChip
                  platform={platform}
                  data-testid="conversation-channel-platform"
                />
                <span>{view.channel.name}</span>
              </span>
            </Property>
            <Property label="Last activity">
              <span
                className="tabular"
                title={new Date(conversation.lastActivityAt).toLocaleString()}
              >
                {relativeTime(conversation.lastActivityAt)}
              </span>
            </Property>
            <Property label="Started">
              <span className="tabular">
                {new Date(conversation.createdAt).toLocaleString()}
              </span>
            </Property>
            <Property label="Turns">
              <span className="tabular">{conversation.epoch}</span>
            </Property>
            <Property label="Entries">
              <span className="tabular" data-testid="conversation-last-seq">
                {conversation.lastSeq}
              </span>
            </Property>
            <Property label="Callback">
              {conversation.hasCallback ? "Replies are POSTed" : "None"}
            </Property>
          </PropertiesPanel>
        }
      >
        <div className="conversation-main">
          <div
            className="conversation-filters conversation-views"
            role="group"
            aria-label="View"
          >
            {(["chat", "transcript"] as const).map((v) => (
              <button
                key={v}
                type="button"
                className="conversation-filter"
                aria-pressed={shown === v}
                onClick={() => {
                  const next = new URLSearchParams(search);
                  next.set("view", v);
                  if (v === "chat") next.delete("seqs");
                  setSearch(next, { replace: true });
                }}
                data-testid={`conversation-view-${v}`}
              >
                {v === "chat" ? "Chat" : "Transcript"}
              </button>
            ))}
          </div>
          {actionError && (
            <Alert
              variant="danger"
              dismissible
              onClose={() => setActionError(null)}
              data-testid="conversation-action-error"
            >
              {actionError}
            </Alert>
          )}
          {error && (
            <Alert variant="warning" data-testid="conversation-stale">
              Could not refresh: {error}
            </Alert>
          )}
          {shown === "chat" ? (
            <ChatPanel
              projectId={activeProjectId}
              view={view}
              entries={entries}
              live={live}
              refresh={refresh}
              botAvatar={botAvatar}
            />
          ) : (
            <>
              <TranscriptView
                items={items}
                speakers={{
                  botName: view.bot.name,
                  botAvatar,
                  platform,
                  speakerName: people.speakerName,
                }}
                waitingOnAnswer={
                  conversation.state === "waiting" &&
                  conversation.waitingOn?.kind === "answer"
                }
                highlight={highlight}
                codeRuns={codeRuns}
                sandboxJobs={sandboxJobs}
              />
              {conversation.state === "waiting" &&
                conversation.waitingOn?.kind === "approval" && (
                  <ApprovalWait
                    projectId={activeProjectId}
                    approvalIds={conversation.waitingOn.approvalIds}
                  />
                )}
              <Composer
                onSend={onSend}
                label="Send"
                placeholder={`Write to ${view.bot.name}`}
                deniedReason={messageDenied}
                testId="conversation-composer"
                hint={
                  conversation.state === "working"
                    ? `${view.bot.name} is working; it reads this before its next step.`
                    : conversation.state === "ended"
                      ? "This conversation has ended; writing starts a new turn."
                      : undefined
                }
              />
            </>
          )}
        </div>
      </DetailLayout>
    </div>
  );
}
