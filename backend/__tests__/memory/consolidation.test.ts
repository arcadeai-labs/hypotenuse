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
  clearLoopQueues,
  conversationRow,
  runTicks,
  setColumns,
  startConversation,
} from "../agent/harness";
import { HOOK_TIMEOUT, runAction } from "../setup";
import {
  buildMemoryStage,
  channelOf,
  clearMemory,
  getMemory,
  type MemoryStage,
  runMemoryJobs,
  writeMemory,
} from "./harness";

/**
 * Consolidation: when a conversation comes to rest, the bot's `fast` model
 * turns what was said into facts in channel memory, with provenance; a fact
 * that supersedes another edits it; a repeat finds nothing new; and the due
 * clock catches a lost enqueue.
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

/**
 * Have one short conversation on a channel that ends with a reply.
 * @param channelKey - The channel.
 * @param text - What the person says.
 * @returns The conversation id.
 */
async function converse(channelKey: string, text: string): Promise<number> {
  stage.models.play([
    { toolCalls: [{ name: "reply_and_wait", input: { text: "Noted." } }] },
  ]);
  const res = await startConversation(stage, text, { channelKey });
  expect(res.status).toBe(200);
  await runTicks();
  return res.body.conversation.id;
}

/**
 * The scripted `fast` model's answer: structured output arrives as a call
 * of the `json` tool the provider offers for it.
 * @param facts - The facts.
 * @param expect - Assertions on the request.
 * @returns The scripted response.
 */
function factsAnswer(
  facts: Record<string, unknown>[],
  expectations: Record<string, unknown> = {},
) {
  return {
    toolCalls: [{ name: "json", input: { facts } }],
    expect: expectations,
  };
}

type Versions = {
  versions: {
    content: string;
    sourceType: string;
    provenance: { conversationId?: number; seqs?: number[] };
  }[];
};

