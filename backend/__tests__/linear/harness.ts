import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import { LINEAR_SCOPES } from "../../ops/LinearManifestOps";
import { linearSignature } from "../../platforms/linear/adapter";
import { botInstallations } from "../../schema/bot_installations";
import { channelBindings } from "../../schema/channel_bindings";
import { conversations } from "../../schema/conversations";
import { outboxMessages } from "../../schema/outbox_messages";
import { triggerEvents } from "../../schema/trigger_events";
import { type AgentStage, buildAgentStage, drainQueue } from "../agent/harness";
import { settle } from "../channels/harness";
import { call } from "../setup";
import { FINEAR, type Finear, startFinear } from "./finear";

/**
 * The Linear suites' stage: the agent stage (a scripted model, a bot in
 * Castle), finear as Linear, and the bot's own Linear app — its manifest
 * minted, the app registered on finear with the manifest's webhook, its
 * credentials connected, and installed by OAuth with PKCE through finear's
 * consent screen — all over HTTP, as a person would.
 */
export interface LinearStage extends AgentStage {
  linear: Finear;
  /** The bot's Linear app. */
  app: LinearApp;
  /** The config values to put back after the suite. */
  saved: { apiUrl: string; authorizeUrl: string };
}

/** One bot's Linear app, as registered on finear. */
export interface LinearApp {
  botId: number;
  installationId: number;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  /** The app user's id in finear's workspace. */
  appUserId: string;
  /** The webhook URL, on the server under test. */
  webhookUrl: string;
}

/** The webhook resource types finear delivers to an app. */
const RESOURCE_TYPES = ["Issue"];

/**
 * Build the stage.
 * @returns The stage.
 */
export async function buildLinearStage(): Promise<LinearStage> {
  const stage = await buildAgentStage("anthropic");
  const linear = await startFinear();
  const saved = {
    apiUrl: config.platforms.linear.apiUrl,
    authorizeUrl: config.platforms.linear.authorizeUrl,
  };
  config.platforms.linear.apiUrl = linear.url;
  config.platforms.linear.authorizeUrl = `${linear.url}/oauth/authorize`;
  const app = await installLinear(stage, linear, stage.botId);
  return { ...stage, linear, app, saved };
}

/**
 * Create a bot's Linear app and install it, end to end.
 * Coverage: `linear.manifest`, `linear.app.register`, `linear.oauth.install`.
 * @param stage - The stage.
 * @param linear - finear.
 * @param botId - The bot.
 * @returns The app.
 */
export async function installLinear(
  stage: AgentStage,
  linear: Finear,
  botId: number,
): Promise<LinearApp> {
  const minted = await call<{
    installation: { id: number };
    urls: { events: string; oauthRedirect: string };
  }>(
    stage.u.url,
    stage.u.peach,
    "POST",
    `/project/${stage.u.projectId}/bot/${botId}/installation/linear/manifest`,
    {},
  );
  if (minted.status !== 200) throw new Error(JSON.stringify(minted.body));
  const events = new URL(minted.body.urls.events);
  const webhookUrl = `${stage.u.url}${events.pathname}`;
  const clientId = crypto.randomUUID();
  const clientSecret = `lin-secret-${crypto.randomUUID()}`;
  const webhookSecret = `lin-wh-${crypto.randomUUID()}`;
  linear.register({
    id: clientId,
    name: `Bot ${botId}`,
    secret: clientSecret,
    redirectUris: [minted.body.urls.oauthRedirect],
    scopes: [...LINEAR_SCOPES],
    webhook: {
      url: webhookUrl,
      secret: webhookSecret,
      resourceTypes: RESOURCE_TYPES,
      agentSessionEvents: true,
    },
  });
  const connected = await call(
    stage.u.url,
    stage.u.peach,
    "PUT",
    `/project/${stage.u.projectId}/bot/${botId}/installation`,
    {
      type: "linear",
      config: { clientId },
      credentials: { clientSecret, webhookSecret },
    },
  );
  if (connected.status !== 200) throw new Error(JSON.stringify(connected.body));
  const installationId = minted.body.installation.id;
  const landed = await completeLinearInstall(stage, linear, installationId);
  if (!landed.includes("installed=linear")) {
    throw new Error(`The install did not complete: ${landed}`);
  }
  const [row] = await api.db.db
    .select()
    .from(botInstallations)
    .where(eq(botInstallations.id, installationId));
  return {
    botId,
    installationId,
    clientId,
    clientSecret,
    webhookSecret,
    appUserId: String(row.externalBotUserId),
    webhookUrl,
  };
}

