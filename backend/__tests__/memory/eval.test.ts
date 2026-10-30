import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import { searchMemory } from "../../ops/MemorySearchOps";
import { HOOK_TIMEOUT } from "../setup";
import corpus from "./eval/corpus.json";
import golden from "./eval/golden.json";
import {
  buildMemoryStage,
  type MemoryStage,
  runMemoryJobs,
  writeMemory,
} from "./harness";

/**
 * **The retrieval eval**, after membot's: a small corpus written to project
 * memory and embedded by the scripted model, golden queries with the
 * document each should find, and Recall@k and MRR over them. The floors are
 * the measured values when this was written, rounded down: a ranking change
 * that makes results worse fails here, and one that makes them better should
 * raise the floors in the same commit.
 *
 * Measured: hybrid Recall@1 0.94, Recall@5 1.00, MRR 0.972; keyword-only
 * Recall@1 1.00, Recall@5 1.00. The scripted embedding is a bag of hashed
 * words, so on this corpus it adds noise rather than meaning: the hybrid
 * floor guards the fusion, not the model.
 */
const FLOORS = {
  hybrid: { recallAt1: 0.9, recallAt5: 1.0, mrr: 0.95 },
  keyword: { recallAt5: 0.95 },
};

let stage: MemoryStage;

beforeAll(async () => {
  stage = await buildMemoryStage();
  for (const doc of corpus.documents) {
    const res = await writeMemory(stage, { scope: "project", ...doc });
    if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  }
  await runMemoryJobs();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * The 1-based rank of a path among a search's distinct documents.
 * @param query - The query.
 * @param path - The document it should find.
 * @returns The rank, or 0 when it is not in the top 10.
 */
async function rankOf(query: string, path: string): Promise<number> {
  const { hits } = await searchMemory(
    api.db.db,
    {
      projectId: stage.u.projectId,
      channel: null,
      halfLifeDays: { channel: 30, project: 180 },
    },
    query,
    { scope: "project", limit: 10 },
  );
  const paths = [...new Set(hits.map((h) => h.path))];
  return paths.indexOf(path) + 1;
}

/**
 * Recall@k and MRR over the golden queries.
 * @returns The metrics, and each query's rank.
 */
async function measure() {
  const ranks: { query: string; rank: number }[] = [];
  for (const q of golden.queries) {
    ranks.push({ query: q.query, rank: await rankOf(q.query, q.expect) });
  }
  const n = ranks.length;
  const within = (k: number) =>
    ranks.filter((r) => r.rank > 0 && r.rank <= k).length / n;
  return {
    recallAt1: within(1),
    recallAt5: within(5),
    mrr: ranks.reduce((a, r) => a + (r.rank > 0 ? 1 / r.rank : 0), 0) / n,
    ranks,
  };
}

describe("retrieval quality", () => {
  test("hybrid search stays above its floors", async () => {
    const m = await measure();
    console.info(
      `hybrid: Recall@1 ${m.recallAt1.toFixed(2)}, Recall@5 ${m.recallAt5.toFixed(2)}, MRR ${m.mrr.toFixed(3)}`,
    );
    expect(m.recallAt1, JSON.stringify(m.ranks)).toBeGreaterThanOrEqual(
      FLOORS.hybrid.recallAt1,
    );
    expect(m.recallAt5).toBeGreaterThanOrEqual(FLOORS.hybrid.recallAt5);
    expect(m.mrr).toBeGreaterThanOrEqual(FLOORS.hybrid.mrr);
  });

  // Each query's embedding fails and is retried once, with the SDK's back-off.
  test("keyword-only search stays above its floor", async () => {
    stage.models.failEmbeddings(1000);
    const m = await measure();
    stage.models.failEmbeddings(0);
    console.info(
      `keyword: Recall@1 ${m.recallAt1.toFixed(2)}, Recall@5 ${m.recallAt5.toFixed(2)}, MRR ${m.mrr.toFixed(3)}`,
    );
    expect(m.recallAt5, JSON.stringify(m.ranks)).toBeGreaterThanOrEqual(
      FLOORS.keyword.recallAt5,
    );
  }, 120_000);
});
