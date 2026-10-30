import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { api } from "keryx";
import {
  type Candidate,
  diversify,
  fuseRRF,
  makeSnippet,
} from "../../ops/MemorySearchOps";
import { clearLoopQueues } from "../agent/harness";
import { HOOK_TIMEOUT } from "../setup";
import {
  buildMemoryStage,
  clearMemory,
  getMemory,
  type MemoryStage,
  runMemoryJobs,
  writeMemory,
} from "./harness";

/**
 * Hybrid search: exact weighted reciprocal-rank fusion, the per-document cap
 * with backfill, keyword-only ranking for chunks without a vector, and
 * snippets centred on the match.
 */
let stage: MemoryStage;

beforeAll(async () => {
  stage = await buildMemoryStage();
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  await clearMemory();
  stage.models.reset();
});

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * A candidate for the pure functions.
 * @param chunkId - Its chunk id.
 * @param documentId - Its document.
 * @returns The candidate.
 */
function candidate(chunkId: number, documentId = chunkId): Candidate {
  return {
    chunkId,
    chunkIndex: 0,
    body: "",
    score: 0,
    document: {
      id: documentId,
      scope: "project",
      logicalPath: `doc-${documentId}.md`,
      versionId: new Date(0),
      description: "",
      pinned: false,
      createdAt: new Date(0),
      lastAccessedAt: null,
    },
  };
}

describe("fusion", () => {
  test("exact weighted RRF scores, normalized so first on both is 1", () => {
    const [a, b, c] = [candidate(1), candidate(2), candidate(3)];
    const fused = fuseRRF([a, b], [b, c], { k: 60, semanticWeight: 0.6 });
    expect(fused.map((h) => h.candidate.chunkId)).toEqual([2, 1, 3]);
    // b: 0.6/62 + 0.4/61; a: 0.6/61; c: 0.4/62 — each over 1/61.
    expect(fused[0].normal).toBeCloseTo((0.6 / 62 + 0.4 / 61) * 61, 12);
    expect(fused[1].normal).toBeCloseTo(0.6, 12);
    expect(fused[2].normal).toBeCloseTo((0.4 / 62) * 61, 12);
    expect(fused[0]).toMatchObject({ semanticRank: 2, keywordRank: 1 });
    expect(
      fuseRRF([a], [a], { k: 60, semanticWeight: 0.6 })[0].normal,
    ).toBeCloseTo(1, 12);
  });

  test("at most three chunks per document, backfilled when nothing else is left", () => {
    const hits = [1, 1, 1, 1, 1, 2].map((documentId, i) => ({
      documentId,
      i,
    }));
    // Three of document 1, then document 2, then one more of 1 to fill.
    expect(diversify(hits, 3, 5).map((h) => h.i)).toEqual([0, 1, 2, 5, 3]);
    expect(diversify(hits, 3, 4).map((h) => h.i)).toEqual([0, 1, 2, 5]);
    expect(diversify(hits, 0, 3).map((h) => h.i)).toEqual([0, 1, 2]);
    // A short list still lets the other document ahead of the overflow.
    expect(diversify(hits, 3, 6).map((h) => h.i)).toEqual([0, 1, 2, 5, 3, 4]);
  });

  test("a snippet is centred on the first matched term", () => {
    const body = `${"Filler words about nothing in particular. ".repeat(15)}The drawbridge lowers at noon. ${"More filler. ".repeat(30)}`;
    const snippet = makeSnippet(body, ["drawbridge"]);
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(302);
    const at = snippet.indexOf("drawbridge");
    expect(at).toBeGreaterThan(80);
    expect(at).toBeLessThanOrEqual(101);
    expect(makeSnippet("short body", ["absent"])).toBe("short body");
  });
});

type SearchBody = {
  hits: {
    path: string;
    relevance: number;
    score: number;
    decay: number;
    semanticRank: number | null;
    keywordRank: number | null;
    snippet: string;
  }[];
  mode: string;
  keywordOnlyReason: string | null;
};

/**
 * Search project memory over HTTP.
 * @param query - The query.
 * @param limit - How many hits.
 * @returns The body.
 */
