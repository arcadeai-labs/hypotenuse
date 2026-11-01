import type { MembershipList } from "@backend/actions/membership/membership-list";
import type { ActionResponse } from "keryx";
import { useMemo, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useRead } from "../../components/bots/data";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { DiffBlock } from "../../components/DiffBlock";
import { GatedButton } from "../../components/GatedButton";
import { LoadingLabel } from "../../components/LoadingLabel";
import { DetailLayout } from "../../components/layouts/DetailLayout";
import { MarkdownBlock } from "../../components/MarkdownBlock";
import {
  type MemoryDraft,
  MemoryEditor,
} from "../../components/memory/MemoryEditor";
import {
  decayTitle,
  diffStats,
  documentHref,
  explorerHref,
  lineDiff,
  type MemoryChannelsResponse,
  type MemoryDocumentView,
  type MemoryVersion,
  type MemoryVersionsResponse,
  type MemoryViewResponse,
  type MemoryWhere,
  memoryDocumentPath,
  STALE_BASE,
  sourceLabel,
  transcriptHref,
  whereBody,
} from "../../components/memory/model";
import { relativeTime } from "../../components/shell/NotificationBell";
import { DecayMeter } from "../../components/surfaces/DecayMeter";
import { useAuth } from "../../context/AuthContext";
import { useMay } from "../../hooks/useMay";
import { Alert, Button, Chip, Form, PropertiesPanel, Property } from "../../ui";
import { apiFetch } from "../../utils/client";
import {
  botsSentence,
  channelWriteDenied,
  PROJECT_WRITE_DENIED,
} from "./MemoryExplorerPage";

/** Why Promote is refused to someone the server says may not promote. */
const PROMOTE_DENIED =
  "Promoting into project memory takes write access to a bot working in the channel and admin standing in the project.";

/** Why a forgotten document offers only a restore. */
const FORGOTTEN =
  "It is forgotten. Restore an earlier version, or write it again, first.";

/** The half-lives memory fades with in the dashboard's view of it. */
const DEFAULT_HALF_LIVES = { channel: 30, project: 180 };

/**
 * `/memory/document` and `/memory/channels/:channelId/document` — one
 * memory document, by `?path=` (and `?version=` for an earlier one): its
 * text, rendered or raw; its history, with a line diff between any version
 * and the current one; where it came from, linking into the transcript; and
 * pin, edit, forget, and — for a channel's memory — promote into the
 * project's.
 *
 * What the caller may do is the server's word: `memory:view` answers
 * `standing.canWrite` and `standing.canPromote`. An edit names the version it
 * started from, so a write that would overwrite someone else's is refused and
 * the page says so, keeping the text.
 * @returns The page.
 */
