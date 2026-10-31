import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { api } from "keryx";
import {
  buildChannelStage,
  type ChannelStage,
  settle,
} from "../channels/harness";
import { cookieHeader, HOOK_TIMEOUT } from "../setup";

/**
 * No installation credential leaves the server: the signing secret a
 * platform app was connected with, and the routing key its URL carries, are
 * in no answer but the one that minted the key, no audit row, and no stored
 * row outside the sealed column and the key's hash.
 */
let stage: ChannelStage;

beforeAll(async () => {
  stage = await buildChannelStage();
  stage.models.play([
    { toolCalls: [{ name: "reply_and_wait", input: { text: "Hi." } }] },
  ]);
  await stage.platform.send({
    channel: "C-general",
    conversation: "T-s",
    text: "Hi",
    mentions: true,
  });
  await settle();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await stage.platform.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Assert neither secret appears in a text.
 * @param where - What was read.
 * @param text - Its text.
 */
function clean(where: string, text: string) {
  const routingKey = stage.platform.eventsUrl.split("/").pop() as string;
  expect(text.includes(stage.platform.secret), `${where}: signing secret`).toBe(
    false,
  );
  expect(text.includes(routingKey), `${where}: routing key`).toBe(false);
}

describe("no installation credential leaves the server", () => {
  test("no answer carries one", async () => {
    const p = `/project/${stage.u.projectId}`;
    for (const path of [
      `${p}/bot/${stage.botId}/installations`,
      `${p}/bot-installation/${stage.installationId}`,
      `${p}/channels?botId=${stage.botId}`,
      `${p}/trigger-events`,
      `${p}/participants`,
      `${p}/audit`,
      `${p}/bot/${stage.botId}`,
    ]) {
      const res = await fetch(`${stage.u.url}/api${path}`, {
        headers: cookieHeader(stage.u.peach.sessionId),
      });
      expect(res.status, path).toBe(200);
      clean(path, await res.text());
    }
  });

  test("no stored row outside the sealed column carries one", async () => {
    for (const table of [
      "audit_logs",
      "trigger_events",
      "outbox_messages",
      "channels",
      "participants",
      "bot_installations",
    ]) {
      const rows = await api.db.db.execute(
        sql.raw(`select row_to_json(t)::text as j from ${table} t`),
      );
      clean(table, JSON.stringify(rows.rows));
    }
  });
});