async function search(query: string, limit = 10): Promise<SearchBody> {
  const res = await getMemory<SearchBody>(stage, "memory/search", {
    query,
    scope: "project",
    limit,
  });
  expect(res.status).toBe(200);
  return res.body;
}

describe("search over a fixed corpus", () => {
  const corpus = [
    {
      path: "runbooks/deploy.md",
      content:
        "# Deploying\nRun the deploy pipeline from the main branch, then watch the canary for ten minutes.",
    },
    {
      path: "people/peach.md",
      content:
        "# Peach\nPeach rules the Mushroom Kingdom and approves releases.",
    },
    {
      path: "facts/kitchen.md",
      content: "# Kitchen\nThe kitchen bakes cake every Sunday.",
    },
  ];

  /** Write the corpus as Peach, into project memory. */
  async function seed(): Promise<void> {
    for (const doc of corpus) {
      const res = await writeMemory(stage, { scope: "project", ...doc });
      expect(res.status).toBe(200);
    }
  }

  test("a document first on both sides scores exactly 1, and the rest rank below", async () => {
    await seed();
    await runMemoryJobs();
    const body = await search("deploy pipeline canary");
    expect(body.mode).toBe("hybrid");
    expect(body.hits[0]).toMatchObject({
      path: "runbooks/deploy.md",
      semanticRank: 1,
      keywordRank: 1,
      relevance: 1,
      decay: 1,
      score: 1,
    });
    for (const hit of body.hits.slice(1)) {
      expect(hit.relevance).toBeLessThan(1);
    }
  });

  test("chunks not embedded yet are ranked by keyword alone", async () => {
    await seed();
    // No embed run: every chunk's vector is still null.
    const body = await search("kitchen cake");
    expect(body.mode).toBe("hybrid");
    expect(body.hits).toHaveLength(1);
    expect(body.hits[0]).toMatchObject({
      path: "facts/kitchen.md",
      semanticRank: null,
      keywordRank: 1,
    });
    // First on the keyword side only: the keyword weight, 0.4.
    expect(body.hits[0].relevance).toBeCloseTo(0.4, 4);
  });

  test("a query the embedding model cannot embed is searched by keyword, saying so", async () => {
    await seed();
    await runMemoryJobs();
    stage.models.failEmbeddings(5);
    const body = await search("Mushroom Kingdom releases");
    expect(body.mode).toBe("keyword");
    expect(body.keywordOnlyReason).toContain("keywords only");
    expect(body.hits[0]).toMatchObject({
      path: "people/peach.md",
      semanticRank: null,
      keywordRank: 1,
    });
  });

  test("one large document takes at most three of the hits while others match", async () => {
    const section = (n: number) =>
      `## Step ${n}\nThe castle guard checks the castle gate. ${"Patrol the walls and report to the captain. ".repeat(30)}`;
    const big = Array.from({ length: 6 }, (_, i) => section(i + 1)).join("\n");
    await writeMemory(stage, {
      scope: "project",
      path: "runbooks/guard.md",
      content: `# Guard duty\n${big}`,
    });
    await writeMemory(stage, {
      scope: "project",
      path: "facts/gate.md",
      content: "The castle gate is oak.",
    });
    await runMemoryJobs();
    const body = await search("castle gate", 4);
    const fromBig = body.hits.filter((h) => h.path === "runbooks/guard.md");
    expect(fromBig).toHaveLength(3);
    expect(body.hits.map((h) => h.path)).toContain("facts/gate.md");
    // With nothing else to show, the cap backfills.
    const more = await search("castle gate", 6);
    expect(more.hits).toHaveLength(6);
  });

  test("a snippet from search shows the match", async () => {
    const long = `# Notes\n${"Nothing to see here at all, keep moving along please. ".repeat(10)}The secret passage is behind the throne.`;
    await writeMemory(stage, {
      scope: "project",
      path: "facts/passage.md",
      content: long,
    });
    const body = await search("secret passage");
    expect(body.hits[0].snippet.startsWith("…")).toBe(true);
    expect(body.hits[0].snippet).toContain("secret passage");
  });
});