export function MemoryDocumentPage() {
  const { channelId: channelParam } = useParams();
  const [params] = useSearchParams();
  const path = params.get("path") ?? "";
  const versionParam = Number(params.get("version"));
  const versionId =
    Number.isSafeInteger(versionParam) && versionParam > 0
      ? versionParam
      : null;
  const { activeProjectId, user } = useAuth();
  const { reason } = useMay();
  const navigate = useNavigate();
  const where: MemoryWhere = channelParam
    ? { scope: "channel", channelId: Number(channelParam) }
    : { scope: "project" };

  const view = useRead<MemoryViewResponse>(
    activeProjectId && path
      ? memoryDocumentPath(activeProjectId, where, path, { versionId })
      : null,
  );
  const versions = useRead<MemoryVersionsResponse>(
    activeProjectId && path
      ? memoryDocumentPath(activeProjectId, where, path, { versions: true })
      : null,
  );
  const channels = useRead<MemoryChannelsResponse>(
    activeProjectId && where.scope === "channel"
      ? `/project/${activeProjectId}/memory/channels?limit=100`
      : null,
  );
  const members = useRead<ActionResponse<MembershipList>>(
    activeProjectId ? `/project/${activeProjectId}/members?limit=100` : null,
  );

  const [raw, setRaw] = useState(false);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [forgetting, setForgetting] = useState(false);
  const [forgetReason, setForgetReason] = useState("");
  const [promoting, setPromoting] = useState(false);
  const [targetPath, setTargetPath] = useState("");
  const [promoteNote, setPromoteNote] = useState("");
  const [compareId, setCompareId] = useState<number | null>(null);

  const history = versions.data?.versions ?? [];
  const current = history.find((v) => v.current) ?? null;
  // Compare the chosen version with the current one; by default, the one before it.
  const compared =
    history.find((v) => v.versionId === compareId) ??
    (versionId ? history.find((v) => v.versionId === versionId) : null) ??
    history.find((v) => !v.current) ??
    null;
  const diff = useMemo(
    () =>
      compared && current && compared.versionId !== current.versionId
        ? lineDiff(compared.content ?? "", current.content ?? "")
        : null,
    [compared, current],
  );

  /**
   * A person's display name from their user id.
   * @param userId - The user.
   * @returns Their name.
   */
  function personName(userId: number | null | undefined): string {
    if (!userId) return "Someone";
    if (userId === user?.id) return user.name;
    return (
      members.data?.memberships.find((m) => m.user.id === userId)?.user.name ??
      "A member"
    );
  }

  if (!activeProjectId) {
    return (
      <div className="page" data-testid="memory-document-page">
        <Alert variant="info" data-testid="no-project">
          Choose a project to see its memory.
        </Alert>
      </div>
    );
  }
  if (!path) {
    return (
      <div className="page" data-testid="memory-document-page">
        <Alert variant="warning" data-testid="memory-document-missing">
          No document named.{" "}
          <Link to={explorerHref(where)}>Back to memory</Link>
        </Alert>
      </div>
    );
  }
  if (view.data === null && !view.error) {
    return (
      <div className="page" data-testid="memory-document-page">
        <LoadingLabel
          block
          testId="memory-document-loading"
          label="Loading the document"
        />
      </div>
    );
  }
  if (!view.data) {
    return (
      <div className="page" data-testid="memory-document-page">
        <Alert variant="warning" data-testid="memory-document-missing">
          {view.error}. It may have been forgotten and swept away, or belong to
          a channel whose bots are limited to tags you do not hold.{" "}
          <Link to={explorerHref(where)}>Back to memory</Link>
        </Alert>
      </div>
    );
  }

  const { document: doc, standing } = view.data;
  const viewingOld = versionId !== null && !doc.current;
  const channel = channels.data?.channels.find(
    (c) => where.scope === "channel" && c.id === where.channelId,
  );
  const halfLives = DEFAULT_HALF_LIVES;
  const halfLife =
    doc.scope === "channel" ? halfLives.channel : halfLives.project;
  const notWriter = standing.canWrite
    ? undefined
    : where.scope === "project"
      ? PROJECT_WRITE_DENIED
      : channel
        ? channelWriteDenied(channel)
        : "You may not change this channel's memory.";
  const editDenied = reason("memory:write") ?? notWriter;
  const pinDenied =
    reason("memory:pin") ??
    notWriter ??
    (doc.forgotten ? FORGOTTEN : undefined);
  const forgetDenied =
    reason("memory:forget") ??
    notWriter ??
    (doc.forgotten ? "It is already forgotten." : undefined);
  const promoteDenied =
    reason("memory:promote") ??
    (standing.canPromote ? undefined : PROMOTE_DENIED) ??
    (doc.forgotten ? FORGOTTEN : undefined);
  const base = `/project/${activeProjectId}/memory/document`;

  /** Read the document and its history again. */
  async function reload() {
    await Promise.all([view.reload(), versions.reload()]);
  }

  /**
   * Run one change and report how it went.
   * @param fn - The request.
   * @param success - What to say when it worked.
   * @returns `null` when it worked, else why it did not.
   */
  async function run(
    fn: () => Promise<unknown>,
    success: string,
  ): Promise<string | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      setNotice(success);
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : "That did not work.";
      setError(message);
      return message;
    } finally {
      setBusy(false);
    }
  }

  /**
   * Write a new version on top of the current one, refused if someone else
   * wrote one since.
   * @param draft - The editor's fields.
   * @param baseVersionId - The version the text was edited from.
   * @returns Whether it was written.
   */
  async function write(draft: MemoryDraft, baseVersionId: number) {
    setConflict(false);
    const failed = await run(
      () =>
        apiFetch(base, {
          method: "PUT",
          body: JSON.stringify({
            ...whereBody(where),
            path: doc.path,
            content: draft.content,
            ...(draft.description.trim()
              ? { description: draft.description.trim() }
              : {}),
            ...(draft.changeNote.trim()
              ? { changeNote: draft.changeNote.trim() }
              : {}),
            baseVersionId,
          }),
        }),
      "Saved a new version.",
    );
    if (failed) {
      setConflict(STALE_BASE.test(failed));
      return false;
    }
    setEditing(false);
    navigate(documentHref(where, doc.path), { replace: true });
    await reload();
    return true;
  }

  /** Restore the version on screen as a new current version. */
  async function onRestore(old: MemoryDocumentView) {
    const at = current?.versionId ?? doc.versionId;
    await write(
      {
        path: doc.path,
        description: old.description,
        content: old.content ?? "",
        changeNote: `Restored the version of ${new Date(old.versionId).toLocaleString()}`,
      },
      at,
    );
  }

  /** Pin it, or unpin it. */
  async function onPin() {
    await run(
      () =>
        apiFetch(`${base}/pin`, {
          method: "POST",
          body: JSON.stringify({
            ...whereBody(where),
            path: doc.path,
            pinned: !doc.pinned,
          }),
        }),
      doc.pinned
        ? "Unpinned: it fades again with disuse."
        : "Pinned: it never fades.",
    );
    await reload();
  }

  /** Forget it (its history is kept), then go back to the explorer. */
  async function onForget() {
    const failed = await run(
      () =>
        apiFetch(base, {
          method: "DELETE",
          body: JSON.stringify({
            ...whereBody(where),
            path: doc.path,
            ...(forgetReason.trim() ? { reason: forgetReason.trim() } : {}),
          }),
        }),
      "Forgotten.",
    );
    setForgetting(false);
    if (!failed) navigate(explorerHref(where));
  }

  /** Copy it into project memory, then open the copy. */
  async function onPromote() {
    if (where.scope !== "channel") return;
    let promotedPath: string | null = null;
    const failed = await run(async () => {
      const res = await apiFetch<{ document: { path: string } }>(
        `${base}/promote`,
        {
          method: "POST",
          body: JSON.stringify({
            channelId: where.channelId,
            path: doc.path,
            ...(viewingOld ? { versionId: doc.versionId } : {}),
            ...(targetPath.trim() && targetPath.trim() !== doc.path
              ? { targetPath: targetPath.trim() }
              : {}),
            ...(promoteNote.trim() ? { changeNote: promoteNote.trim() } : {}),
          }),
        },
      );
      promotedPath = res.document.path;
    }, "Promoted into project memory.");
    setPromoting(false);
    if (!failed && promotedPath)
      navigate(documentHref({ scope: "project" }, promotedPath));
  }

  const crumbs = (
    <span className="bot-page-title">
      {where.scope === "channel" ? (
        <>
          <Link to="/memory" className="shell-page-crumb">
            Channel memory
          </Link>
          <span className="shell-page-subtitle" aria-hidden="true">
            {" "}
            /{" "}
          </span>
          <Link to={explorerHref(where)} className="shell-page-crumb">
            {channel?.name ?? "Channel"}
          </Link>
        </>
      ) : (
        <Link to="/memory" className="shell-page-crumb">
          Project memory
        </Link>
      )}
      <span className="shell-page-subtitle" aria-hidden="true">
        {" "}
        /{" "}
      </span>
      <span className="mono" data-testid="memory-document-title">
        {doc.path}
      </span>
    </span>
  );

  return (
    <div className="memory-document-page" data-testid="memory-document-page">
      <DetailLayout
        title={crumbs}
        actions={
          <>
            <GatedButton
              size="sm"
              variant="secondary"
              deniedReason={pinDenied}
              disabled={busy}
              onClick={onPin}
              data-testid="memory-pin"
            >
              {doc.pinned ? "Unpin" : "Pin"}
            </GatedButton>
            <GatedButton
              size="sm"
              variant="secondary"
              deniedReason={editDenied}
              disabled={busy || editing}
              onClick={() => {
                setEditing(true);
                setConflict(false);
                setError(null);
              }}
              data-testid="memory-edit"
            >
              Edit
            </GatedButton>
            {where.scope === "channel" && (
              <GatedButton
                size="sm"
                variant="secondary"
                deniedReason={promoteDenied}
                disabled={busy}
                onClick={() => {
                  setTargetPath(doc.path);
                  setPromoting(true);
                }}
                data-testid="memory-promote"
              >
                Promote
              </GatedButton>
            )}
            <GatedButton
              size="sm"
              variant="outline-danger"
              deniedReason={forgetDenied}
              disabled={busy}
              onClick={() => setForgetting(true)}
              data-testid="memory-forget"
            >
              Forget
            </GatedButton>
          </>
        }
        properties={
          <PropertiesPanel data-testid="memory-properties">
            <Property label="Scope">
              {where.scope === "project" ? (
                "Project — every bot, every channel"
              ) : (
                <span>
                  {channel?.name ?? "This channel"} — shared by{" "}
                  {channel ? botsSentence(channel) : "every bot working here"}
                </span>
              )}
            </Property>
            <Property label="Freshness">
              <span className="memory-freshness">
                <DecayMeter
                  freshness={doc.decay ?? 1}
                  title={decayTitle(doc.decay ?? 1, halfLife, doc.pinned)}
                />
                <span className="tabular" data-testid="memory-decay">
                  {Math.round((doc.decay ?? 1) * 100)}%
                </span>
              </span>
              <span className="text-meta bot-property-detail">
                {doc.pinned
                  ? "Pinned: never fades"
                  : `Half-life ${halfLife} days unused`}
              </span>
            </Property>
            <Property label="Source">
              <span data-testid="memory-source">
                {sourceLabel(doc.sourceType)}
              </span>
            </Property>
            <Property label="From">
              <Provenance doc={doc} personName={personName} />
            </Property>
            <Property label="Version">
              <span
                className="tabular"
                title={new Date(doc.versionId).toLocaleString()}
              >
                {relativeTime(doc.versionId)}
              </span>
              {doc.changeNote && (
                <span className="text-meta bot-property-detail">
                  {doc.changeNote}
                </span>
              )}
            </Property>
            <Property label="Read">
              <span className="tabular">
                {doc.accessCount} {doc.accessCount === 1 ? "time" : "times"}
              </span>
              {doc.lastAccessedAt && (
                <span className="text-meta bot-property-detail">
                  last {relativeTime(doc.lastAccessedAt)}
                </span>
              )}
            </Property>
          </PropertiesPanel>
        }
      >
        <div className="memory-document">
          {error && !editing && (
            <Alert
              variant="danger"
              dismissible
              onClose={() => setError(null)}
              data-testid="memory-document-error"
            >
              {error}
            </Alert>
          )}
          {notice && (
            <Alert
              variant="success"
              dismissible
              onClose={() => setNotice(null)}
              data-testid="memory-document-notice"
            >
              {notice}
            </Alert>
          )}
          {doc.forgotten && !viewingOld && (
            <Alert variant="warning" data-testid="memory-forgotten">
              This document is forgotten: no bot finds it any more. Its earlier
              versions are kept below; open one to restore it.
            </Alert>
          )}
          {viewingOld && (
            <Alert variant="info" data-testid="memory-old-version">
              <div className="memory-banner">
                <span>
                  You are reading the version of{" "}
                  {new Date(doc.versionId).toLocaleString()}, not the current
                  one.{" "}
                  <Link to={documentHref(where, doc.path)}>
                    Current version
                  </Link>
                </span>
                <GatedButton
                  size="sm"
                  variant="outline-secondary"
                  deniedReason={editDenied}
                  disabled={busy}
                  onClick={() => onRestore(doc)}
                  data-testid="memory-restore"
                >
                  Restore this version
                </GatedButton>
              </div>
            </Alert>
          )}
          {doc.description && (
            <p className="memory-document-description">{doc.description}</p>
          )}
          {editing ? (
            <div className="memory-panel">
              <MemoryEditor
                initial={{
                  path: doc.path,
                  description: doc.description,
                  content: (current ?? doc).content ?? "",
                  changeNote: "",
                }}
                busy={busy}
                deniedReason={editDenied}
                error={
                  conflict
                    ? "Someone changed this document while you were editing it. Your text is kept: load the current version, look at what changed below, and save again."
                    : error
                }
                onSubmit={async (draft) => {
                  await write(draft, current?.versionId ?? doc.versionId);
                }}
                onCancel={() => {
                  setEditing(false);
                  setConflict(false);
                }}
                errorAction={
                  conflict ? (
                    <Button
                      size="sm"
                      variant="link"
                      onClick={async () => {
                        await reload();
                        setConflict(false);
                        setError(null);
                      }}
                      data-testid="memory-load-current"
                    >
                      Load the current version
                    </Button>
                  ) : undefined
                }
                testId="memory-document-editor"
              />
            </div>
          ) : (
            !doc.forgotten && (
              <section className="memory-panel" data-testid="memory-content">
                <div className="memory-tabs" role="group" aria-label="View">
                  <Button
                    size="sm"
                    variant={raw ? "link" : "outline-secondary"}
                    aria-pressed={!raw}
                    onClick={() => setRaw(false)}
                    data-testid="memory-rendered"
                  >
                    Rendered
                  </Button>
                  <Button
                    size="sm"
                    variant={raw ? "outline-secondary" : "link"}
                    aria-pressed={raw}
                    onClick={() => setRaw(true)}
                    data-testid="memory-raw"
                  >
                    Raw
                  </Button>
                </div>
                {raw ? (
                  <pre className="memory-raw" data-testid="memory-raw-text">
                    {doc.content}
                  </pre>
                ) : (
                  <div className="memory-content">
                    <MarkdownBlock>{doc.content ?? ""}</MarkdownBlock>
                  </div>
                )}
              </section>
            )
          )}
          <History
            where={where}
            history={history}
            total={versions.data?.pagination.total ?? 0}
            shownId={doc.versionId}
            compared={compared}
            onCompare={setCompareId}
          />
          {diff && compared && (
            <section className="memory-panel" data-testid="memory-diff">
              <h2 className="settings-subheading">
                Changes since {new Date(compared.versionId).toLocaleString()}
                <span className="text-meta memory-diff-stats tabular">
                  {" "}
                  +{diffStats(diff).added} −{diffStats(diff).removed}
                </span>
              </h2>
              <DiffBlock diff={diff} />
            </section>
          )}
        </div>
      </DetailLayout>
      <ConfirmDialog
        show={forgetting}
        title={`Forget ${doc.path}?`}
        confirmLabel="Forget"
        busy={busy}
        onConfirm={onForget}
        onCancel={() => setForgetting(false)}
        testId="memory-forget"
      >
        <p>
          No bot will find it again. Its history is kept, so it can be restored
          from here.
        </p>
        <Form.Group controlId="memory-forget-reason" className="mb-0">
          <Form.Label>
            Why <span className="text-meta">optional</span>
          </Form.Label>
          <Form.Control
            size="sm"
            maxLength={500}
            value={forgetReason}
            onChange={(e) => setForgetReason(e.target.value)}
            data-testid="memory-forget-reason"
          />
        </Form.Group>
      </ConfirmDialog>
      <ConfirmDialog
        show={promoting}
        title="Promote into project memory?"
        confirmLabel="Promote"
        busy={busy}
        onConfirm={onPromote}
        onCancel={() => setPromoting(false)}
        testId="memory-promote"
      >
        <p>
          A copy goes into project memory, where every bot reads it in every
          channel — including people who never saw this channel. It cites this
          version as its source.
        </p>
        <Form.Group controlId="memory-promote-path" className="mb-2">
          <Form.Label>Path in project memory</Form.Label>
          <Form.Control
            size="sm"
            className="mono"
            value={targetPath}
            onChange={(e) => setTargetPath(e.target.value)}
            data-testid="memory-promote-path"
          />
        </Form.Group>
        <Form.Group controlId="memory-promote-note" className="mb-0">
          <Form.Label>
            Why <span className="text-meta">optional</span>
          </Form.Label>
          <Form.Control
            size="sm"
            maxLength={500}
            value={promoteNote}
            onChange={(e) => setPromoteNote(e.target.value)}
            data-testid="memory-promote-note"
          />
        </Form.Group>
      </ConfirmDialog>
    </div>
  );
}

