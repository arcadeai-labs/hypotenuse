import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { api } from "keryx";
import { scopeCondition } from "../../ops/MemoryOps";
import { memoryDocuments } from "../../schema/memory_documents";
import { clearLoopQueues } from "../agent/harness";
import { HOOK_TIMEOUT } from "../setup";
import {
  botCalls,
  botCallsIn,
  buildMemoryStage,
  channelOf,
  clearMemory,
  getMemory,
  type MemoryStage,
  runMemoryJobs,
  toolOutputs,
  writeMemory,
} from "./harness";

/**
 * The memory boundary: a conversation reads and changes only its own
 * channel's memory and its project's, by every tool and every parameter,
 * and the boundary is in the SQL.
 */
let stage: MemoryStage;

beforeAll(async () => {
  stage = await buildMemoryStage();
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  await clearMemory();
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
});

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

const SECRET = {
  path: "facts/launch-code.md",
  scope: "channel",
  content: "The launch code for the castle cannon is mushroom-42.",
  changeNote: "Peach told me in the war room.",
};

/**
 * Write the secret in channel A and embed it.
 * @returns Channel A's conversation and channel ids.
 */
async function secretInA() {
  const conversationId = await botCalls(stage, "war-room", [
    [{ name: "memory_write", input: SECRET }],
  ]);
  await runMemoryJobs();
  const [written] = await toolOutputs(stage, conversationId, "memory_write");
  expect(written).toMatchObject({ path: SECRET.path, scope: "channel" });
  return { conversationId, channelId: await channelOf(conversationId) };
}

describe("channel isolation", () => {
  test("channel B cannot search, list, read, edit, or forget channel A's memory", async () => {
    const a = await secretInA();
    const [{ versionId }] = await toolOutputs(
      stage,
      a.conversationId,
      "memory_write",
    );
    const b = await botCalls(stage, "kitchen", [
      [
        { name: "memory_search", input: { query: "launch code cannon" } },
        // A channel id the model makes up is not an input: it is dropped.
        {
          name: "memory_search",
          input: { query: "launch code", channelId: a.channelId },
        },
        { name: "memory_list", input: {} },
        { name: "memory_read", input: { path: SECRET.path, scope: "channel" } },
      ],
      [
        {
          name: "memory_edit",
          input: {
            path: SECRET.path,
            scope: "channel",
            baseVersionId: versionId,
            changeNote: "x",
            patches: [{ start_line: 1, end_line: 1, content: "leaked" }],
          },
        },
        {
          name: "memory_forget",
          input: { path: SECRET.path, scope: "channel", reason: "x" },
        },
      ],
    ]);
    const searches = await toolOutputs(stage, b, "memory_search");
    expect(searches.map((s) => s.hits)).toEqual([[], []]);
    expect((await toolOutputs(stage, b, "memory_list"))[0]).toMatchObject({
      documents: [],
      total: 0,
    });
    for (const tool of ["memory_read", "memory_edit", "memory_forget"]) {
      expect((await toolOutputs(stage, b, tool))[0], tool).toMatchObject({
        is_error: true,
        error_type: "not_found",
      });
    }

    // And channel A still finds its own memory, unchanged.
    await botCallsIn(stage, a.conversationId, [
      [{ name: "memory_search", input: { query: "launch code cannon" } }],
      [{ name: "memory_read", input: { path: SECRET.path, scope: "channel" } }],
    ]);
    const [, search] = await toolOutputs(
      stage,
      a.conversationId,
      "memory_search",
    ).then((all) => [all.length, all[all.length - 1]] as const);
    expect((search.hits as { path: string }[])[0].path).toBe(SECRET.path);
    const [read] = await toolOutputs(stage, a.conversationId, "memory_read");
    expect(String(read.content)).toContain("mushroom-42");
  });

  test("project memory is visible in both channels", async () => {
    const written = await writeMemory(stage, {
      scope: "project",
      path: "facts/castle-hours.md",
      content: "The castle gates open at dawn and close at dusk.",
    });
    expect(written.status).toBe(200);
    await runMemoryJobs();
    for (const channelKey of ["war-room", "kitchen"]) {
      const id = await botCalls(stage, channelKey, [
        [
          { name: "memory_search", input: { query: "castle gates dawn" } },
          {
            name: "memory_read",
            input: { path: "facts/castle-hours.md", scope: "project" },
          },
        ],
      ]);
      const [search] = await toolOutputs(stage, id, "memory_search");
      expect(search.hits).toMatchObject([
        { path: "facts/castle-hours.md", scope: "project" },
      ]);
      const [read] = await toolOutputs(stage, id, "memory_read");
      expect(read).toMatchObject({ scope: "project", current: true });
    }
  });

  test("a person's search of one channel does not see another's", async () => {
    const a = await secretInA();
    const kitchen = await botCalls(stage, "kitchen", []);
    const b = await channelOf(kitchen);
    const inA = await getMemory<{ hits: { path: string }[] }>(
      stage,
      "memory/search",
      {
        query: "launch code",
        scope: "both",
        channelId: a.channelId,
      },
    );
    expect(inA.body.hits.map((h) => h.path)).toEqual([SECRET.path]);
    const inB = await getMemory<{ hits: unknown[] }>(stage, "memory/search", {
      query: "launch code",
      scope: "both",
      channelId: b,
    });
    expect(inB.body.hits).toEqual([]);
  });
});

describe("the boundary is in the SQL", () => {
  test("the channel condition names the channel, and the plan filters on it", async () => {
    const readSet = {
      projectId: stage.u.projectId,
      channel: { channelId: 2 },
      halfLifeDays: { channel: 30, project: 180 },
    };
    const query = api.db.db
      .select({ id: memoryDocuments.id })
      .from(memoryDocuments)
      .where(scopeCondition(readSet, "both"));
    const { sql: text, params } = query.toSQL();
    expect(text).not.toContain("bot_id");
    expect(text).toContain('"memory_documents"."channel_id" = $');
    expect(params).toEqual(
      expect.arrayContaining([stage.u.projectId, "channel", 2, "project"]),
    );
    const plan = await api.db.db.execute(
      // biome-ignore lint/suspicious/noExplicitAny: EXPLAIN over the built query.
      `explain ${text.replace(/\$(\d+)/g, (_, i) => {
        const v = params[Number(i) - 1];
        return typeof v === "number" ? String(v) : `'${v}'`;
      })}` as any,
    );
    const lines = (plan as unknown as { rows: { "QUERY PLAN": string }[] }).rows
      .map((r) => r["QUERY PLAN"])
      .join("\n");
    expect(lines).toMatch(/channel_id = 2/);
    expect(lines).toMatch(/scope = 'project'/);
  });
});
