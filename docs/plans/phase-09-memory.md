# Phase 09 — Memory

> **Goal:** A bot remembers. What it learns in a channel stays in that channel's memory and fades if nobody
> uses it again. What is true for the whole project lives in project memory, which every bot in the project
> reads. A bot reads and writes both through a few tools, a person browses and corrects them in a memory
> explorer, and nothing said in one channel can surface in another unless a person promotes it.

> **Status: planned, not built.** Builds on the [durable agent loop](./phase-08-durable-agent-loop.md) (the tool
> contract, conversations, `channels`) and [model providers](./phase-07-model-providers-and-bots.md) (the
> embedding model). Channels from Slack, Linear, and Pylon arrive in [13](./phase-13-channel-framework.md) through
> [16](./phase-16-pylon.md); the memory scope rules here already name them.

Hypotenuse is a shared agent, so its memory has an audience problem that a personal agent does not. Botholomew
and membot remember for one person on one machine. Hypotenuse remembers for a Slack channel, a Linear project,
or a customer's account, and the people who can read each of those are different people. The boundary of a
memory therefore has to be the boundary of the channel it came from, enforced in the query.

Memory is also the first place where time matters. A personal store can keep everything. A team agent that hears
hundreds of threads a week cannot, and stale context hurts as much as missing context. Neither reference
implements decay: membot has `created_at` and `refreshed_at` and uses neither to rank. This phase adds it.

## Scope

**In:**

1. `memory_documents` (versioned markdown, addressed by scope and logical path) and `memory_chunks` (chunk text,
   embedding, `tsvector`).
2. Two scopes: **project** and **channel**. The channel scope is per bot per channel; the mapping per platform is
   below.
3. Ingest: markdown-aware chunking, embeddings through AI SDK `embed()` / `embedMany()`, and an `embedding_revision`.
4. Hybrid search: pgvector cosine plus Postgres full-text, fused by weighted reciprocal rank (k = 60, semantic
   weight 0.6), at most 3 chunks per document, with time decay applied to the fused score.
5. Decay: the scoring function plus the `memory:decay` clock, which tombstones faded channel memory and prunes
   old versions.
6. Consolidation: after a conversation ends, the `fast` model extracts discrete facts with provenance into
   channel memory. Promotion to project memory needs a person, or a binding that allows it.
7. Model tools: `memory_search`, `memory_list`, `memory_read`, `memory_write`, `memory_edit`, and
   `memory_forget`. All are scoped to the conversation's channel and the project.
8. Human actions, the memory explorer page, CLI commands, and user docs.
9. A deterministic embedding endpoint on the scripted model server.

**Out:**

- Ingesting external sources (URLs, GitHub, Linear documents) with refresh, as membot's downloaders do. The
  schema keeps `sourceType`/`sourceRef` so it can be added; an MCP server plus `memory_write` covers it for now.
- Reranking with a cross-encoder. That is an open question, measured by the eval harness first.
- Code-mode access to memory: [12](./phase-12-code-mode.md) exposes these same operations as `memory.*`.
- Per-participant memory (what the bot knows about one person across channels). Settled non-goal for now: it
  crosses channel audiences.

## What already exists