/**
 * Where a version came from, as links: the conversation and the entries it
 * was learned from, the person who wrote it, or the channel memory it was
 * promoted from.
 * @param props.doc - The version.
 * @param props.personName - A user id's display name.
 * @returns The links.
 */
function Provenance({
  doc,
  personName,
}: {
  doc: MemoryDocumentView;
  personName: (userId: number | null | undefined) => string;
}) {
  const p = doc.provenance;
  const parts = [];
  if (p.conversationId) {
    parts.push(
      <Link
        key="conversation"
        to={transcriptHref(p.conversationId, p.seqs)}
        data-testid="memory-provenance-conversation"
      >
        Conversation #{p.conversationId}
        {p.seqs && p.seqs.length > 0
          ? `, ${p.seqs.length === 1 ? "entry" : "entries"} ${p.seqs.join(", ")}`
          : ""}
      </Link>,
    );
  }
  if (p.promotedFromChannelId) {
    parts.push(
      <Link
        key="promoted"
        to={explorerHref({
          scope: "channel",
          channelId: p.promotedFromChannelId,
        })}
        data-testid="memory-provenance-promoted"
      >
        The channel memory it was promoted from
      </Link>,
    );
  }
  const author = p.userId ?? doc.authorUserId;
  if (author) parts.push(<span key="person">{personName(author)}</span>);
  if (parts.length === 0) {
    parts.push(
      <span key="none">
        {doc.sourceType === "decay" ? "The decay clock" : "—"}
      </span>,
    );
  }
  return <span className="memory-provenance">{parts}</span>;
}

