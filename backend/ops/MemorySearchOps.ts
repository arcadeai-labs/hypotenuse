import { embed } from "ai";
import { and, eq, isNotNull, like, sql } from "drizzle-orm";
import { api, config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/memory";
import {
  MEMORY_EMBEDDING_DIMENSIONS,
  memoryChunks,
} from "../schema/memory_chunks";
import {
  type MemoryDocument,
  type MemoryScopeName,
  memoryDocuments,
} from "../schema/memory_documents";
import type { DbHandle } from "./DbOps";
import {
  decayFactor,
  escapeLike,
  halfLifeFor,
  type MemoryReadSet,
  type ScopeChoice,
  scopeCondition,
} from "./MemoryOps";
import { embeddingModel } from "./ModelOps";

/**
 * **Hybrid search** over a read set, as membot ranks: the top chunks by
 * pgvector cosine distance and the top chunks by Postgres full-text rank,
 * fused by weighted reciprocal rank, normalized so 1.0 means first on both
 * lists — and then, new here, weighed by how much each memory has faded.
 *
 * ```
 * fused  = Σ w_side / (k + rank_side)      k = 60, w_sem = 0.6, w_kw = 0.4
 * normal = fused / (1 / (k + 1))
 * score  = normal · (floor + (1 − floor) · decay)     floor = 0.25
 * ```
 *
 * Both candidate sets are restricted to the read set in their `WHERE`, never
 * filtered afterwards. A chunk without a vector (not embedded yet, or stale)
 * is ranked by keyword alone; a project without an embedding model, or a
 * query whose embedding fails, is searched by keyword alone.
 */

/** One candidate from either side, with its document. */
export interface Candidate {
  chunkId: number;
  chunkIndex: number;
  body: string;
  /** The side's own score: cosine similarity, or `ts_rank_cd`. */
  score: number;
  document: Pick<
    MemoryDocument,
    | "id"
    | "scope"
    | "logicalPath"
    | "versionId"
    | "description"
    | "pinned"
    | "createdAt"
    | "lastAccessedAt"
  >;
}

/** One fused hit. */
export interface FusedHit {
  candidate: Candidate;
  /** The fused score over its maximum, in [0, 1]. */
  normal: number;
  semanticRank: number | null;
  keywordRank: number | null;
}

/**
 * **Weighted reciprocal-rank fusion.** A chunk on both lists adds both
 * contributions; the result is normalized by the largest possible fused
 * score, `1 / (k + 1)`, since the weights sum to one.
 * @param semantic - Candidates by cosine similarity, best first.
 * @param keyword - Candidates by text rank, best first.
 * @param options.k - The RRF constant.
 * @param options.semanticWeight - The semantic side's weight.
 * @returns Every candidate once, best first.
 */
export function fuseRRF(
  semantic: Candidate[],
  keyword: Candidate[],
  options: { k: number; semanticWeight: number },
): FusedHit[] {
  const { k, semanticWeight } = options;
  const keywordWeight = 1 - semanticWeight;
  const merged = new Map<number, FusedHit & { rrf: number }>();
  const add = (
    list: Candidate[],
    weight: number,
    side: "semanticRank" | "keywordRank",
  ) => {
    list.forEach((candidate, i) => {
      const rrf = weight / (k + i + 1);
      const existing = merged.get(candidate.chunkId);
      if (existing) {
        existing.rrf += rrf;
        existing[side] = i + 1;
      } else {
        merged.set(candidate.chunkId, {
          candidate,
          rrf,
          normal: 0,
          semanticRank: side === "semanticRank" ? i + 1 : null,
          keywordRank: side === "keywordRank" ? i + 1 : null,
        });
      }
    });
  };
  add(semantic, semanticWeight, "semanticRank");
  add(keyword, keywordWeight, "keywordRank");
  const max = 1 / (k + 1);
  return [...merged.values()]
    .sort((a, b) => b.rrf - a.rrf || a.candidate.chunkId - b.candidate.chunkId)
    .map(({ rrf, ...hit }) => ({ ...hit, normal: rrf / max }));
}

/**
 * Keep at most `maxPerDocument` hits of each document, then backfill from
 * the overflow in score order, so a search still returns `limit` hits when
 * one document holds most of the matches.
 * @param hits - Hits, best first.
 * @param maxPerDocument - The cap; 0 disables it.
 * @param limit - How many to return.
 * @returns The hits.
 */
export function diversify<T extends { documentId: number }>(
  hits: T[],
  maxPerDocument: number,
  limit: number,
): T[] {
  if (maxPerDocument <= 0) return hits.slice(0, limit);
  const kept: T[] = [];
  const overflow: T[] = [];
  const per = new Map<number, number>();
  for (const hit of hits) {
    const n = per.get(hit.documentId) ?? 0;
    if (n < maxPerDocument && kept.length < limit) {
      per.set(hit.documentId, n + 1);
      kept.push(hit);
    } else {
      overflow.push(hit);
    }
  }
  for (const hit of overflow) {
    if (kept.length >= limit) break;
    kept.push(hit);
  }
  return kept;
}

/** How long a snippet may be. */
const SNIPPET_MAX = 300;

/** Context kept before the first matched term. */
const SNIPPET_LEAD = 100;

const STOPWORDS = new Set(
  "the and for that with this from what when where which who how does why are was were can could should would will into about than then them they their your you our its has have had not but all any".split(
    " ",
  ),
);

/**
 * A query's words worth centring a snippet on: lowercase, three letters or
 * more, minus stopwords, at most ten.
 * @param query - The query.
 * @returns The terms.
 */
export function queryTerms(query: string): string[] {
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
  return [...new Set(tokens)].slice(0, 10);
}

/**
 * A snippet of at most 300 characters, centred on the earliest matched term
 * (with 100 characters before it), ellipses marking a cut.
 * @param body - The chunk's text.
 * @param terms - The query's terms.
 * @returns The snippet.
 */
export function makeSnippet(body: string, terms: string[]): string {
  let start = 0;
  const lower = body.toLowerCase();
  let earliest = -1;
  for (const term of terms) {
    const idx = lower.indexOf(term);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) earliest = idx;
  }
  if (earliest > SNIPPET_LEAD) {
    start = earliest - SNIPPET_LEAD;
    const space = body.indexOf(" ", start);
    if (space !== -1 && space < earliest) start = space + 1;
  }
  const end = Math.min(body.length, start + SNIPPET_MAX);
  return `${start > 0 ? "…" : ""}${body.slice(start, end)}${end < body.length ? "…" : ""}`;
}