| Thing | Where | Use here |
|---|---|---|
| membot's versioned store | [`src/db/migrations/001-init.ts`](https://github.com/evantahler/membot/blob/main/src/db/migrations/001-init.ts) | `(logical_path, version_id)` rows, tombstones, `change_note`, a `description` of 240 characters at most, a `current_files` view. Every read returns its `version_id` |
| membot's chunker and search text | [`src/ingest/chunker.ts`](https://github.com/evantahler/membot/blob/main/src/ingest/chunker.ts), [`src/ingest/search-text.ts`](https://github.com/evantahler/membot/blob/main/src/ingest/search-text.ts) | Split at headings without breaking code fences; target 1400 characters, max 1800; `search_text` = path, description, heading breadcrumb, then the body |
| membot's hybrid search | [`src/search/hybrid.ts`](https://github.com/evantahler/membot/blob/main/src/search/hybrid.ts) (`fuseRRF`), [`src/search/semantic.ts`](https://github.com/evantahler/membot/blob/main/src/search/semantic.ts), [`src/search/keyword.ts`](https://github.com/evantahler/membot/blob/main/src/search/keyword.ts) | Weighted RRF, per-file diversity cap with backfill, snippets centred on the matched term, score normalized to [0, 1] |
| membot's tool surface and instructions | [`src/mcp/instructions.ts`](https://github.com/evantahler/membot/blob/main/src/mcp/instructions.ts) | The discover → read → write workflow, said in the tool descriptions |
| membot's eval harness | [`scripts/eval-search.ts`](https://github.com/evantahler/membot/blob/main/scripts/eval-search.ts) | Recall@k, MRR, answer@3 against golden queries; ported as a test fixture |
| botholomew's line patches | [`src/fs/patches.ts`](https://github.com/evantahler/botholomew/blob/main/src/fs/patches.ts) | `LinePatchSchema` `{start_line, end_line, content}` for `memory_edit` |
| botholomew's field notes | [`docs/field-notes.md`](https://github.com/evantahler/botholomew/blob/main/docs/field-notes.md) | "Dreaming" consolidation fixated on themes rather than facts. Consolidation here writes facts with provenance, never reflections |
| The tool contract | [08](./phase-08-durable-agent-loop.md) | Memory reads are `replay: "safe"`; writes are `unsafe`, deduped by `toolCallId` |

## What this must not weaken

1. **A conversation reads only its own channel's memory and its project's.** No query, tool, or code path takes
   a channel id from the model. The channel is always the conversation's, resolved server-side.
2. **Promotion is the only way channel content reaches project scope,** and it is a person's decision unless an
   audited binding setting allows the bot to make it.
3. **History is append-only.** A write or edit is a new version. A forget is a tombstone. Only `memory:decay`'s
   prune, past a retention window, deletes versions, and never the current one.
4. **Every memory a bot writes carries provenance:** the conversation and entry it came from. A person must be
   able to ask "where did it learn that?" and get an answer.
5. **Embeddings never block a turn.** A write commits text and chunks at once; vectors arrive asynchronously, and
   search falls back to keyword ranking for chunks without one.

## Design

### 1. Scopes and what a "channel" is

| Platform | Channel (memory boundary) | Conversation |
|---|---|---|
| API | the `channelKey` a caller names (`default` if none) | one `conversation:create` |
| Slack | a Slack channel, or a DM with the bot | a thread |
| Linear | a **Linear project**; an issue with no project falls back to its **team** | an agent session on an issue |
| Pylon | a **customer account** (the company) | an issue |

A memory document has `scope = 'project'` (with `botId` null) or `scope = 'channel'` (with `botId` and
`channelId`). Channel memory is per bot, matching the hierarchy *project → bot → channel → memory*. Two bots in
one Slack channel keep separate channel memories and share project memory.

The **read set** of a conversation is `{channel: (conversation.botId, conversation.channelId), project:
conversation.projectId}`. Every memory query takes a `MemoryScope` built from the conversation row by
`MemoryOps.scopeFor(conversation)`, never from tool input. The tools' `scope` parameter chooses between
`"channel"`, `"project"`, and `"both"` (the default) *within* that set.

### 2. Documents, versions, and chunks

- A document is markdown addressed by `logicalPath`, such as `people/alex.md`, `decisions/2026-10-pricing.md`, or
  `facts/deploy-process.md`.
- Each write inserts a new `memory_documents` row with a new `versionId` (a timestamp) and a `changeNote`. The
  current version is the newest that is not a tombstone (the `current_memory_documents` view, as membot's
  `current_files`).
- **Chunking** follows membot's chunker: split at headings, never inside a code fence, 1400 characters target,
  1800 max.
- Each chunk stores `searchText = logicalPath + "\n" + description + "\n" + breadcrumb + "\n\n" + body`. Both the
  embedding and the `tsvector` are computed from `searchText`, so a query for a path or a heading finds the
  chunk.
- `description` (240 characters at most) is written by the author, or generated by the `fast` model when it is
  missing.

### 3. Embeddings

- `MemoryOps.embed` calls AI SDK `embedMany()` with the project's embedding model (a `model_aliases` row of
  `kind: "embedding"` on one of [07](./phase-07-model-providers-and-bots.md)'s connections; this phase adds that kind).
