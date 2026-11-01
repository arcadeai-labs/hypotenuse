import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { api, config } from "keryx";
import { settle } from "../channels/harness";
import { cookieHeader, HOOK_TIMEOUT } from "../setup";
import { buildSlackStage, type SlackStage } from "./harness";

/**
 * No Slack credential leaves the server: the bot token, the client and
 * signing secrets, and the app configuration token are in no answer, no audit
 * row, no log line, and no stored row outside the sealed column — after the
 * app was created, installed, rotated, and used in a thread.
 */
let stage: SlackStage;
const logged: string[] = [];
const methods = ["debug", "info", "warn", "error"] as const;
const originals = methods.map((m) => api.logger[m]);

beforeAll(async () => {
  stage = await buildSlackStage();
  methods.forEach((m, i) => {
    api.logger[m] = ((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
      return (originals[i] as (...a: unknown[]) => unknown).apply(
        api.logger,
        args,
      );
    }) as never;
  });
  stage.models.play([
    { toolCalls: [{ name: "reply_and_wait", input: { text: "Hi." } }] },
  ]);
  await stage.slack.say({ channel: "C0GENERAL", text: "Hi", mention: true });
  await settle();
}, HOOK_TIMEOUT);

afterAll(async () => {
  methods.forEach((m, i) => {
    api.logger[m] = originals[i] as never;
  });
  config.platforms.slack.apiUrl = stage.apiUrl;
  await stage.slack.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Assert no Slack secret appears in a text.
 * @param where - What was read.
 * @param text - Its text.
 * @param opts - `routingKey: false` to leave the routing key out of the check.
 */
function clean(
  where: string,
  text: string,
  opts: { routingKey?: boolean } = {},
) {
  const s = stage.slack;
  const routingKey = s.eventsUrl.split("/").pop() as string;
  for (const [name, value] of Object.entries({
    botToken: s.botToken,
    clientSecret: s.clientSecret,
    signingSecret: s.signingSecret,
    configToken: s.configToken,
    ...(opts.routingKey === false ? {} : { routingKey }),
  })) {
    expect(text.includes(value), `${where}: ${name}`).toBe(false);
  }
}

describe("no Slack credential leaves the server", () => {
  // Coverage: `slack.secrets`.
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

  test("no stored row outside the sealed column, and no log line, carries one", async () => {
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
    // The routing key is redacted from the logged params (`secret()`), but
    // Keryx's action log line also prints the request URL, path included —
    // reported upstream; see the Slack platform's learnings. The credentials
    // themselves are in no log line.
    clean("logs", logged.join("\n"), { routingKey: false });
    const rk = stage.slack.eventsUrl.split("/").pop() as string;
    expect(logged.some((l) => l.includes(`"routingKey":"${rk}"`))).toBe(false);
  });
});