/**
 * Run the OAuth hops: start, the person consents on finear, and the browser
 * lands on the callback.
 * @param stage - The stage.
 * @param linear - finear.
 * @param installationId - The installation.
 * @param decision - What the person chooses.
 * @returns Where the callback sent the browser.
 */
export async function completeLinearInstall(
  stage: AgentStage,
  linear: Finear,
  installationId: number,
  decision: "allow" | "deny" = "allow",
): Promise<string> {
  const start = await call<{ url: string }>(
    stage.u.url,
    stage.u.peach,
    "GET",
    `/project/${stage.u.projectId}/bot-installation/${installationId}/oauth?format=json`,
  );
  if (start.status !== 200) throw new Error(JSON.stringify(start.body));
  const back = new URL(await linear.consent(start.body.url, decision));
  const res = await fetch(`${stage.u.url}${back.pathname}${back.search}`, {
    redirect: "manual",
  });
  if (res.status !== 302) throw new Error(await res.text());
  return String(res.headers.get("location"));
}

/** The fixture person's credential on finear. */
export const HUMAN = FINEAR.primaryKey;

/**
 * Create an issue as the fixture person.
 * @param linear - finear.
 * @param input - The issue's fields beyond its team and title.
 * @returns The issue's id and identifier.
 */
export async function createIssue(
  linear: Finear,
  input: Record<string, unknown> = {},
): Promise<{ id: string; identifier: string }> {
  const r = await linear.graphql<{
    issueCreate: { issue: { id: string; identifier: string } };
  }>(
    HUMAN,
    `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier } }
    }`,
    {
      input: {
        teamId: FINEAR.primary.team,
        title: "Find the cake",
        description: "Someone hid the cake. Find it.",
        ...input,
      },
    },
  );
  if (!r.data) throw new Error(JSON.stringify(r.errors));
  return r.data.issueCreate.issue;
}

/**
 * Create a project in the fixture team, as the fixture person.
 * @param linear - finear.
 * @param name - Its name.
 * @returns Its id.
 */
export async function createProject(
  linear: Finear,
  name: string,
): Promise<string> {
  const r = await linear.graphql<{
    projectCreate: { project: { id: string } };
  }>(
    HUMAN,
    `mutation CreateProject($input: ProjectCreateInput!) {
      projectCreate(input: $input) { success project { id } }
    }`,
    { input: { name, teamIds: [FINEAR.primary.team] } },
  );
  if (!r.data) throw new Error(JSON.stringify(r.errors));
  return r.data.projectCreate.project.id;
}

/**
 * Update an issue as the fixture person.
 * @param linear - finear.
 * @param id - The issue.
 * @param input - The change.
 */
export async function updateIssue(
  linear: Finear,
  id: string,
  input: Record<string, unknown>,
): Promise<void> {
  const r = await linear.graphql(
    HUMAN,
    `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success }
    }`,
    { id, input },
  );
  if (r.errors) throw new Error(JSON.stringify(r.errors));
}

/**
 * Delegate an issue to a bot's app as the fixture person; Linear opens an
 * agent session and delivers `created`.
 * @param stage - The stage.
 * @param issueId - The issue.
 * @param app - Whose app (the stage's by default).
 */
export async function delegate(
  stage: LinearStage,
  issueId: string,
  app: LinearApp = stage.app,
): Promise<void> {
  await updateIssue(stage.linear, issueId, { delegateId: app.appUserId });
  await stage.linear.drain();
}

/**
 * Read a session as finear holds it: its status, plan, and activities.
 * @param linear - finear.
 * @param sessionId - The session.
 * @returns The session.
 */
