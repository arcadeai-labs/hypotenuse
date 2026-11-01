import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { api } from "keryx";
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
  toolOutputs,
} from "./harness";

/**
 * History is append-only: a write or edit is a new version, a forget a
 * tombstone, an edit against a stale base is refused, every answer carries
 * a versionId, and an old version stays readable.
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

const PATH = "people/toad.md";

describe("versions", () => {
  test("write, edit, a refused stale edit, forget, and reading an old version", async () => {
    const id = await botCalls(stage, "lobby", [
      [
        {
          name: "memory_write",
          input: {
            path: "people/toad", // no extension: .md is added
            scope: "channel",
            content: "# Toad\nRole: steward's assistant\nLikes: mushrooms",
            changeNote: "Met Toad.",
          },
        },
      ],
    ]);
    const [written] = await toolOutputs(stage, id, "memory_write");
    expect(written).toMatchObject({ path: PATH, scope: "channel" });
    const v1 = written.versionId as number;
    expect(typeof v1).toBe("number");

    await botCallsIn(stage, id, [
      [
        {
          name: "memory_edit",
          input: {
            path: PATH,
            scope: "channel",
            baseVersionId: v1,
            changeNote: "Toad was promoted.",
            patches: [{ start_line: 2, end_line: 2, content: "Role: captain" }],
          },
        },
      ],
      // The same base again: no longer current.
      [
        {
          name: "memory_edit",
          input: {
            path: PATH,
            scope: "channel",
            baseVersionId: v1,
            changeNote: "Stale.",
            patches: [
              { start_line: 3, end_line: 3, content: "Likes: nothing" },
            ],
          },
        },
      ],
      [{ name: "memory_read", input: { path: PATH, scope: "channel" } }],
      [
        {
          name: "memory_read",
          input: { path: PATH, scope: "channel", versionId: v1 },
        },
      ],
    ]);
    const [edited, stale] = await toolOutputs(stage, id, "memory_edit");
    const v2 = edited.versionId as number;
    expect(v2).toBeGreaterThan(v1);
    expect(stale).toMatchObject({
      is_error: true,
      error_type: "version_conflict",
    });
    expect(String(stale.next_action_hint)).toContain(String(v2));

    const [current, old] = await toolOutputs(stage, id, "memory_read");
    expect(current).toMatchObject({ versionId: v2, current: true });
    expect(current.content).toBe(
      "1\t# Toad\n2\tRole: captain\n3\tLikes: mushrooms",
    );
    expect(current.provenance).toMatchObject({ conversationId: id });
    expect((current.provenance as { seqs: number[] }).seqs.length).toBe(1);
    expect(old).toMatchObject({ versionId: v1, current: false });
    expect(String(old.content)).toContain("steward's assistant");

    await botCallsIn(stage, id, [
      [
        {
          name: "memory_forget",
          input: { path: PATH, scope: "channel", reason: "Toad left." },
        },
      ],
      [{ name: "memory_read", input: { path: PATH, scope: "channel" } }],
      [{ name: "memory_list", input: {} }],
    ]);
    const [forgotten] = await toolOutputs(stage, id, "memory_forget");
    expect(forgotten.versionId as number).toBeGreaterThan(v2);
    const reads = await toolOutputs(stage, id, "memory_read");
    expect(reads[reads.length - 1]).toMatchObject({
      is_error: true,
      error_type: "forgotten",
    });
    const lists = await toolOutputs(stage, id, "memory_list");
    expect(lists[lists.length - 1]).toMatchObject({ total: 0 });

    // A person sees the whole history, newest first, the tombstone included.
    const channelId = await channelOf(id);
    const history = await getMemory<{
      versions: {
        versionId: number;
        forgotten: boolean;
        current: boolean;
        changeNote: string;
        sourceType: string;
      }[];
    }>(stage, "memory/document/versions", {
      scope: "channel",
      channelId,
      path: PATH,
    });
    expect(history.status).toBe(200);
    expect(
      history.body.versions.map((v) => [v.versionId, v.forgotten, v.current]),
    ).toEqual([
      [forgotten.versionId as number, true, true],
      [v2, false, false],
      [v1, false, false],
    ]);
    expect(history.body.versions[0]).toMatchObject({
      changeNote: "Toad left.",
      sourceType: "agent",
    });
  });

  test("a retried write with the same tool call id writes once", async () => {
    const call = {
      id: "toolu_retry_1",
      name: "memory_write",
      input: {
        path: "facts/moat.md",
        scope: "channel",
        content: "The moat is deep.",
        changeNote: "Seen.",
      },
    };
    const id = await botCalls(stage, "lobby", [[call]]);
    // The provider reuses the id in a later step (as a crashed tick's retry would).
    await botCallsIn(stage, id, [[call]]);
    const [first, second] = await toolOutputs(stage, id, "memory_write");
    expect(second.versionId).toBe(first.versionId);
    const channelId = await channelOf(id);
    const history = await getMemory<{ versions: unknown[] }>(
      stage,
      "memory/document/versions",
      {
        scope: "channel",
        channelId,
        path: "facts/moat.md",
      },
    );
    expect(history.body.versions).toHaveLength(1);
  });

  test("a bot cannot write, edit, or forget project memory", async () => {
    const id = await botCalls(stage, "lobby", [
      [
        {
          name: "memory_write",
          input: {
            path: "facts/everyone.md",
            scope: "project",
            content: "Shared.",
            changeNote: "Tell everyone.",
          },
        },
        {
          name: "memory_forget",
          input: { path: "facts/everyone.md", scope: "project", reason: "x" },
        },
      ],
    ]);
    for (const tool of ["memory_write", "memory_forget"]) {
      const [out] = await toolOutputs(stage, id, tool);
      expect(out, tool).toMatchObject({
        is_error: true,
        error_type: "project_write_refused",
      });
      expect(String(out.next_action_hint)).toContain("channel");
    }
  });
});
