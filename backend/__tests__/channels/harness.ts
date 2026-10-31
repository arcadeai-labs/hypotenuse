import { eq } from "drizzle-orm";
import { api } from "keryx";
import { botInstallations } from "../../schema/bot_installations";
import { channelBindings } from "../../schema/channel_bindings";
import { conversations } from "../../schema/conversations";
import { outboxMessages } from "../../schema/outbox_messages";
import { triggerEvents } from "../../schema/trigger_events";
import { type AgentStage, buildAgentStage, drainQueue } from "../agent/harness";
import { WebhookPlatform } from "../fakes/webhook/server";
import { call, type TestUser } from "../setup";

/**
 * The channel suites' stage: the agent stage (a scripted model, a bot in
 * Castle), the webhook platform's fake, and the bot's webhook installation
 * minted, connected, and tested — all over HTTP.
 */
export interface ChannelStage extends AgentStage {
  platform: WebhookPlatform;
  installationId: number;
}

/**
 * Build the stage.
 * @returns The stage.
 */
export async function buildChannelStage(): Promise<ChannelStage> {
  const stage = await buildAgentStage("anthropic");
  const platform = new WebhookPlatform().start();
  const installationId = await installWebhook(stage, platform);
  return { ...stage, platform, installationId };
}

/**
 * Mint a webhook installation for the stage's bot, connect it to the fake,
 * and test it.
 * @param stage - The stage.
 * @param platform - The fake.
 * @param workspace - The workspace.
 * @returns The installation id.
 */
// Coverage: `webhook.out.ping`.
export async function installWebhook(
  stage: AgentStage,
  platform: WebhookPlatform,
  workspace = "acme",
): Promise<number> {
  const minted = await call<{
    installation: { id: number };
    urls: { events: string };
  }>(
    stage.u.url,
    stage.u.peach,
    "POST",
    `/project/${stage.u.projectId}/bot/${stage.botId}/installation/webhook/manifest`,
    { externalWorkspaceId: workspace },
  );
  if (minted.status !== 200) throw new Error(JSON.stringify(minted.body));
  // The events URL is built from APPLICATION_URL; the suite's server is local.
  const path = new URL(minted.body.urls.events).pathname;
  platform.eventsUrl = `${stage.u.url}${path}`;
  const connected = await call(
    stage.u.url,
    stage.u.peach,
    "PUT",
    `/project/${stage.u.projectId}/bot/${stage.botId}/installation`,
    {
      type: "webhook",
      externalWorkspaceId: workspace,
      config: { deliveryUrl: platform.deliveryUrl },
      credentials: { signingSecret: platform.secret },
    },
  );
  if (connected.status !== 200) throw new Error(JSON.stringify(connected.body));
  const tested = await call<{ ok: boolean }>(
    stage.u.url,
    stage.u.peach,
    "POST",
    `/project/${stage.u.projectId}/bot-installation/${minted.body.installation.id}/test`,
  );
  if (!tested.body.ok) throw new Error(JSON.stringify(tested.body));
  return minted.body.installation.id;
}

/**
 * Run the whole pipeline the way workers would until it settles: process
 * events, run ticks, deliver the outbox.
 * @param rounds - How many passes at most.
 */
export async function settle(rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const ran = [
      ...(await drainQueue("ingress")),
      ...(await drainQueue("agents", { only: "agent:tick" })),
      ...(await drainQueue("outbox")),
    ];
    if (ran.length === 0) return;
  }
}

/**
 * The newest trigger event.
 * @returns The row.
 */
export async function lastEvent() {
  const rows = await api.db.db
    .select()
    .from(triggerEvents)
    .orderBy(triggerEvents.id);
  return rows[rows.length - 1];
}

/**
 * A bot's conversation for a thread.
 * @param key - The thread.
 * @returns The conversation, or `undefined`.
 */
export async function conversationFor(key: string) {
  const [row] = await api.db.db
    .select()
    .from(conversations)
    .where(eq(conversations.externalConversationKey, key));
  return row;
}

/**
 * A conversation's outbox rows, oldest first.
 * @param conversationId - The conversation.
 * @returns The rows.
 */
export async function outboxOf(conversationId: number) {
  return api.db.db
    .select()
    .from(outboxMessages)
    .where(eq(outboxMessages.conversationId, conversationId))
    .orderBy(outboxMessages.id);
}

/**
 * Empty the channel framework's tables between tests, keeping the
 * installation.
 */
export async function resetChannels(): Promise<void> {
  await api.db.db.delete(triggerEvents);
  await api.db.db.delete(channelBindings);
  await api.db.db.delete(conversations);
  await api.db.db.update(botInstallations).set({ status: "active" });
  for (const key of await api.redis.redis.keys("rate:bot:*")) {
    await api.redis.redis.del(key);
  }
}

/**
 * Edit a binding over HTTP.
 * @param stage - The stage.
 * @param bindingId - The binding.
 * @param body - The changes.
 * @param user - Who.
 * @returns The status and body.
 */
export async function editBinding(
  stage: AgentStage,
  bindingId: number,
  body: Record<string, unknown>,
  user: TestUser = stage.u.peach,
) {
  return call<{ binding: Record<string, unknown> }>(
    stage.u.url,
    user,
    "POST",
    `/project/${stage.u.projectId}/channel-binding/${bindingId}`,
    body,
  );
}

/** A reply step for the scripted model. */
export const reply = (text: string) => ({
  toolCalls: [{ name: "reply_and_wait", input: { text } }],
});
