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
import {
  botCalls,
  buildMemoryStage,
  channelOf,
  clearMemory,
  getMemory,
  type MemoryStage,
  writeMemory,
} from "../memory/harness";
import { call, HOOK_TIMEOUT, type TestUser } from "../setup";

/**
 * RBAC and audit for every memory action. Toadsworth's lists: read by
 * `operators` and `viewers`, written by `operators`.
 *
 * | Who | Channel read | Channel write | Project read | Project write | Promote |
 * |---|---|---|---|---|---|
 * | Peach (owner) | yes | yes | yes | yes | yes |
 * | Mario (`operators`) | yes | yes | yes | no | no |
 * | Luigi (`viewers`) | yes | no | yes | no | no |
 * | Toad (no tags) | 404 | 404 | yes | no | no |
 * | Bowser (outsider) | no | no | no | no | no |
 */
let stage: MemoryStage;
let channelId: number;
let channel: Record<string, unknown>;

beforeAll(async () => {
  stage = await buildMemoryStage();
  const edited = await call(
    stage.u.url,
    stage.u.peach,
    "POST",
    `/project/${stage.u.projectId}/bot/${stage.botId}`,
    { accessRead: ["operators", "viewers"], accessWrite: ["operators"] },
  );
  if (edited.status !== 200) throw new Error(JSON.stringify(edited.body));
  channelId = await channelOf(await botCalls(stage, "lobby", []));
  channel = { scope: "channel", botId: stage.botId, channelId };
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
 * A memory write's or change's route, as a user.
 * @param user - Who.
 * @param method - The verb.
 * @param route - Beneath the project.
 * @param body - The inputs.
 * @returns The status and body.
 */
function act(
  user: TestUser,
  method: "PUT" | "POST" | "DELETE",
  route: string,
  body: Record<string, unknown>,
) {
  return call(
    stage.u.url,
    user,
    method,
    `/project/${stage.u.projectId}/${route}`,
    body,
  );
}

describe("channel memory follows the bot's access lists", () => {
  test("read needs the bot's read list; write, forget, and pin its write list", async () => {
    const { peach, mario, luigi, toad, bowser } = stage.u;
    const doc = { ...channel, path: "facts/gate.md" };
    expect(
      (await writeMemory(stage, { ...doc, content: "Oak." }, mario)).status,
    ).toBe(200);
    expect(
      (await writeMemory(stage, { ...doc, content: "Iron." }, luigi)).status,
    ).toBe(403);
    expect(
      (await writeMemory(stage, { ...doc, content: "Iron." }, toad)).status,
    ).toBe(404);
    expect(
      (await writeMemory(stage, { ...doc, content: "Iron." }, bowser)).status,
    ).toBe(403);

    for (const [user, status] of [
      [peach, 200],
      [mario, 200],
      [luigi, 200],
      [toad, 404],
      [bowser, 403],
    ] as const) {
      for (const route of [
        "memory",
        "memory/document",
        "memory/document/versions",
      ]) {
        const res = await getMemory(stage, route, doc, user);
        expect(res.status, `${user.email} ${route}`).toBe(status);
      }
      const search = await getMemory(
        stage,
        "memory/search",
        { ...doc, query: "oak", scope: "both" },
        user,
      );
      expect(search.status, `${user.email} search`).toBe(status);
      const channels = await getMemory(
        stage,
        `bot/${stage.botId}/memory/channels`,
        {},
        user,
      );
      expect(channels.status, `${user.email} channels`).toBe(status);
    }

    expect(
      (
        await act(luigi, "POST", "memory/document/pin", {
          ...doc,
          pinned: true,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await act(mario, "POST", "memory/document/pin", {
          ...doc,
          pinned: true,
        })
      ).status,
    ).toBe(200);
    expect((await act(luigi, "DELETE", "memory/document", doc)).status).toBe(
      403,
    );
    expect((await act(mario, "DELETE", "memory/document", doc)).status).toBe(
      200,
    );
  });

  test("channel scope needs a bot and its own channel", async () => {
    const missing = await getMemory(stage, "memory", {
      scope: "channel",
      botId: stage.botId,
    });
    expect(missing.status).toBe(406);
    expect(missing.body.error?.key).toBe("channelId");
    // Another bot's API channel is not this bot's.
    const other = await call<{ bot: { id: number } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot`,
      { name: "Kamek", persona: "A magikoopa." },
    );
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Hi." } }] },
    ]);
    const started = await call<{ conversation: { channelId: number } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot/${other.body.bot.id}/conversation`,
      { text: "Hello", channelKey: "lobby" },
    );
    const foreign = await getMemory(stage, "memory", {
      scope: "channel",
      botId: stage.botId,
      channelId: started.body.conversation.channelId,
    });
    expect(foreign.status).toBe(404);
  });
});

describe("project memory", () => {
  test("every member reads it; only an admin writes, forgets, or pins it", async () => {
    const { peach, mario, toad, bowser } = stage.u;
    const doc = { scope: "project", path: "facts/kingdom.md" };
    expect(
      (await writeMemory(stage, { ...doc, content: "Mushrooms." }, mario))
        .status,
    ).toBe(403);
    expect(
      (await writeMemory(stage, { ...doc, content: "Mushrooms." }, peach))
        .status,
    ).toBe(200);
    expect((await getMemory(stage, "memory/document", doc, toad)).status).toBe(
      200,
    );
    expect(
      (await getMemory(stage, "memory/document", doc, bowser)).status,
    ).toBe(403);
    expect((await act(mario, "POST", "memory/document/pin", doc)).status).toBe(
      403,
    );
    expect((await act(mario, "DELETE", "memory/document", doc)).status).toBe(
      403,
    );
    expect((await act(peach, "DELETE", "memory/document", doc)).status).toBe(
      200,
    );
    expect(
      (await getMemory(stage, "memory/document", doc, toad)).body,
    ).toMatchObject({
      document: { forgotten: true },
    });
  });

  test("promotion needs the bot's write list and admin standing", async () => {
    const { peach, mario } = stage.u;
    const doc = { ...channel, path: "facts/drawbridge.md" };
    await writeMemory(
      stage,
      { ...doc, content: "The drawbridge lowers at noon." },
      mario,
    );
    const promote = { botId: stage.botId, channelId, path: doc.path };
    expect(
      (await act(mario, "POST", "memory/document/promote", promote)).status,
    ).toBe(403);
    const res = await act(peach, "POST", "memory/document/promote", {
      ...promote,
      targetPath: "facts/castle/drawbridge.md",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      document: {
        scope: "project",
        path: "facts/castle/drawbridge.md",
        content: "The drawbridge lowers at noon.",
        sourceType: "promotion",
        provenance: {
          promotedFromBotId: stage.botId,
          promotedFromChannelId: channelId,
        },
      },
      promotedFrom: { scope: "channel", path: doc.path },
    });
    // The channel copy stays.
    expect((await getMemory(stage, "memory/document", doc)).status).toBe(200);
  });
});

describe("pinning beside a write", () => {
  test("a pin racing a new version still pins the document", async () => {
    const doc = { scope: "project", path: "facts/race.md" };
    await writeMemory(stage, { ...doc, content: "Version 0." });
    for (let i = 1; i <= 8; i++) {
      const [pin, write] = await Promise.all([
        act(stage.u.peach, "POST", "memory/document/pin", {
          ...doc,
          pinned: i % 2 === 1,
        }),
        writeMemory(stage, { ...doc, content: `Version ${i}.` }),
      ]);
      expect([pin.status, write.status], `round ${i}`).toEqual([200, 200]);
    }
  });
});

describe("every write is audited, and the words stay out of the audit row", () => {
  test("write, pin, promote, forget, and reindex each leave a row", async () => {
    const { peach } = stage.u;
    const secret = "The vault combination is 7-7-7.";
    const doc = { ...channel, path: "facts/vault.md" };
    await writeMemory(stage, { ...doc, content: secret }, peach);
    await act(peach, "POST", "memory/document/pin", doc);
    await act(peach, "POST", "memory/document/promote", {
      botId: stage.botId,
      channelId,
      path: doc.path,
    });
    await act(peach, "DELETE", "memory/document", {
      ...doc,
      reason: "Changed.",
    });
    await act(peach, "POST", "memory/reindex", {});
    const audit = await call<{
      auditLogs: { action: string; targetType: string; targetPath: string }[];
    }>(
      stage.u.url,
      peach,
      "GET",
      `/project/${stage.u.projectId}/audit?limit=100`,
    );
    expect(audit.status).toBe(200);
    const rows = audit.body.auditLogs.filter(
      (r) =>
        r.action === "memory:reindex" ||
        r.targetPath.endsWith("facts/vault.md"),
    );
    expect(rows.map((r) => [r.action, r.targetPath]).reverse()).toEqual([
      ["memory:write", "channel:facts/vault.md"],
      ["memory:pin", "channel:facts/vault.md"],
      ["memory:promote", "project:facts/vault.md"],
      ["memory:forget", "channel:facts/vault.md"],
      ["memory:reindex", String(stage.u.projectId)],
    ]);
    expect(JSON.stringify(audit.body)).not.toContain("7-7-7");
  });
});
