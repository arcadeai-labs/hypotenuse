import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import { botInstallations } from "../../schema/bot_installations";
import { channelBindings } from "../../schema/channel_bindings";
import { conversations } from "../../schema/conversations";
import { triggerEvents } from "../../schema/trigger_events";
import { type AgentStage, buildAgentStage } from "../agent/harness";
import { SlackFake } from "../fakes/slack/server";
import { call } from "../setup";

/**
 * The Slack suites' stage: the agent stage (a scripted model, a bot in
 * Castle), the Slack fake, and the bot's Slack app created with a
 * configuration token and installed by OAuth — all over HTTP, as a person
 * would, with the Web API pointed at the fake.
 */
export interface SlackStage extends AgentStage {
  slack: SlackFake;
  installationId: number;
  /** The Web API URL to put back after the suite. */
  apiUrl: string;
}

/**
 * Build the stage.
 * @returns The stage.
 */
export async function buildSlackStage(): Promise<SlackStage> {
  const stage = await buildAgentStage("anthropic");
  const slack = new SlackFake().start();
  const apiUrl = config.platforms.slack.apiUrl;
  config.platforms.slack.apiUrl = `${slack.url}/api`;
  const installationId = await installSlack(stage, slack);
  return { ...stage, slack, installationId, apiUrl };
}

/**
 * Create the bot's Slack app through `slack:app-create` and install it
 * through the OAuth hops, with the fake playing Slack and the person.
 * @param stage - The stage.
 * @param slack - The fake.
 * @returns The installation id.
 */
// Coverage: `slack.app.create`, `slack.oauth.install`.
export async function installSlack(
  stage: AgentStage,
  slack: SlackFake,
): Promise<number> {
  const created = await call<{ installation: { id: number } }>(
    stage.u.url,
    stage.u.peach,
    "PUT",
    `/project/${stage.u.projectId}/bot/${stage.botId}/slack/app`,
    { configToken: slack.configToken },
  );
  if (created.status !== 200) throw new Error(JSON.stringify(created.body));
  const id = created.body.installation.id;
  // The events URL is in the manifest Slack received; the suite's server is local.
  const [create] = slack.calls("apps.manifest.create");
  const manifest = JSON.parse(String(create.args.manifest));
  const events = new URL(manifest.settings.event_subscriptions.request_url);
  slack.eventsUrl = `${stage.u.url}${events.pathname}`;
  await completeInstall(stage, slack, id);
  return id;
}

/**
 * Run the OAuth hops for an installation: start, the person approves on the
 * fake, and the browser lands on the callback.
 * @param stage - The stage.
 * @param slack - The fake.
 * @param installationId - The installation.
 * @returns The callback's redirect.
 */
export async function completeInstall(
  stage: AgentStage,
  slack: SlackFake,
  installationId: number,
): Promise<string> {
  const start = await call<{ url: string }>(
    stage.u.url,
    stage.u.peach,
    "GET",
    `/project/${stage.u.projectId}/bot-installation/${installationId}/oauth?format=json`,
  );
  if (start.status !== 200) throw new Error(JSON.stringify(start.body));
  const back = new URL(slack.approveInstall(start.body.url));
  const res = await fetch(`${stage.u.url}${back.pathname}${back.search}`, {
    redirect: "manual",
  });
  if (res.status !== 302) throw new Error(await res.text());
  return String(res.headers.get("location"));
}

/**
 * Empty the channel tables between tests, keeping the installation active.
 */
export async function resetSlack(): Promise<void> {
  await api.db.db.delete(triggerEvents);
  await api.db.db.delete(channelBindings);
  await api.db.db.delete(conversations);
  await api.db.db.update(botInstallations).set({ status: "active" });
  for (const key of [
    ...(await api.redis.redis.keys("rate:bot:*")),
    ...(await api.redis.redis.keys("slack:bucket:*")),
  ]) {
    await api.redis.redis.del(key);
  }
}

/**
 * A bot's conversation for a Slack thread.
 * @param threadTs - The thread.
 * @returns The conversation, or `undefined`.
 */
export async function conversationForThread(threadTs: string) {
  const [row] = await api.db.db
    .select()
    .from(conversations)
    .where(eq(conversations.externalConversationKey, threadTs));
  return row;
}
