import { loadFromEnvIfSet } from "keryx";

/**
 * Memory: how search ranks, how fast the clocks sweep, and how much history
 * is kept. Read at use, so a suite may change one for a test and put it back.
 */
export const configMemory = {
  /** How many chunks each side of hybrid search contributes before fusion. */
  candidates: await loadFromEnvIfSet("MEMORY_SEARCH_CANDIDATES", 50),
  /** The reciprocal-rank-fusion constant. */
  rrfK: await loadFromEnvIfSet("MEMORY_RRF_K", 60),
  /** The semantic side's share of the fused score; keyword gets the rest. */
  semanticWeight: await loadFromEnvIfSet("MEMORY_SEMANTIC_WEIGHT", 0.6),
  /** The most chunks of one document a search returns before backfilling. */
  maxChunksPerDocument: await loadFromEnvIfSet("MEMORY_MAX_PER_DOCUMENT", 3),
  /** The weight a fully faded memory keeps, so an exact old match stays findable. */
  decayFloor: await loadFromEnvIfSet("MEMORY_DECAY_FLOOR", 0.25),
  /** Below this decay factor an unpinned, rarely read channel memory is tombstoned. */
  fadeThreshold: await loadFromEnvIfSet("MEMORY_FADE_THRESHOLD", 0.05),
  /** A channel memory read at least this often never fades away. */
  fadeMinAccessCount: await loadFromEnvIfSet("MEMORY_FADE_MIN_ACCESS", 3),
  /** Non-current versions older than this are deleted by the decay clock. */
  versionRetentionDays: await loadFromEnvIfSet(
    "MEMORY_VERSION_RETENTION_DAYS",
    90,
  ),
  /** How often `memory:decay` runs. */
  decayFrequencyMs: await loadFromEnvIfSet(
    "MEMORY_DECAY_FREQUENCY_MS",
    60 * 60 * 1000,
  ),
  /** How often `memory:consolidate-due` looks for conversations owed one. */
  consolidateDueFrequencyMs: await loadFromEnvIfSet(
    "MEMORY_CONSOLIDATE_DUE_FREQUENCY_MS",
    5 * 60 * 1000,
  ),
  /** New transcript entries a resting conversation needs before it is consolidated. */
  consolidateMinEntries: await loadFromEnvIfSet(
    "MEMORY_CONSOLIDATE_MIN_ENTRIES",
    4,
  ),
  /** How many chunks one `memory:embed` run embeds before re-enqueueing itself. */
  embedBatchSize: await loadFromEnvIfSet("MEMORY_EMBED_BATCH", 64),
  /** The most a document may hold, in characters. */
  maxDocumentChars: await loadFromEnvIfSet(
    "MEMORY_MAX_DOCUMENT_CHARS",
    100_000,
  ),
};

declare module "keryx" {
  interface KeryxConfig {
    memory: typeof configMemory;
  }
}