/** One search result. */
export interface SearchHit {
  documentId: number;
  path: string;
  scope: MemoryScopeName;
  versionId: number;
  description: string;
  chunkIndex: number;
  snippet: string;
  /** The final score: rank fusion, normalized, weighed by decay. */
  score: number;
  /** The fused score before decay, in [0, 1]. */
  relevance: number;
  /** How much of the memory's weight is left, in (0, 1]. */
  decay: number;
  pinned: boolean;
  semanticRank: number | null;
  keywordRank: number | null;
}

/** What a search did, besides its hits. */
export interface SearchResult {
  hits: SearchHit[];
  /** `hybrid`, or `keyword` when there was no vector side. */
  mode: "hybrid" | "keyword";
  /** Why the vector side was skipped, when it was. */
  keywordOnlyReason: string | null;
}

/** The columns both candidate queries read. */
const candidateColumns = {
  chunkId: memoryChunks.id,
  chunkIndex: memoryChunks.chunkIndex,
  body: memoryChunks.body,
  documentId: memoryDocuments.id,
  scope: memoryDocuments.scope,
  logicalPath: memoryDocuments.logicalPath,
  versionId: memoryDocuments.versionId,
  description: memoryDocuments.description,
  pinned: memoryDocuments.pinned,
  createdAt: memoryDocuments.createdAt,
  lastAccessedAt: memoryDocuments.lastAccessedAt,
};

