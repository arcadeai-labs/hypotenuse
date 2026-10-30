import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { api, config } from "keryx";
import { clearLoopQueues, MODEL_KEY } from "../agent/harness";
import { FIXED_DIMENSION_MODEL } from "../fixtures/model-server";
import { call, HOOK_TIMEOUT } from "../setup";
import {
  buildMemoryStage,
  clearMemory,
  forgetEmbedMarks,
  getMemory,
  type MemoryStage,
  runMemoryJobs,
  writeMemory,
} from "./harness";

/**
 * The embedding model: what an `embedding` alias must be, how a change of
 * model makes every stored vector stale, and how `memory:reindex` and the
 * embed queue bring them back.
 */
let stage: MemoryStage;
let defaults: typeof config.memory;

beforeAll(async () => {
  stage = await buildMemoryStage({ embedding: false });
  defaults = { ...config.memory };
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  await clearMemory();
  Object.assign(config.memory, defaults);
  stage.models.reset();
});

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Create an alias over HTTP.
 * @param body - The `model-alias:create` inputs.
 * @returns The status and body.
 */
function createAlias(body: Record<string, unknown>) {
  return call<{ modelAlias: { id: number } }>(
    stage.u.url,
    stage.u.peach,
    "PUT",
    `/project/${stage.u.projectId}/model-alias`,
    body,
  );
}

type ListBody = {
  index: { embeddingModel: string | null; staleChunks: number };
};

/** @returns The project memory index's state. */
async function indexState(): Promise<ListBody["index"]> {
  const res = await getMemory<ListBody>(stage, "memory", { scope: "project" });
  expect(res.status).toBe(200);
  return res.body.index;
}

describe("the embedding alias", () => {
  test("only the alias named embedding is of kind embedding, and it is probed", async () => {
    const wrongName = await createAlias({
      name: "vectors",
      kind: "embedding",
      connectionId: stage.embeddingConnectionId,
      modelId: "scripted-embed",
    });
    expect(wrongName.status).toBe(406);
    expect(wrongName.body.error?.key).toBe("name");

    const wrongKind = await createAlias({
      name: "embedding",
      connectionId: stage.embeddingConnectionId,
      modelId: "scripted-embed",
    });
    expect(wrongKind.status).toBe(406);
    expect(wrongKind.body.error?.key).toBe("kind");

    const anthropic = await createAlias({
      name: "embedding",
      kind: "embedding",
      connectionId: stage.connectionId,
      modelId: "scripted-embed",
    });
    expect(anthropic.status).toBe(406);
    expect(anthropic.body.error?.message).toContain(
      "does not serve embedding models",
    );

    const fixed = await createAlias({
      name: "embedding",
      kind: "embedding",
      connectionId: stage.embeddingConnectionId,
      modelId: FIXED_DIMENSION_MODEL,
    });
    expect(fixed.status).toBe(406);
    expect(fixed.body.error?.message).toContain("768-dimensional");

    const ok = await createAlias({
      name: "embedding",
      kind: "embedding",
      connectionId: stage.embeddingConnectionId,
      modelId: "scripted-embed",
    });
    expect(ok.status).toBe(200);

    // A bot thinks with a language model, never the embedding one.
    const bot = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { fastModelAlias: "embedding" },
    );
    expect(bot.status).toBe(406);
    expect(bot.body.error?.key).toBe("fastModelAlias");

    await call(
      stage.u.url,
      stage.u.peach,
      "DELETE",
      `/project/${stage.u.projectId}/model-alias/${ok.body.modelAlias.id}`,
    );
  });
});

describe("staleness and reindexing", () => {
  test("a new embedding model embeds what was written before it; repointing it makes every chunk stale until reindexed", async () => {
    for (const [path, content] of [
      ["facts/bridge.md", "The bridge closes at night."],
      ["facts/tower.md", "The tower bell rings at noon."],
    ]) {
      await writeMemory(stage, { scope: "project", path, content });
    }
    // No model: the write's embed run finds nothing to do, and search says why.
    await runMemoryJobs();
    expect(await indexState()).toEqual({
      embeddingModel: null,
      staleChunks: 2,
    });
    const keywordOnly = await getMemory<{
      mode: string;
      keywordOnlyReason: string;
    }>(stage, "memory/search", { query: "bridge", scope: "project" });
    expect(keywordOnly.body.mode).toBe("keyword");
    expect(keywordOnly.body.keywordOnlyReason).toContain("no embedding model");

    // Creating the alias embeds the backlog.
    const alias = await createAlias({
      name: "embedding",
      kind: "embedding",
      connectionId: stage.embeddingConnectionId,
      modelId: "scripted-embed",
    });
    expect(alias.status).toBe(200);
    expect(await runMemoryJobs()).toEqual(["memory:embed"]);
    expect(await indexState()).toEqual({
      embeddingModel: "scripted-embed",
      staleChunks: 0,
    });

    // Repoint the alias at another connection: a new revision, so every
    // stored vector is stale and search ranks by keyword until re-embedded.
    const other = await call<{ modelConnection: { id: number } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/model-connection`,
      {
        name: "Scripted embeddings two",
        provider: "openai-compatible",
        baseUrl: stage.models.baseUrl("openai-compatible"),
        apiKey: MODEL_KEY,
      },
    );
    const edited = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/model-alias/${alias.body.modelAlias.id}`,
      { connectionId: other.body.modelConnection.id },
    );
    expect(edited.status).toBe(200);
    // Lose the edit's own re-embed, job and mark, to prove reindex.
    await clearLoopQueues();
    await forgetEmbedMarks();
    expect((await indexState()).staleChunks).toBe(2);
    const stale = await getMemory<{
      hits: { semanticRank: number | null; keywordRank: number | null }[];
    }>(stage, "memory/search", { query: "bridge closes", scope: "project" });
    expect(stale.body.hits[0]).toMatchObject({
      semanticRank: null,
      keywordRank: 1,
    });

    // memory:reindex is an admin's audited decision.
    const denied = await call(
      stage.u.url,
      stage.u.toad,
      "POST",
      `/project/${stage.u.projectId}/memory/reindex`,
      {},
    );
    expect(denied.status).toBe(403);
    const reindex = await call<{ queuedChunks: number }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/memory/reindex`,
      {},
    );
    expect(reindex.status).toBe(200);
    expect(reindex.body.queuedChunks).toBe(2);
    // Two batches of one: the run re-enqueues itself while work remains.
    config.memory.embedBatchSize = 1;
    expect(await runMemoryJobs()).toEqual(["memory:embed", "memory:embed"]);
    expect((await indexState()).staleChunks).toBe(0);
    const fresh = await getMemory<{ hits: { semanticRank: number | null }[] }>(
      stage,
      "memory/search",
      { query: "bridge closes", scope: "project" },
    );
    expect(fresh.body.hits[0].semanticRank).toBe(1);
  });
});
