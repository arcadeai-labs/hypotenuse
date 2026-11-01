import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import { botInstallations } from "../../schema/bot_installations";
import { channelBindings } from "../../schema/channel_bindings";
import { conversations } from "../../schema/conversations";
import { outboxMessages } from "../../schema/outbox_messages";
import { triggerEvents } from "../../schema/trigger_events";
import { type AgentStage, buildAgentStage, drainQueue } from "../agent/harness";
import { settle } from "../channels/harness";
import { type FakePylon, startPylon } from "../fakes/pylon/server";
import { call } from "../setup";

/**
 * The Pylon suites' stage: the agent stage (a scripted model, a bot in
 * Castle), the Pylon fake, and the bot connected to it as a Pylon admin
 * would — its manifest minted, a token with its own identity created, the
 * webhook and its four Triggers configured from the manifest, and the token
 * and secret connected — all over HTTP.
 */
export interface PylonStage extends AgentStage {
  pylon: FakePylon;
  /** The bot's Pylon connection. */
  conn: PylonConnection;
  /** A teammate on the support team. */
  teammate: string;
  /** Two customers, each with a contact. */
  acme: { accountId: string; contactId: string };
  globex: { accountId: string; contactId: string };
  /** The config values to put back after the suite. */
  saved: { apiUrlUs: string; apiUrlEu: string };
}

/** One bot's Pylon connection. */
export interface PylonConnection {
  botId: number;
  installationId: number;
  token: string;
  /** The token's own user id in Pylon. */
  userId: string;
  webhookSecret: string;
  /** The webhook URL, on the server under test. */
  webhookUrl: string;
}

/** The token identity's name, which teammates mention. */
export const BOT_NAME = "Toadsworth";

/**
 * Build the stage.
 * @returns The stage.
 */
export async function buildPylonStage(): Promise<PylonStage> {
  const stage = await buildAgentStage("anthropic");
  const pylon = startPylon();
  const saved = {
    apiUrlUs: config.platforms.pylon.apiUrlUs,
    apiUrlEu: config.platforms.pylon.apiUrlEu,
  };
  config.platforms.pylon.apiUrlUs = `${pylon.url}/us`;
  config.platforms.pylon.apiUrlEu = `${pylon.url}/eu`;
  const conn = await connectPylon(stage, pylon, stage.botId);
  return {
    ...stage,
    pylon,
    conn,
    teammate: pylon.addUser("Daisy"),
    acme: pylon.addAccount("Acme Rockets", "acme.test"),
    globex: pylon.addAccount("Globex", "globex.test"),
    saved,
  };
}

/**
 * Connect a bot to the fake, end to end.
 * Coverage: `pylon.manifest`, `pylon.connect`, `pylon.out.me`.
 * @param stage - The stage.
 * @param pylon - The fake.
 * @param botId - The bot.
 * @param opts.region - The token's region.
 * @returns The connection.
 */
export async function connectPylon(
  stage: AgentStage,
  pylon: FakePylon,
  botId: number,
  opts: { region?: "us" | "eu"; name?: string } = {},
): Promise<PylonConnection> {
  const minted = await call<{
    installation: { id: number };
    urls: { events: string };
    manifest: { triggers: { kickoff: string; body: string }[] };
  }>(
    stage.u.url,
    stage.u.peach,
    "POST",
    `/project/${stage.u.projectId}/bot/${botId}/installation/pylon/manifest`,
    {},
  );
  if (minted.status !== 200) throw new Error(JSON.stringify(minted.body));
  const events = new URL(minted.body.urls.events);
  const webhookUrl = `${stage.u.url}${events.pathname}`;
  const name = opts.name ?? BOT_NAME;
  const { token, userId } = pylon.createToken(name, opts.region ?? "us");
  const webhookSecret = `pylon-wh-${crypto.randomUUID()}`;
  pylon.webhook = { url: webhookUrl, secret: webhookSecret, legacy: false };
  pylon.triggers = minted.body.manifest.triggers.map((t) => ({
    kickoff: t.kickoff,
    body: t.body,
  }));
  const connected = await call<{ installation: { status: string } }>(
    stage.u.url,
    stage.u.peach,
    "PUT",
    `/project/${stage.u.projectId}/bot/${botId}/installation`,
    {
      type: "pylon",
      config: { region: opts.region ?? "us", selfName: name },
      credentials: { apiToken: token, webhookSecret },
    },
  );
  if (connected.status !== 200) throw new Error(JSON.stringify(connected.body));
  return {
    botId,
    installationId: minted.body.installation.id,
    token,
    userId,
    webhookSecret,
    webhookUrl,
  };
}

/**
 * Change the bot's Pylon settings as a project admin.
 * @param stage - The stage.
 * @param body - The settings.
 * @returns The status and body.
 */
export async function editPylonSettings(
  stage: PylonStage,
  body: Record<string, unknown>,
) {
  return call<{ installation: { config: Record<string, unknown> } }>(
    stage.u.url,
    stage.u.peach,
    "POST",
    `/project/${stage.u.projectId}/bot/${stage.botId}/pylon/settings`,
    body,
  );
}

/**
 * Let Pylon deliver, process what arrived and deliver its acknowledgements
 * (as a worker does within seconds, before any tick finishes), then run the
 * pipeline until it settles — three times, since the bot's own notes fire
 * deliveries too.
 * @param stage - The stage.
 */
export async function flow(stage: PylonStage): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await stage.pylon.drain();
    await drainQueue("ingress");
    await drainQueue("outbox");
    await settle();
  }
}

/**
 * Empty the channel tables between tests, keeping the installation active.
 */
export async function resetPylon(): Promise<void> {
  await api.db.db.delete(triggerEvents);
  await api.db.db.delete(outboxMessages);
  await api.db.db.delete(channelBindings);
  await api.db.db.delete(conversations);
  await api.db.db
    .update(botInstallations)
    .set({ status: "active", lastError: null });
  for (const key of [
    ...(await api.redis.redis.keys("rate:bot:*")),
    ...(await api.redis.redis.keys("pylon:bucket:*")),
  ]) {
    await api.redis.redis.del(key);
  }
}

/**
 * The bot's conversation for an issue.
 * @param issueId - The issue.
 * @returns The conversation, or `undefined`.
 */
export async function conversationForIssue(issueId: string) {
  const [row] = await api.db.db
    .select()
    .from(conversations)
    .where(eq(conversations.externalConversationKey, `issue:${issueId}`));
  return row;
}

/** Strip tags from a note's HTML, for assertions. */
export function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
