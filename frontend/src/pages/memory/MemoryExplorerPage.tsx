import { Search } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useRead } from "../../components/bots/data";
import { GatedButton } from "../../components/GatedButton";
import { ListLayout } from "../../components/layouts/ListLayout";
import {
  type MemoryDraft,
  MemoryEditor,
} from "../../components/memory/MemoryEditor";
import {
  decayTitle,
  documentHref,
  explorerHref,
  formatScore,
  halfLifeOf,
  type MemoryChannel,
  type MemoryChannelsResponse,
  type MemoryDocumentRow,
  type MemoryListResponse,
  type MemorySearchResponse,
  type MemoryWhere,
  memoryListPath,
  memorySearchPath,
  sourceLabel,
  whereBody,
} from "../../components/memory/model";
import { SkeletonBlocks } from "../../components/SkeletonBlocks";
import { relativeTime } from "../../components/shell/NotificationBell";
import { DecayMeter } from "../../components/surfaces/DecayMeter";
import { platformOf } from "../../components/transcript/model";
import { useAuth } from "../../context/AuthContext";
import { useMay } from "../../hooks/useMay";
import { useProjectStanding } from "../../hooks/useProjectStanding";
import {
  Alert,
  Button,
  Chip,
  Form,
  ListGroup,
  ListRow,
  Pagination,
  PlatformChip,
} from "../../ui";
import { apiFetch } from "../../utils/client";

/** Why a member who is not an admin may not write project memory. */
export const PROJECT_WRITE_DENIED =
  "Only project admins write project memory, which every bot in every channel shares. Promote a channel's memory, or ask an admin.";

/** An empty draft for a new document. */
const BLANK: MemoryDraft = {
  path: "",
  description: "",
  content: "",
  changeNote: "",
};

/**
 * Why a member may not write a channel's memory: it takes write access to a
 * bot working in the channel.
 * @param channel - The channel, with its bots.
 * @returns The sentence.
 */
export function channelWriteDenied(channel: MemoryChannel): string {
  const names = channel.bots.map((b) => b.name);
  return names.length > 0
    ? `Changing this channel's memory takes write access to a bot working in it (${names.join(", ")}). Ask someone who may change one of them, or an admin.`
    : "Changing this channel's memory takes write access to a bot working in it, and none works here yet. Ask an admin.";
}

/**
 * Who shares a channel's memory, in words: the bots working in it.
 * @param channel - The channel, with its bots.
 * @returns E.g. `Toad and Peach`.
 */