- The column is `vector(MEMORY_EMBEDDING_DIMENSIONS)`, a deployment constant (1536 by default). A model whose
  native size differs must support a `dimensions` option (OpenAI's `text-embedding-3-*` do), or the connection
  is refused at configuration time with a message that says so.
- **`embedding_revision`** combines the embedding model, the dimensions, and the `searchText` recipe; each chunk
  stores it. Changing any of them makes old chunks stale. `memory:reindex` re-embeds a project's stale chunks in
  batches, and search warns in the explorer until it is done (membot's `EMBEDDING_REVISION`).
- Writes commit chunks with a null embedding and enqueue `memory:embed` after commit. A chunk without a vector is
  ranked by keyword alone.

### 4. Hybrid search with decay

```
semantic = top 50 chunks by  embedding <=> embed(query)            (pgvector, HNSW, cosine)
keyword  = top 50 chunks by  ts_rank_cd(tsv, websearch_to_tsquery(query))
fused    = Σ  w_side / (k + rank_side)       k = 60, w_sem = 0.6, w_kw = 0.4
normal   = fused / (1 / (k + 1))             1.0 = first on both lists
decay    = exp(−ln 2 · age / halfLife[scope])     age = now − max(versionCreatedAt, lastAccessedAt)
score    = normal · (DECAY_FLOOR + (1 − DECAY_FLOOR) · decay)    DECAY_FLOOR = 0.25
```

- The candidate sets are restricted to the read set in the `WHERE` clause, never filtered afterwards.
- `diversify()` keeps at most 3 chunks per document and backfills to `limit` (membot's `max_per_file`).
- Snippets are centred on the first matched term.
- `halfLife` defaults to 30 days for channel scope and 180 days for project scope, and is configurable per bot.
  `pinned` documents never decay.
- The floor keeps an old but exact match findable. Decay ranks memories; it does not hide them.
- `lastAccessedAt` and `accessCount` move when a document is read with `memory_read`, or appears in the top 3
  of a search the model acted on (one `UPDATE … WHERE id = ANY(…)` per search).

### 5. The decay clock

`memory:decay` runs hourly (a clock with no web route) and fans out per project. In each project it:

- tombstones **channel** documents whose `decay < 0.05`, `accessCount < 3`, and not `pinned`, with `changeNote
  = "faded"` (history is kept);
- deletes non-current versions older than `MEMORY_VERSION_RETENTION_DAYS` (90), never a current version and
  never a version a promotion cites;
- deletes chunks of deleted versions.

Project memory never fades on its own; a person forgets it. This is a machine writer on the closed unaudited list
([05](./phase-05-audit-logging.md)), recorded as `changeNote`s.

### 6. Consolidation and promotion

**Consolidation.** When a conversation enters `hibernating` or `ended` and has at least 4 new entries since its
last consolidation, `memory:consolidate` runs on the `fast` model. It reads the new entries and the channel's
`facts/` index, and returns a structured object (`generateObject`): `{facts: [{path, statement, evidenceSeqs[],
supersedes?}]}`. It writes each fact into channel memory, with provenance `{conversationId, seqs}`. A fact that
supersedes another edits that document instead of adding a near-duplicate.

**Promotion** moves a fact from channel scope to project scope, as a new project document whose provenance cites
the channel version. It happens only:

- when a person promotes it (`memory:promote`, audited, `canWriteBot` plus `admin` for project scope);
- or, if the binding's `allowPromotion` is on (an audited binding setting from
  [13](./phase-13-channel-framework.md), off by default), when the bot calls `memory_write` with `scope:
  "project"`. The tool's description says the write will be visible in every channel.

Without either, `memory_write` to project scope from a channel conversation returns an error envelope that says
to ask a person to promote it.

A "same fact in three channels" automatic promotion was considered and left out: it would move private channel
content to every channel on the strength of a similarity score.

### 7. Model tools

| Tool | Replay | Input | Output |
|---|---|---|---|
| `memory_search` | safe | `query`, `scope?` (`channel`/`project`/`both`), `pathPrefix?`, `limit?` (10) | hits: `path, scope, versionId, snippet, score, description` |
| `memory_list` | safe | `scope?`, `pathPrefix?`, `limit?`, `offset?` | documents: `path, scope, description, updatedAt` |
| `memory_read` | safe | `path`, `scope`, `versionId?`, `startLine?`, `endLine?` | `content` with line numbers, `versionId`, `provenance` |
| `memory_write` | unsafe | `path`, `scope`, `content`, `description?`, `changeNote` | `versionId` |
| `memory_edit` | unsafe | `path`, `scope`, `patches: LinePatch[]`, `changeNote`, `baseVersionId` | `versionId`; refuses if `baseVersionId` is not current |
| `memory_forget` | unsafe | `path`, `scope`, `reason` | tombstone `versionId` |

Descriptions carry a familiar command where one fits (`[[ bash equivalent command: grep -r ]]` for
`memory_search`), which botholomew's field notes credit with better tool use. Errors use [08](./phase-08-durable-agent-loop.md)'s
envelope with a `next_action_hint`.

`memory_write`, `memory_edit`, and `memory_forget` do not need approval: memory is Hypotenuse's own store, as in
botholomew, where only outbound calls are gated. Project-scope writes are the exception described above.

### 8. The memory explorer

- A page per bot shows its channels and their memory.
- A page per project shows project memory.
- Both have search (the same hybrid query, with scores and the decay factor shown), document view with version
  history and a diff, provenance links into the transcript, pin, edit, forget, and promote.
- Reading channel memory requires `canReadBot`. A channel's memory carries what its members said, and binding the
  channel ([13](./phase-13-channel-framework.md)) is where that audience decision is recorded.

## Schema sketch

```ts
// backend/schema/memory_documents.ts
memory_documents: id serial pk, projectId, scope text ('project' | 'channel'),
  botId int null, channelId int null,                // both set iff scope = 'channel'
  logicalPath text, versionId timestamp(3) tz, tombstone bool default false,
  content text, description text, changeNote text null, pinned bool default false,
  sourceType text ('agent' | 'person' | 'consolidation' | 'promotion'),
  sourceRef jsonb,                                   // { conversationId, seqs } | { userId } | { promotedFromId }
  authorUserId int null, lastAccessedAt tstz null, accessCount int default 0,
  createdAt tstz
  unique (projectId, scope, coalesce(botId,0), coalesce(channelId,0), logicalPath, versionId)
  view current_memory_documents

// backend/schema/memory_chunks.ts
memory_chunks: id serial pk, documentId, chunkIndex int, breadcrumb text, body text,
  searchText text, tsv tsvector generated always as (to_tsvector('english', searchText)) stored,
  embedding vector(1536) null, embeddingRevision text null, createdAt tstz
  index hnsw (embedding vector_cosine_ops); index gin (tsv)

// backend/schema/project_settings.ts gains memory_embedding_revision, channel/project half-lives
```

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| `memory:list` | `GET /memory` | member; channel scope needs `canReadBot` | yes | no |
| `memory:search` | `GET /memory/search` | same | yes | no |
| `memory:view` | `GET /memory/document` | same | yes | no |
| `memory:versions` | `GET /memory/document/versions` | same | yes | no |
| `memory:write` | `PUT /memory/document` | channel: `canWriteBot`; project: admin | yes | yes |
| `memory:forget` | `DELETE /memory/document` | same as write | yes | yes |
| `memory:pin` | `POST /memory/document/pin` | same as write | yes | yes |
| `memory:promote` | `POST /memory/document/promote` | `canWriteBot` + admin | yes | yes |
| `memory:reindex` | `POST /memory/reindex` | admin | yes | yes |
| `memory:embed` | — (task) | — | no | no |
| `memory:consolidate` | — (task) | — | no | no |
| `memory:decay` | — (clock, hourly) | — | no | no |

## Frontend and user docs

- `frontend/src/pages/memory/{MemoryExplorerPage,MemoryDocumentPage}.tsx`, linked from the bot page and the
  project nav.
- Decay is shown as a faded bar on each row, with its half-life on hover.
- User docs:
  - `frontend/src/content/docs/memory.md`: scopes per platform, what decays and when, promotion, and how to
    correct the bot.
  - `bots.md` gains the half-life settings.
- CLI: `hypotenuse memory search|list|view|write|forget|promote`.

## Steps

### 1. pgvector — `backend/drizzle/*`, `backend/__tests__/setup.ts`

`CREATE EXTENSION IF NOT EXISTS vector` in a migration. The test setup asserts the extension. CI's Postgres
image is `pgvector/pgvector:pg18`; `docs/DEPLOY.md` notes Render's support.

### 2. Schema — `backend/schema/{memory_documents,memory_chunks}.ts`

### 3. Ops — `backend/ops/{MemoryOps,MemoryChunkOps,MemorySearchOps,MemoryDecayOps,ConsolidationOps}.ts`

`scopeFor`, `write`, `edit`, `forget`, `chunk`, `fuseRRF`, `diversify`, `decayFactor`, `serializeMemoryDocument`.

### 4. Tools — `backend/tools/memory-{search,list,read,write,edit,forget}.ts`

### 5. Actions — `backend/actions/memory/*.ts`

### 6. Fixture — `backend/__tests__/fixtures/model-server.ts`

Adds `POST /v1/embeddings`: deterministic vectors (a seeded hash of token n-grams, normalized), so similar text
lands near similar text and tests can predict rankings.

### 7. Eval — `backend/__tests__/memory/eval/{corpus,golden}.json`, `backend/__tests__/memory/eval.test.ts`

A small corpus with golden queries. The test asserts Recall@5 and MRR above recorded floors, so a ranking change
that degrades results fails CI.

### 8. Frontend, CLI, docs — as above

## Test plan

- `__tests__/memory/scope.test.ts`:
  - A conversation in channel A cannot find, list, read, edit, or forget channel B's documents, by any tool or
    parameter.
  - Project documents are visible in both channels.
  - The query plan filters in SQL (an `EXPLAIN` snapshot).
- `__tests__/memory/versions.test.ts`:
  - Write, edit (base-version conflict refused), forget, and read an old version.
  - Every response carries `versionId`.
- `__tests__/memory/search.test.ts`:
  - Exact weighted RRF scores on a fixed corpus.
  - The 3-per-document cap with backfill.
  - Keyword-only ranking for unembedded chunks.
  - A centred snippet.
- `__tests__/memory/decay.test.ts`:
  - `decayFactor` at 0, one half-life, and ten half-lives.
  - A pinned document is exempt.
  - The clock tombstones a faded channel document, leaves project documents alone, and prunes only non-current
    old versions.
  
  Time is moved by writing columns.
- `__tests__/memory/consolidation.test.ts`:
  - The scripted model returns facts, which land in channel scope with provenance.
  - A superseding fact edits rather than duplicates.
  - A project-scope write from the bot is refused unless the binding allows it.
- `__tests__/memory/embedding-revision.test.ts`: changing the model marks chunks stale; `memory:reindex`
  re-embeds them.
- `__tests__/actions/memory.test.ts`: RBAC for every action (a member without the bot's read tag is refused for
  channel scope; a non-admin is refused for project writes); audit rows for every write.
- `__tests__/memory/eval.test.ts`: the floors.

## Verification

```bash
cd backend && bun test __tests__/memory __tests__/actions/memory.test.ts
bun run --cwd cli hypotenuse memory search --bot 1 --channel 3 "deploy process"
```

On staging, a fact told to a bot in one API channel is found in that channel and not in another. After
promotion, it is found in both.

## Definition of done

- [ ] pgvector is enabled in development, CI, and staging.
- [ ] Documents are versioned with tombstones and provenance; chunks hold `tsvector` and vector.
- [ ] Hybrid search with weighted RRF, the diversity cap, and decay passes the eval floors.
- [ ] Channel isolation is proven for every tool and action.
- [ ] `memory:decay`, `memory:embed`, `memory:reindex`, and `memory:consolidate` work, with time controlled by
      columns in tests.
- [ ] Promotion is a person's audited decision, or an audited binding setting.
- [ ] The six model tools are registered with replay flags and error hints.
- [ ] The explorer, CLI, and user docs ship; both themes are checked.

## Open questions

- Whether a cross-encoder rerank (membot's `ms-marco-MiniLM`) is worth running in the worker. Measure with the
  eval harness first.
- Whether two bots in one channel should be able to opt into shared channel memory. The proposal: a binding
  setting later, if asked for.
- Whether embeddings should come from a deployment-wide model instead of the project's. The proposal: the
  project's, so a tenant's text goes only to a provider the tenant chose.

## Learnings from the build

Not built yet.