/**
 * A row of either candidate query, as a {@link Candidate}.
 * @param row - The row.
 * @returns The candidate.
 */
function toCandidate(
  row: Record<keyof typeof candidateColumns, unknown> & { score: unknown },
): Candidate {
  return {
    chunkId: row.chunkId as number,
    chunkIndex: row.chunkIndex as number,
    body: row.body as string,
    score: Number(row.score),
    document: {
      id: row.documentId as number,
      scope: row.scope as MemoryScopeName,
      logicalPath: row.logicalPath as string,
      versionId: row.versionId as Date,
      description: row.description as string,
      pinned: row.pinned as boolean,
      createdAt: row.createdAt as Date,
      lastAccessedAt: row.lastAccessedAt as Date | null,
    },
  };
}

/**
 * The condition every candidate shares: a live current version in the read
 * set, under the path prefix.
 * @param readSet - The read set.
 * @param choice - Which scopes.
 * @param pathPrefix - The prefix, if any.
 * @returns The condition.
 */
function liveIn(
  readSet: MemoryReadSet,
  choice: ScopeChoice,
  pathPrefix?: string,
) {
  return and(
    scopeCondition(readSet, choice),
    eq(memoryDocuments.isCurrent, true),
    eq(memoryDocuments.tombstone, false),
    pathPrefix
      ? like(memoryDocuments.logicalPath, `${escapeLike(pathPrefix)}%`)
      : undefined,
  );
}

/**
 * The keyword side: chunks matching any of the query's words, by `ts_rank_cd`.
 * @param db - A database handle.
 * @param readSet - The read set.
 * @param choice - Which scopes.
 * @param query - The query.
 * @param pathPrefix - The prefix, if any.
 * @returns Up to `candidates` chunks, best first.
 */
export async function keywordCandidates(
  db: DbHandle,
  readSet: MemoryReadSet,
  choice: ScopeChoice,
  query: string,
  pathPrefix?: string,
): Promise<Candidate[]> {
  // Any of the query's words, as membot's BM25 matches: an AND of every
  // word (websearch_to_tsquery) misses most questions people actually ask.
  // `ts_rank_cd` then ranks chunks that cover more of them, closer together,
  // higher. A query of only stopwords is null and matches nothing.
  const tsquery = sql`nullif(replace(plainto_tsquery('english', ${query})::text, '&', '|'), '')::tsquery`;
  const score = sql<number>`ts_rank_cd(${memoryChunks.tsv}, ${tsquery})`;
  const rows = await db
    .select({ ...candidateColumns, score })
    .from(memoryChunks)
    .innerJoin(memoryDocuments, eq(memoryDocuments.id, memoryChunks.documentId))
    .where(
      and(
        liveIn(readSet, choice, pathPrefix),
        sql`${memoryChunks.tsv} @@ ${tsquery}`,
      ),
    )
    .orderBy(sql`${score} desc`, memoryChunks.id)
    .limit(config.memory.candidates);
  return rows.map(toCandidate);
}

/**
 * The semantic side: chunks embedded under `revision`, nearest first.
 * @param db - A database handle.
 * @param readSet - The read set.
 * @param choice - Which scopes.
 * @param vector - The query's embedding.
 * @param revision - The project's current embedding revision.
 * @param pathPrefix - The prefix, if any.
 * @returns Up to `candidates` chunks, nearest first.
 */
export async function semanticCandidates(
  db: DbHandle,
  readSet: MemoryReadSet,
  choice: ScopeChoice,
  vector: number[],
  revision: string,
  pathPrefix?: string,
): Promise<Candidate[]> {
  const literal = `[${vector.join(",")}]`;
  const distance = sql<number>`${memoryChunks.embedding} <=> ${literal}::vector`;
  const rows = await db
    .select({ ...candidateColumns, score: sql<number>`1 - (${distance})` })
    .from(memoryChunks)
    .innerJoin(memoryDocuments, eq(memoryDocuments.id, memoryChunks.documentId))
    .where(
      and(
        liveIn(readSet, choice, pathPrefix),
        isNotNull(memoryChunks.embedding),
        eq(memoryChunks.embeddingRevision, revision),
      ),
    )
    .orderBy(distance, memoryChunks.id)
    .limit(config.memory.candidates);
  return rows.map(toCandidate);
}

