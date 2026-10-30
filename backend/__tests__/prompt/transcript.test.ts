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
  promptHash,
  type RecordedPart,
  replayPrompt,
} from "../../ops/PromptOps";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  runTicks,
  sendMessage,
  startConversation,
} from "../agent/harness";
import { call, HOOK_TIMEOUT } from "../setup";
import { editSection, promptUpdates, sectionId, sentSystem } from "./harness";

/**
 * What the model saw is in the transcript: an edit between two steps is one
 * `context_update` naming the versions that changed, the next request carries
 * the new text, every recorded prompt rebuilds from its section versions to
 * its hash, and `prompt:preview` is byte for byte what a tick sends.
 */
let stage: AgentStage;

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
});

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/** A step that only replies. */
const reply = (text: string) => ({
  toolCalls: [{ name: "reply_and_wait", input: { text } }],
});

describe("a person's edit between two steps", () => {
  test("is one context_update with the versions that changed, and the next request carries it", async () => {
    const identity = await sectionId(stage.botId, "identity");
    const howIWork = await sectionId(stage.botId, "how-i-work");
    stage.models.play([
      reply("One."),
      reply("Two."),
      {
        ...reply("Three."),
        expect: { systemIncludes: "You speak only in rhyme." },
      },
    ]);
    const res = await startConversation(stage, "Hello.");
    const id = res.body.conversation.id;
    await runTicks();
    await sendMessage(stage, id, "Again.");
    await runTicks();
    expect(await promptUpdates(stage, id)).toHaveLength(1);

    const edited = await editSection(stage, identity, {
      body: "You speak only in rhyme.",
      changeNote: "More fun",
    });
    expect(edited.status).toBe(200);
    expect(edited.body.promptSection.currentVersion).toBe(2);
    const filled = await editSection(stage, howIWork, {
      body: "Check the moat first.",
    });
    expect(filled.status).toBe(200);
    await sendMessage(stage, id, "And again.");
    await runTicks();

    const updates = await promptUpdates(stage, id);
    expect(updates).toHaveLength(2);
    const content = updates[1].content as Record<string, unknown>;
    expect(content.changed).toEqual([
      { id: identity, key: "identity", version: 2, previousVersion: 1 },
    ]);
    expect(content.added).toEqual([
      { id: howIWork, key: "how-i-work", version: 2 },
    ]);
    expect(content.removed).toEqual([]);
    expect(content.previousPromptHash).toBe(updates[0].promptHash);
    expect(sentSystem(stage)).toContain(
      "## How I work\n\nCheck the moat first.",
    );

    // Put the stage back for the next suite's steps.
    await editSection(stage, identity, {
      body: "You are the castle steward. You are brief and kind.",
    });
    await editSection(stage, howIWork, { body: "" });
  });
});

describe("replay", () => {
  test("every recorded prompt rebuilds from its section versions to its hash", async () => {
    const identity = await sectionId(stage.botId, "identity");
    stage.models.play([reply("One."), reply("Two.")]);
    const res = await startConversation(stage, "Hi.");
    const id = res.body.conversation.id;
    await runTicks();
    await editSection(stage, identity, { body: "You are terse." });
    await sendMessage(stage, id, "Hi again.");
    await runTicks();
    // Change it again: replay must use the recorded versions, not the current.
    await editSection(stage, identity, {
      body: "You are the castle steward. You are brief and kind.",
    });

    const updates = await promptUpdates(stage, id);
    expect(updates).toHaveLength(2);
    for (const update of updates) {
      const content = update.content as {
        parts: RecordedPart[];
        prompt: string;
      };
      const rebuilt = await replayPrompt(api.db.db, content.parts);
      expect(rebuilt).toBe(content.prompt);
      expect(promptHash(rebuilt)).toBe(update.promptHash as string);
    }
  });
});

describe("prompt:preview", () => {
  test("matches what the tick sent, byte for byte", async () => {
    await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/prompt-section`,
      {
        botId: stage.botId,
        title: "Moat maintenance",
        body: "Drain the moat on Sundays.",
        loading: "contextual",
        keywords: ["moat"],
      },
    );
    stage.models.play([reply("Draining.")]);
    const res = await startConversation(stage, "When do we clean the moat?", {
      title: "Moat schedule",
    });
    const id = res.body.conversation.id;
    await runTicks();
    const sent = sentSystem(stage);
    expect(sent).toContain("Drain the moat on Sundays.");

    const preview = await call<{
      prompt: { system: string; hash: string; sections: { key: string }[] };
    }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/bot/${stage.botId}/prompt-preview?conversationId=${id}`,
    );
    expect(preview.status).toBe(200);
    expect(preview.body.prompt.system).toBe(sent);
    expect(preview.body.prompt.hash).toBe(promptHash(sent));
    const [update] = await promptUpdates(stage, id);
    expect(update.promptHash).toBe(preview.body.prompt.hash);

    // A sample message decides the contextual sections; without one it is out.
    const bare = await call<{
      prompt: { system: string; sections: { key: string }[] };
    }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/bot/${stage.botId}/prompt-preview?message=${encodeURIComponent("hello there")}`,
    );
    expect(bare.body.prompt.sections.map((s) => s.key)).not.toContain(
      "moat-maintenance",
    );
    const moat = await call<{ prompt: { sections: { key: string }[] } }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/bot/${stage.botId}/prompt-preview?message=${encodeURIComponent("the moat is full")}`,
    );
    expect(moat.body.prompt.sections.map((s) => s.key)).toContain(
      "moat-maintenance",
    );
  });
});