export function botsSentence(channel: MemoryChannel): string {
  const names = channel.bots.map((b) => b.name);
  if (names.length === 0) return "No bot works here yet";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * `/memory` and `/memory/channels/:channelId` — the memory explorer. Project
 * memory, or one channel's memory (shared by every bot working there), chosen
 * beside the list.
 *
 * Both have the bot's own search — semantic and keyword ranking fused and
 * weighed by decay, with each part of the score shown — and the documents by
 * path, each with a faded bar saying how much weight it has left (its
 * half-life on hover). When the project has no embedding model, or chunks
 * still wait for one, a banner says search matches words only, with Reindex
 * for an admin.
 * @returns The page.
 */
export function MemoryExplorerPage() {
  const { channelId: channelParam } = useParams();
  const channelId = channelParam ? Number(channelParam) : null;
  const { activeProjectId, activeOrganizationId } = useAuth();
  const { reason } = useMay();
  const projectStanding = useProjectStanding();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const query = params.get("q") ?? "";
  const [typed, setTyped] = useState(query);
  const [withProject, setWithProject] = useState(false);
  const [prefix, setPrefix] = useState("");
  const [forgotten, setForgotten] = useState(false);
  const [chosen, setChosen] = useState({ key: "", page: 1 });
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => setTyped(query), [query]);

  const where: MemoryWhere =
    channelId === null ? { scope: "project" } : { scope: "channel", channelId };
  const filterKey = `${channelId}:${prefix}:${forgotten}`;
  const page = chosen.key === filterKey ? chosen.page : 1;

  const channels = useRead<MemoryChannelsResponse>(
    activeProjectId !== null
      ? `/project/${activeProjectId}/memory/channels?limit=100`
      : null,
  );
  const list = useRead<MemoryListResponse>(
    activeProjectId !== null && where
      ? memoryListPath(activeProjectId, where, {
          page,
          pathPrefix: prefix.trim() || undefined,
          includeForgotten: forgotten,
        })
      : null,
  );
  const search = useRead<MemorySearchResponse>(
    activeProjectId !== null && where && query
      ? memorySearchPath(activeProjectId, where, query, withProject)
      : null,
  );

  if (!activeProjectId) {
    return (
      <div className="page" data-testid="memory-explorer">
        <Alert variant="info" data-testid="no-project">
          {activeOrganizationId ? (
            <>
              This organization shows you no projects yet. See the{" "}
              <Link to="/organization/projects">organization's projects</Link>.
            </>
          ) : (
            "Choose an organization, then a project, to see its memory."
          )}
        </Alert>
      </div>
    );
  }

  const channel = channels.data?.channels.find((c) => c.id === channelId);
  const writeDenied =
    reason("memory:write") ??
    (where.scope === "channel"
      ? channel && !channel.canWrite
        ? channelWriteDenied(channel)
        : undefined
      : projectStanding && !projectStanding.isAdmin
        ? PROJECT_WRITE_DENIED
        : undefined);
  const reindexDenied = reason("memory:reindex");
  const pages = list.data?.pagination.pages ?? 0;

  /**
   * Search, keeping the query in the address so it can be shared.
   * @param e - The form's submit.
   */
  function onSearch(e: FormEvent) {
    e.preventDefault();
    const next = new URLSearchParams(params);
    if (typed.trim()) next.set("q", typed.trim());
    else next.delete("q");
    setParams(next);
  }

  /** Re-embed what the current embedding model has not embedded. */
  async function onReindex() {
    setBusy(true);
    setNotice(null);
    try {
      const res = await apiFetch<{
        embeddingModel: string | null;
        queuedChunks: number;
      }>(`/project/${activeProjectId}/memory/reindex`, { method: "POST" });
      setNotice(
        res.embeddingModel
          ? `Embedding ${res.queuedChunks} ${res.queuedChunks === 1 ? "chunk" : "chunks"} with ${res.embeddingModel}. Search uses them as they finish.`
          : "There is no embedding model to reindex with yet.",
      );
      await list.reload();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Could not reindex.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Write a new document, then open it.
   * @param draft - What the editor holds.
   */
  async function onWrite(draft: MemoryDraft) {
    setBusy(true);
    setWriteError(null);
    try {
      const res = await apiFetch<{ document: { path: string } }>(
        `/project/${activeProjectId}/memory/document`,
        {
          method: "PUT",
          body: JSON.stringify({
            ...whereBody(where),
            path: draft.path.trim(),
            content: draft.content,
            ...(draft.description.trim()
              ? { description: draft.description.trim() }
              : {}),
            ...(draft.changeNote.trim()
              ? { changeNote: draft.changeNote.trim() }
              : {}),
          }),
        },
      );
      navigate(documentHref(where, res.document.path));
    } catch (err) {
      setWriteError(err instanceof Error ? err.message : "Could not write it.");
      setBusy(false);
    }
  }

  const title =
    where.scope === "project" ? (
      "Project memory"
    ) : (
      <span className="bot-page-title">
        <Link to="/memory" className="shell-page-crumb">
          Channel memory
        </Link>
        <span className="shell-page-subtitle" aria-hidden="true">
          {" "}
          /{" "}
        </span>
        <span data-testid="memory-channel-title">
          {channel?.name ?? "Channel"}
        </span>
      </span>
    );

  return (
    <ListLayout
      title={title}
      actions={
        <GatedButton
          size="sm"
          variant="secondary"
          deniedReason={writeDenied}
          disabled={writing}
          onClick={() => {
            setWriting(true);
            setWriteError(null);
          }}
          data-testid="memory-new-document"
        >
          New document
        </GatedButton>
      }
    >
      <div
        className="memory-page has-scopes"
        data-testid="memory-explorer"
        data-scope={where.scope}
      >
        <nav
          className="memory-scopes"
          aria-label="Memory scopes"
          data-testid="memory-scopes"
        >
          <Link
            to="/memory"
            className="memory-scope memory-scope-project"
            aria-current={where.scope === "project" ? "page" : undefined}
            data-testid="memory-scope-project"
          >
            <span className="memory-scope-name">Project memory</span>
          </Link>
          <span className="memory-scopes-heading">Channel memory</span>
          {channels.data?.channels.map((c) => (
            <Link
              key={c.id}
              to={explorerHref({ scope: "channel", channelId: c.id })}
              className="memory-scope"
              aria-current={c.id === channelId ? "page" : undefined}
              title={botsSentence(c)}
              data-testid={`memory-channel-${c.id}`}
            >
              <PlatformChip platform={platformOf(c.type)} />
              <span className="memory-scope-name">{c.name}</span>
              <span className="text-meta tabular">{c.documents}</span>
            </Link>
          ))}
          {channels.data?.channels.length === 0 && (
            <span
              className="memory-scopes-empty text-meta"
              data-testid="memory-no-channels"
            >
              No channels yet. One appears once someone talks to a bot — over
              the API, in the dashboard, in Slack, or in Linear.
            </span>
          )}
        </nav>
        <div className="memory-main">
          {channels.error && (
            <Alert variant="warning" data-testid="memory-channels-error">
              {channels.error}
            </Alert>
          )}
          {where.scope === "channel" && channels.data && !channel && (
            <Alert variant="warning" data-testid="channel-missing">
              This channel does not exist, or no bot working in it is one you
              can read. <Link to="/memory">Back to project memory</Link>
            </Alert>
          )}
          {(where.scope === "project" || channel) && (
            <>
              <p className="memory-intro text-meta">
                {where.scope === "project"
                  ? "What every bot in every channel of this project shares. It fades slowly and only a person changes it."
                  : `What is remembered about ${channel?.name ?? "this channel"}, shared by every bot working here (${channel ? botsSentence(channel) : "…"}). No other channel sees it. Unused, it fades.`}
              </p>
              <IndexBanner
                list={list.data}
                reindexDenied={reindexDenied}
                busy={busy}
                onReindex={onReindex}
              />
              {notice && (
                <Alert
                  variant="info"
                  dismissible
                  onClose={() => setNotice(null)}
                  data-testid="memory-notice"
                >
                  {notice}
                </Alert>
              )}
              {writing && (
                <div className="memory-panel">
                  <h2 className="settings-subheading">New document</h2>
                  <MemoryEditor
                    initial={BLANK}
                    newDocument
                    busy={busy}
                    deniedReason={writeDenied}
                    error={writeError}
                    onSubmit={onWrite}
                    onCancel={() => setWriting(false)}
                    testId="memory-editor"
                  />
                </div>
              )}
              <form
                className="memory-search"
                role="search"
                onSubmit={onSearch}
                data-testid="memory-search"
              >
                <Search size={14} aria-hidden="true" />
                <input
                  type="search"
                  className="shell-search-input"
                  placeholder={
                    where.scope === "project"
                      ? "Search project memory"
                      : "Search this channel's memory"
                  }
                  aria-label="Search memory"
                  data-search
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  data-testid="memory-search-input"
                />
                {where.scope === "channel" && (
                  <Form.Check
                    type="switch"
                    id="memory-search-project"
                    label="Include project memory"
                    checked={withProject}
                    onChange={(e) => setWithProject(e.target.checked)}
                    data-testid="memory-search-with-project"
                  />
                )}
                <Button
                  size="sm"
                  type="submit"
                  variant="secondary"
                  data-testid="memory-search-submit"
                >
                  Search
                </Button>
              </form>
              {query && (
                <SearchResults
                  where={where}
                  query={query}
                  search={search.data}
                  error={search.error}
                  halfLifeDays={list.data?.halfLifeDays ?? null}
                  bannerShown={list.data?.index.embeddingModel === null}
                  onClear={() => {
                    const next = new URLSearchParams(params);
                    next.delete("q");
                    setParams(next);
                  }}
                />
              )}
              <div className="memory-filters">
                <Form.Control
                  size="sm"
                  className="mono memory-prefix"
                  placeholder="Folder, such as facts/"
                  aria-label="Only paths starting with"
                  value={prefix}
                  onChange={(e) => setPrefix(e.target.value)}
                  data-testid="memory-prefix"
                />
                <Form.Check
                  type="switch"
                  id="memory-forgotten"
                  label="Show forgotten"
                  checked={forgotten}
                  onChange={(e) => setForgotten(e.target.checked)}
                  data-testid="memory-show-forgotten"
                />
              </div>
              {list.error && (
                <Alert variant="danger" data-testid="memory-error">
                  {list.error}
                </Alert>
              )}
              {list.data === null && !list.error && (
                <SkeletonBlocks
                  count={3}
                  testId="memory-skeleton"
                  label="Loading memory"
                />
              )}
              {list.data?.documents.length === 0 && (
                <div className="shell-empty" data-testid="memory-empty">
                  {prefix.trim()
                    ? `Nothing under ${prefix.trim()}.`
                    : where.scope === "project"
                      ? "Project memory is empty. An admin writes it here, or promotes a fact a bot learned in one channel."
                      : "Nothing remembered here yet. The bots working here write what they learn, and after a conversation comes to rest they keep the facts worth keeping."}
                </div>
              )}
              {list.data && list.data.documents.length > 0 && (
                <ListGroup
                  title="Documents"
                  count={list.data.pagination.total}
                  data-testid="memory-documents"
                >
                  {list.data.documents.map((doc) => (
                    <DocumentRow
                      key={doc.id}
                      doc={doc}
                      where={where}
                      halfLifeDays={halfLifeOf(
                        doc.scope,
                        list.data?.halfLifeDays ?? {
                          channel: 30,
                          project: 180,
                        },
                      )}
                    />
                  ))}
                </ListGroup>
              )}
              {pages > 1 && (
                <Pagination size="sm" data-testid="memory-pages">
                  <Pagination.Prev
                    disabled={page <= 1}
                    onClick={() =>
                      setChosen({ key: filterKey, page: page - 1 })
                    }
                  />
                  <Pagination.Item active>
                    {page} of {pages}
                  </Pagination.Item>
                  <Pagination.Next
                    disabled={page >= pages}
                    onClick={() =>
                      setChosen({ key: filterKey, page: page + 1 })
                    }
                  />
                </Pagination>
              )}
            </>
          )}
        </div>
      </div>
    </ListLayout>
  );
}

/**
 * Says when search matches words only: the project has no embedding model,
 * or some chunks wait for one. An admin may start the re-embedding.
 * @param props.list - `memory:list`'s answer, or `null` before it.
 * @param props.reindexDenied - Why Reindex is refused, if it is.
 * @param props.busy - Whether a reindex is under way.
 * @param props.onReindex - Start one.
 * @returns The banner, or nothing when search is whole.
 */
function IndexBanner({
  list,
  reindexDenied,
  busy,
  onReindex,
}: {
  list: MemoryListResponse | null;
  reindexDenied?: string;
  busy: boolean;
  onReindex: () => void;
}) {
  if (!list) return null;
  const { embeddingModel, staleChunks } = list.index;
  if (embeddingModel && staleChunks === 0) return null;
  return (
    <Alert variant="warning" data-testid="memory-index-banner">
      <div className="memory-banner">
        <span>
          {embeddingModel === null ? (
            <>
              <strong>Search matches words only.</strong> This project has no
              embedding model, so search cannot find a memory by meaning. An
              admin adds a model named <code>embedding</code> under{" "}
              <Link to="/settings/models">Settings → Models</Link>.
            </>
          ) : (
            <>
              <strong>
                {staleChunks} {staleChunks === 1 ? "chunk is" : "chunks are"}{" "}
                not embedded with {embeddingModel} yet.
              </strong>{" "}
              Until they are, search finds them by their words only.
            </>
          )}
        </span>
        {embeddingModel !== null && (
          <GatedButton
            size="sm"
            variant="outline-secondary"
            deniedReason={reindexDenied}
            disabled={busy}
            onClick={onReindex}
            data-testid="memory-reindex"
          >
            Reindex
          </GatedButton>
        )}
      </div>
    </Alert>
  );
}

/**
 * One document in the list: its path and description, what last wrote it,
 * when, and how faded it is.
 * @param props.doc - The document.
 * @param props.where - Where it lives.
 * @param props.halfLifeDays - Its scope's half-life.
 * @returns The row.
 */
function DocumentRow({
  doc,
  where,
  halfLifeDays,
}: {
  doc: MemoryDocumentRow;
  where: MemoryWhere;
  halfLifeDays: number;
}) {
  const decay = doc.decay ?? 1;
  return (
    <ListRow
      as={Link}
      to={documentHref(
        doc.scope === "channel" && doc.channelId
          ? { scope: "channel", channelId: doc.channelId }
          : where.scope === "project"
            ? where
            : { scope: "project" },
        doc.path,
      )}
      className={doc.forgotten ? "memory-row is-forgotten" : "memory-row"}
      data-testid={`memory-row-${doc.path}`}
      identifier={<span className="mono memory-path">{doc.path}</span>}
      title={
        <span className="memory-description">
          {doc.description || "No description"}
        </span>
      }
      trailing={
        <>
          {doc.forgotten && <Chip>Forgotten</Chip>}
          {doc.pinned && <Chip tone="accent">Pinned</Chip>}
          <span className="text-meta memory-source">
            {sourceLabel(doc.sourceType)}
          </span>
          <span
            className="text-meta tabular"
            title={new Date(doc.versionId).toLocaleString()}
          >
            {relativeTime(doc.versionId)}
          </span>
          <DecayMeter
            freshness={decay}
            title={decayTitle(decay, halfLifeDays, doc.pinned)}
          />
        </>
      }
    />
  );
}

/**
 * What a search found: each hit's path, snippet, and every part of its score.
 * @param props.where - Where the search ran.
 * @param props.query - What was searched for.
 * @param props.search - `memory:search`'s answer, or `null` while it runs.
 * @param props.error - Why it failed.
 * @param props.halfLifeDays - The half-lives, for the decay bars.
 * @param props.bannerShown - The page's banner already says why search is keyword-only.
 * @param props.onClear - Put the search away.
 * @returns The results.
 */
function SearchResults({
  where,
  query,
  search,
  error,
  halfLifeDays,
  bannerShown,
  onClear,
}: {
  where: MemoryWhere;
  query: string;
  bannerShown: boolean;
  search: MemorySearchResponse | null;
  error: string | null;
  halfLifeDays: { channel: number; project: number } | null;
  onClear: () => void;
}) {
  return (
    <section className="memory-panel" data-testid="memory-hits">
      <header className="memory-hits-header">
        <h2 className="settings-subheading">
          Results for <q>{query}</q>
        </h2>
        {search && (
          <Chip data-testid="memory-search-mode">
            {search.mode === "hybrid" ? "Meaning and words" : "Words only"}
          </Chip>
        )}
        <Button
          size="sm"
          variant="link"
          onClick={onClear}
          data-testid="memory-search-clear"
        >
          Clear
        </Button>
      </header>
      {error && <Alert variant="danger">{error}</Alert>}
      {search?.keywordOnlyReason && !bannerShown && (
        <p className="text-meta" data-testid="memory-keyword-only">
          {search.keywordOnlyReason}
        </p>
      )}
      {search === null && !error && (
        <SkeletonBlocks
          count={2}
          testId="memory-hits-skeleton"
          label="Searching"
        />
      )}
      {search && search.hits.length === 0 && (
        <p className="text-meta" data-testid="memory-no-hits">
          Nothing in memory matches that.
        </p>
      )}
      {search && search.hits.length > 0 && (
        <ol className="memory-hits">
          {search.hits.map((hit) => {
            const hitWhere: MemoryWhere =
              hit.scope === "channel" && where.scope === "channel"
                ? where
                : { scope: "project" };
            const half = halfLifeDays
              ? halfLifeOf(hit.scope, halfLifeDays)
              : hit.scope === "channel"
                ? 30
                : 180;
            return (
              <li
                key={`${hit.documentId}-${hit.chunkIndex}`}
                className="memory-hit"
                data-testid={`memory-hit-${hit.path}`}
              >
                <div className="memory-hit-head">
                  <Link
                    to={documentHref(hitWhere, hit.path)}
                    className="mono memory-path"
                  >
                    {hit.path}
                  </Link>
                  {where.scope === "channel" && (
                    <Chip>
                      {hit.scope === "channel" ? "Channel" : "Project"}
                    </Chip>
                  )}
                  {hit.pinned && <Chip tone="accent">Pinned</Chip>}
                  <span className="memory-hit-score tabular">
                    {formatScore(hit.score)}
                  </span>
                </div>
                <p className="memory-hit-snippet">{hit.snippet}</p>
                <div className="memory-hit-parts text-meta tabular">
                  <span title="Rank fusion of the two sides, before decay; 1.00 is first on both">
                    relevance {formatScore(hit.relevance)}
                  </span>
                  <span className="memory-hit-decay">
                    decay {formatScore(hit.decay)}
                    <DecayMeter
                      freshness={hit.decay}
                      title={decayTitle(hit.decay, half, hit.pinned)}
                    />
                  </span>
                  <span>
                    meaning {hit.semanticRank ? `#${hit.semanticRank}` : "—"}
                  </span>
                  <span>
                    words {hit.keywordRank ? `#${hit.keywordRank}` : "—"}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