export async function sessionOf(linear: Finear, sessionId: string) {
  const r = await linear.graphql<{
    agentSession: {
      id: string;
      status: string;
      plan: { content: string; status: string }[] | null;
      issue: { id: string; state: { type: string } };
      activities: {
        nodes: {
          id: string;
          ephemeral: boolean;
          signal: string | null;
          signalMetadata: Record<string, unknown> | null;
          content: {
            __typename: string;
            body?: string;
            action?: string;
            parameter?: string;
            result?: string;
          };
        }[];
      };
    };
  }>(
    HUMAN,
    `query Session($id: String!) {
      agentSession(id: $id) {
        id status plan
        issue { id state { type } }
        activities {
          nodes {
            id ephemeral signal signalMetadata
            content {
              __typename
              ... on AgentActivityThoughtContent { body }
              ... on AgentActivityActionContent { action parameter result }
              ... on AgentActivityElicitationContent { body }
              ... on AgentActivityResponseContent { body }
              ... on AgentActivityErrorContent { body }
              ... on AgentActivityPromptContent { body }
            }
          }
        }
      }
    }`,
    { id: sessionId },
  );
  if (!r.data) throw new Error(JSON.stringify(r.errors));
  // Linear's JSON scalar arrives as a string.
  const json = <T>(v: unknown): T =>
    (typeof v === "string" ? JSON.parse(v) : v) as T;
  const s = r.data.agentSession;
  return {
    ...s,
    plan: json<typeof s.plan>(s.plan),
    activities: {
      nodes: s.activities.nodes.map((n) => ({
        ...n,
        signalMetadata: json<typeof n.signalMetadata>(n.signalMetadata),
      })),
    },
  };
}

/**
 * Sign and deliver a body finear cannot send (an `AppUserNotification`, a
 * `PermissionChange`, a `remove`), with the app's real secret, as Linear
 * would.
 * @param app - The app whose webhook it goes to.
 * @param body - The body, without its `webhookTimestamp`.
 * @param opts.secret - Sign with another secret.
 * @param opts.timestamp - Another `webhookTimestamp`.
 * @param opts.delivery - The `Linear-Delivery` id.
 * @returns The response.
 */
export async function inject(
  app: LinearApp,
  body: Record<string, unknown>,
  opts: { secret?: string; timestamp?: number; delivery?: string } = {},
): Promise<Response> {
  const text = JSON.stringify({
    ...body,
    webhookTimestamp: opts.timestamp ?? Date.now(),
  });
  const bytes = new TextEncoder().encode(text);
  return fetch(app.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "linear-delivery": opts.delivery ?? crypto.randomUUID(),
      "linear-signature": linearSignature(
        opts.secret ?? app.webhookSecret,
        bytes,
      ),
    },
    body: text,
  });
}

/**
 * Let finear deliver, then run the pipeline until it settles.
 * @param stage - The stage.
 */
export async function flow(stage: LinearStage): Promise<void> {
  await stage.linear.drain();
  await settle();
  await stage.linear.drain();
  await settle();
}

/**
 * Process ingress and deliver the outbox, without running ticks.
 */
export async function ingestOnly(): Promise<void> {
  await drainQueue("ingress");
  await drainQueue("outbox");
}

/**
 * Empty the channel tables between tests, keeping the installation active.
 */
export async function resetLinear(): Promise<void> {
  await api.db.db.delete(triggerEvents);
  await api.db.db.delete(outboxMessages);
  await api.db.db.delete(channelBindings);
  await api.db.db.delete(conversations);
  await api.db.db
    .update(botInstallations)
    .set({ status: "active", lastError: null });
  for (const key of [
    ...(await api.redis.redis.keys("rate:bot:*")),
    ...(await api.redis.redis.keys("linear:bucket:*")),
    ...(await api.redis.redis.keys("linear:refresh:*")),
  ]) {
    await api.redis.redis.del(key);
  }
}

/**
 * The bot's conversation for a session.
 * @param sessionId - The session.
 * @returns The conversation, or `undefined`.
 */
export async function conversationForSession(sessionId: string) {
  const [row] = await api.db.db
    .select()
    .from(conversations)
    .where(eq(conversations.externalConversationKey, sessionId));
  return row;
}

/**
 * The newest conversation (the session a delegation just opened).
 * @returns The conversation.
 */
export async function newestConversation() {
  const rows = await api.db.db
    .select()
    .from(conversations)
    .orderBy(conversations.id);
  return rows[rows.length - 1];
}