/**
 * Embed a query with the project's embedding model.
 * @param projectId - The project.
 * @param query - The query.
 * @param signal - Aborts the call.
 * @returns The vector and revision, or why there is none.
 */
async function embedQuery(
  projectId: number,
  query: string,
  signal?: AbortSignal,
): Promise<
  { vector: number[]; revision: string } | { vector: null; reason: string }
> {
  const model = await embeddingModel(projectId);
  if (!model) {
    return {
      vector: null,
      reason:
        'The project has no embedding model, so memory is searched by keyword. A project admin adds one named "embedding" under Settings → Models.',
    };
  }
  try {
    const { embedding } = await embed({
      model: model.model,
      value: query,
      dimensions: MEMORY_EMBEDDING_DIMENSIONS,
      maxRetries: 1,
      abortSignal: signal,
    });
    return { vector: embedding, revision: model.revision };
  } catch (error) {
    if (signal?.aborted) throw error;
    api.logger.warn("memory search could not embed its query", {
      projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      vector: null,
      reason:
        "The embedding model could not be reached, so this search used keywords only.",
    };
  }
}

/**
 * **Search a read set.**
 * @param db - A database handle.
 * @param readSet - What may be searched.
 * @param query - The query.
 * @param options.scope - `channel`, `project`, or `both`.
 * @param options.pathPrefix - Only paths starting with this.
 * @param options.limit - How many hits.
 * @param options.signal - Aborts the query embedding.
 * @param options.now - The time decay is measured at (epoch ms).
 * @returns The hits, best first, and how they were found.
 */
export async function searchMemory(
  db: DbHandle,
  readSet: MemoryReadSet,
  query: string,
  options: {
    scope: ScopeChoice;
    pathPrefix?: string;
    limit: number;
    signal?: AbortSignal;
    now?: number;
  },
): Promise<SearchResult> {
  const embedded = await embedQuery(readSet.projectId, query, options.signal);
  const [semantic, keyword] = await Promise.all([
    embedded.vector
      ? semanticCandidates(
          db,
          readSet,
          options.scope,
          embedded.vector,
          embedded.revision,
          options.pathPrefix,
        )
      : Promise.resolve([]),
    keywordCandidates(db, readSet, options.scope, query, options.pathPrefix),
  ]);
  const fused = fuseRRF(semantic, keyword, {
    k: config.memory.rrfK,
    semanticWeight: config.memory.semanticWeight,
  });
  const terms = queryTerms(query);
  const floor = config.memory.decayFloor;
  const now = options.now ?? Date.now();
  const scored: SearchHit[] = fused.map((hit) => {
    const d = hit.candidate.document;
    const decay = decayFactor(d, halfLifeFor(readSet, d), now);
    return {
      documentId: d.id,
      path: d.logicalPath,
      scope: d.scope,
      versionId: d.versionId.getTime(),
      description: d.description,
      chunkIndex: hit.candidate.chunkIndex,
      snippet: makeSnippet(hit.candidate.body, terms),
      score: round(hit.normal * (floor + (1 - floor) * decay)),
      relevance: round(hit.normal),
      decay: round(decay),
      pinned: d.pinned,
      semanticRank: hit.semanticRank,
      keywordRank: hit.keywordRank,
    };
  });
  scored.sort((a, b) => b.score - a.score || a.documentId - b.documentId);
  return {
    hits: diversify(scored, config.memory.maxChunksPerDocument, options.limit),
    mode: embedded.vector ? "hybrid" : "keyword",
    keywordOnlyReason: embedded.vector ? null : embedded.reason,
  };
}

/**
 * Round to four places, as scores are reported.
 * @param n - The number.
 * @returns It, rounded.
 */
function round(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