describe("consolidation", () => {
  test("facts land in channel memory with provenance, once", async () => {
    const id = await converse(
      "ops",
      "We deploy on Tuesdays, and Mario owns the release checklist.",
    );
    const row = await conversationRow(id);
    expect(row.state).toBe("hibernating");
    stage.models.play([
      factsAnswer(
        [
          {
            path: "deploy-day", // forced under facts/, given .md
            statement: "Deploys happen on Tuesdays.",
            evidenceSeqs: [2, 999], // 999 is not an entry and is dropped
          },
          {
            path: "facts/release-owner.md",
            statement: "Mario owns the release checklist.",
            evidenceSeqs: [2],
          },
        ],
        {
          anyMessageIncludes: "We deploy on Tuesdays",
          systemIncludes: "durable facts",
        },
      ),
    ]);
    expect(await runMemoryJobs("memory:consolidate")).toEqual([
      "memory:consolidate",
    ]);
    const channelId = await channelOf(id);
    const list = await getMemory<{
      documents: { path: string; sourceType: string }[];
    }>(stage, "memory", { scope: "channel", channelId });
    expect(list.body.documents.map((d) => [d.path, d.sourceType])).toEqual([
      ["facts/deploy-day.md", "consolidation"],
      ["facts/release-owner.md", "consolidation"],
    ]);
    const view = await getMemory<{
      document: { content: string; provenance: unknown };
    }>(stage, "memory/document", {
      scope: "channel",
      channelId,
      path: "facts/deploy-day.md",
    });
    expect(view.body.document).toMatchObject({
      content: "Deploys happen on Tuesdays.",
      provenance: { conversationId: id, seqs: [2] },
    });
    // Nothing reached project memory.
    const project = await getMemory<{ documents: unknown[] }>(stage, "memory", {
      scope: "project",
    });
    expect(project.body.documents).toEqual([]);

    const after = await conversationRow(id);
    expect(after.memoryConsolidatedSeq).toBe(after.lastSeq);
    // A repeat finds nothing new and asks the model nothing.
    const asked = stage.models.completions.length;
    await runAction("memory:consolidate", { conversationId: id });
    expect(stage.models.completions.length).toBe(asked);
  });

  test("a fact that supersedes another edits it instead of adding a duplicate", async () => {
    const id = await converse(
      "ops",
      "Actually, we moved deploys to Thursdays.",
    );
    const channelId = await channelOf(id);
    await writeMemory(stage, {
      scope: "channel",
      channelId,
      path: "facts/deploy-day.md",
      content: "Deploys happen on Tuesdays.",
      description: "Which day we deploy",
    });
    stage.models.play([
      factsAnswer(
        [
          {
            path: "facts/deploy-schedule.md",
            statement: "Deploys happen on Thursdays.",
            evidenceSeqs: [2],
            supersedes: "facts/deploy-day.md",
          },
        ],
        // The model is shown the facts the channel already has.
        { lastMessageIncludes: "facts/deploy-day.md: Which day we deploy" },
      ),
    ]);
    await runMemoryJobs("memory:consolidate");
    const list = await getMemory<{ documents: { path: string }[] }>(
      stage,
      "memory",
      { scope: "channel", channelId },
    );
    expect(list.body.documents.map((d) => d.path)).toEqual([
      "facts/deploy-day.md",
    ]);
    const history = await getMemory<Versions>(
      stage,
      "memory/document/versions",
      {
        scope: "channel",
        channelId,
        path: "facts/deploy-day.md",
      },
    );
    expect(history.body.versions.map((v) => [v.content, v.sourceType])).toEqual(
      [
        ["Deploys happen on Thursdays.", "consolidation"],
        ["Deploys happen on Tuesdays.", "person"],
      ],
    );
  });

  test("a blank fact does not overwrite the fact it supersedes", async () => {
    const id = await converse("ops", "Hmm, never mind about deploys.");
    const channelId = await channelOf(id);
    await writeMemory(stage, {
      scope: "channel",
      channelId,
      path: "facts/deploy-day.md",
      content: "Deploys happen on Tuesdays.",
    });
    stage.models.play([
      factsAnswer([
        {
          path: "facts/deploy-day.md",
          statement: "   ",
          evidenceSeqs: [2],
          supersedes: "facts/deploy-day.md",
        },
      ]),
    ]);
    await runMemoryJobs("memory:consolidate");
    const history = await getMemory<Versions>(
      stage,
      "memory/document/versions",
      {
        scope: "channel",
        channelId,
        path: "facts/deploy-day.md",
      },
    );
    expect(history.body.versions.map((v) => v.content)).toEqual([
      "Deploys happen on Tuesdays.",
    ]);
    // The conversation is still marked read: the answer was taken, and empty.
    const row = await conversationRow(id);
    expect(row.memoryConsolidatedSeq).toBe(row.lastSeq);
  });

  test("a conversation with too little new is not consolidated", async () => {
    const id = await converse("ops", "Hello.");
    stage.models.play([factsAnswer([])]);
    await runMemoryJobs("memory:consolidate");
    // Mark everything but the last three entries as read.
    const row = await conversationRow(id);
    await setColumns(id, { memoryConsolidatedSeq: row.lastSeq - 3 });
    const asked = stage.models.completions.length;
    const out = await runAction<{ result: unknown }>("memory:consolidate", {
      conversationId: id,
    });
    expect(out.result).toBeNull();
    expect(stage.models.completions.length).toBe(asked);
  });

  test("the due clock enqueues a consolidation whose own enqueue was lost", async () => {
    const id = await converse("ops", "The moat is drained on Fridays.");
    await clearLoopQueues(); // the tick's enqueue is lost
    expect(
      await runAction<{ enqueued: number[] }>("memory:consolidate-due"),
    ).toEqual({ enqueued: [] }); // too recent: its tick's enqueue is trusted
    await setColumns(id, {
      lastActivityAt: new Date(Date.now() - 5 * 60_000),
    });
    expect(
      await runAction<{ enqueued: number[] }>("memory:consolidate-due"),
    ).toEqual({ enqueued: [id] });
    stage.models.play([factsAnswer([])]);
    expect(await runMemoryJobs("memory:consolidate")).toEqual([
      "memory:consolidate",
    ]);
    const row = await conversationRow(id);
    expect(row.memoryConsolidatedSeq).toBe(row.lastSeq);
  });
});