/**
 * Every version of the document, newest first: when, what wrote it, and why,
 * each opening that version; one is chosen to compare with the current one.
 * @param props.where - Where the document lives.
 * @param props.history - The versions.
 * @param props.total - How many there are.
 * @param props.shownId - The version on screen.
 * @param props.compared - The version compared with the current one.
 * @param props.onCompare - Choose another to compare.
 * @returns The history.
 */
function History({
  where,
  history,
  total,
  shownId,
  compared,
  onCompare,
}: {
  where: MemoryWhere;
  history: MemoryVersion[];
  total: number;
  shownId: number;
  compared: MemoryVersion | null;
  onCompare: (versionId: number) => void;
}) {
  if (history.length === 0) return null;
  return (
    <section className="memory-panel" data-testid="memory-history">
      <h2 className="settings-subheading">
        History <span className="text-meta tabular">{total}</span>
      </h2>
      <ol className="memory-versions" aria-label="Versions">
        {history.map((v, i) => (
          <li
            key={v.versionId}
            className="memory-version"
            aria-current={v.versionId === shownId ? "true" : undefined}
            data-testid={`memory-version-${total - i}`}
          >
            <Link
              to={documentHref(where, v.path, v.current ? null : v.versionId)}
              className="tabular"
            >
              v{total - i}
            </Link>
            <span
              className="text-meta tabular"
              title={new Date(v.versionId).toLocaleString()}
            >
              {relativeTime(v.versionId)}
            </span>
            {v.current && <Chip tone="accent">Current</Chip>}
            {v.forgotten && <Chip>Forgotten</Chip>}
            <span className="text-meta">{sourceLabel(v.sourceType)}</span>
            {v.changeNote && (
              <span className="memory-version-note">{v.changeNote}</span>
            )}
            {!v.current && (
              <Button
                size="sm"
                variant="link"
                className="memory-version-compare"
                aria-pressed={compared?.versionId === v.versionId}
                onClick={() => onCompare(v.versionId)}
                data-testid={`memory-compare-${total - i}`}
              >
                {compared?.versionId === v.versionId
                  ? "Compared"
                  : "Compare with current"}
              </Button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
