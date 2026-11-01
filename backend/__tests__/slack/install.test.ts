import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import { buildSlackManifest } from "../../ops/SlackManifestOps";
import { auditLogs } from "../../schema/audit_logs";
import { botInstallations } from "../../schema/bot_installations";
import { triggerEvents } from "../../schema/trigger_events";
import { clearLoopQueues, drainQueue } from "../agent/harness";
import { validateManifest } from "../fakes/slack/server";
import { call, HOOK_TIMEOUT } from "../setup";
import {
  buildSlackStage,
  completeInstall,
  resetSlack,
  type SlackStage,
} from "./harness";

/**
 * Creating a bot's Slack app (both paths), installing it by OAuth, and the
 * ingress every Slack delivery goes through: v0 signatures, the handshake,
 * retries, and the byte-identical refusal.
 */
let stage: SlackStage;

beforeAll(async () => {
  stage = await buildSlackStage();
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  await resetSlack();
  expect(stage.slack.requests.filter((r) => !r.valid)).toEqual([]);
  stage.slack.reset();
});

afterAll(async () => {
  config.platforms.slack.apiUrl = stage.apiUrl;
  await stage.slack.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/** The stage's installation row. */
async function installation() {
  const [row] = await api.db.db
    .select()
    .from(botInstallations)
    .where(eq(botInstallations.id, stage.installationId));
  return row;
}

describe("creating and installing the app", () => {
  // Coverage: `slack.app.create`, `slack.oauth.install`.
  test("the config-token path creates the app and OAuth installs it", async () => {
    const row = await installation();
    expect(row).toMatchObject({
      type: "slack",
      status: "active",
      externalWorkspaceId: stage.slack.team.id,
      externalBotUserId: stage.slack.botUserId,
      externalAppId: stage.slack.appId,
    });
    expect(row.config).toMatchObject({
      appId: stage.slack.appId,
      clientId: stage.slack.clientId,
      teamId: stage.slack.team.id,
      teamName: stage.slack.team.name,
    });
    const audit = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.targetType, "bot-installation"))
      .orderBy(auditLogs.id);
    expect(audit.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        "slack:app-create",
        "bot-installation:oauth-callback",
      ]),
    );
    const callback = audit.find(
      (a) => a.action === "bot-installation:oauth-callback",
    );
    expect(callback?.userId).toBe(stage.u.peach.userId);
  });

  // Coverage: `slack.manifest`.
  test("every generated manifest validates against Slack's schema", () => {
    const urls = {
      events: "https://api.hypotenuse.cloud/api/webhooks/slack/hyp_rk_x",
      oauthRedirect:
        "https://api.hypotenuse.cloud/api/installation/oauth/callback",
    };
    for (const bot of [
      {
        displayName: "Toadsworth",
        description: "The castle steward.",
        slug: "toadsworth",
      },
      { displayName: "A".repeat(80), description: "", slug: "long" },
      { displayName: "Ünïcødé 🍄", description: "D".repeat(280), slug: "uni" },
    ]) {
      expect(validateManifest(buildSlackManifest(bot, urls))).toBe(true);
    }
    expect(
      validateManifest({ display_information: { name: "x" }, nope: 1 }),
    ).not.toBe(true);
    // Slack's editor flags an assistant view without this subscription.
    const bare = buildSlackManifest(
      { displayName: "Toadsworth", description: "", slug: "toadsworth" },
      urls,
    ) as { settings: { event_subscriptions: { bot_events: string[] } } };
    bare.settings.event_subscriptions.bot_events =
      bare.settings.event_subscriptions.bot_events.filter(
        (e) => e !== "assistant_thread_started",
      );
    expect(validateManifest(bare)).toContain("assistant_thread_started");
  });

  // Coverage: `slack.manifest`.
  test("the manifest action answers Slack's manifest with the events URL and a pre-filled creation link", async () => {
    const res = await call<{
      manifest: { settings: { event_subscriptions: { request_url: string } } };
      urls: { events: string };
      link: string;
    }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}/installation/slack/manifest`,
      { externalWorkspaceId: "manual" },
    );
    expect(res.status).toBe(200);
    expect(res.body.manifest.settings.event_subscriptions.request_url).toBe(
      res.body.urls.events,
    );
    expect(validateManifest(res.body.manifest)).toBe(true);
    const link = new URL(res.body.link);
    expect(link.origin + link.pathname).toBe("https://api.slack.com/apps");
    expect(link.searchParams.get("new_app")).toBe("1");
    expect(JSON.parse(String(link.searchParams.get("manifest_json")))).toEqual(
      res.body.manifest,
    );
  });

  // Coverage: `slack.app.invalid-manifest`.
  test("Slack's invalid_manifest pointers reach the person verbatim", async () => {
    stage.slack.failNext("apps.manifest.create", {
      error: "invalid_manifest",
      extra: {
        errors: [
          {
            message: "Must be 35 characters or fewer",
            pointer: "/display_information/name",
          },
        ],
      },
    });
    const res = await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot/${stage.botId}/slack/app`,
      { configToken: stage.slack.configToken, externalWorkspaceId: "other" },
    );
    expect(res.status).toBe(406);
    expect(res.body.error?.message).toContain(
      "/display_information/name: Must be 35 characters or fewer",
    );
    const refused = await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot/${stage.botId}/slack/app`,
      { configToken: "xoxe.not-the-token", externalWorkspaceId: "other" },
    );
    expect(refused.status).toBe(406);
    expect(refused.body.error?.key).toBe("configToken");
  });

  // Coverage: `slack.app.register`, `slack.out.auth-test`.
  test("the manual path: pasted credentials stay pending until installed; a pasted bot token activates", async () => {
    const workspace = "manual-ws";
    const minted = await call<{ installation: { id: number } }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}/installation/slack/manifest`,
      { externalWorkspaceId: workspace },
    );
    const connect = (credentials: Record<string, unknown>) =>
      call<{
        installation: {
          status: string;
          externalBotUserId: string | null;
          hasCredentials: boolean;
        };
      }>(
        stage.u.url,
        stage.u.peach,
        "PUT",
        `/project/${stage.u.projectId}/bot/${stage.botId}/installation`,
        {
          type: "slack",
          externalWorkspaceId: workspace,
          config: { clientId: stage.slack.clientId, appId: stage.slack.appId },
          credentials,
        },
      );
    const pending = await connect({
      clientSecret: stage.slack.clientSecret,
      signingSecret: stage.slack.signingSecret,
    });
    expect(pending.status).toBe(200);
    expect(pending.body.installation.status).toBe("pending");
    const active = await connect({ botToken: stage.slack.botToken });
    expect(active.body.installation).toMatchObject({
      status: "active",
      externalBotUserId: stage.slack.botUserId,
    });
    const bad = await connect({ botToken: "xoxb-revoked" });
    expect(bad.body.installation.status).toBe("error");
    await call(
      stage.u.url,
      stage.u.peach,
      "DELETE",
      `/project/${stage.u.projectId}/bot-installation/${minted.body.installation.id}`,
    );
  });

  test("an install link works once; an install refused on Slack is recorded", async () => {
    const start = await call<{ url: string }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/bot-installation/${stage.installationId}/oauth?format=json`,
    );
    const back = new URL(stage.slack.approveInstall(start.body.url));
    expect(back.pathname).toBe("/api/installation/oauth/callback");
    const first = await fetch(`${stage.u.url}${back.pathname}${back.search}`, {
      redirect: "manual",
    });
    expect(first.headers.get("location")).toContain("installed=slack");
    const again = await fetch(`${stage.u.url}${back.pathname}${back.search}`, {
      redirect: "manual",
    });
    expect(again.status).toBe(406);
    const refusedStart = await call<{ url: string }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/bot-installation/${stage.installationId}/oauth?format=json`,
    );
    const state = new URL(refusedStart.body.url).searchParams.get("state");
    const denied = await fetch(
      `${stage.u.url}/api/installation/oauth/callback?state=${state}&error=access_denied`,
      { redirect: "manual" },
    );
    expect(denied.headers.get("location")).toContain("installError=");
    expect((await installation()).status).toBe("active");
  });

  test("the OAuth hops are never MCP tools, and an outsider cannot start an install", async () => {
    for (const name of [
      "bot-installation:oauth-start",
      "bot-installation:oauth-callback",
    ]) {
      expect(api.actions.actions.find((a) => a.name === name)?.mcp?.tool).toBe(
        false,
      );
    }
    const res = await call(
      stage.u.url,
      stage.u.bowser,
      "GET",
      `/project/${stage.u.projectId}/bot-installation/${stage.installationId}/oauth?format=json`,
    );
    expect([403, 404]).toContain(res.status);
  });

  test("re-running the install after a reinstall keeps the workspace", async () => {
    const location = await completeInstall(
      stage,
      stage.slack,
      stage.installationId,
    );
    expect(location).toContain("installed=slack");
    expect((await installation()).externalWorkspaceId).toBe(
      stage.slack.team.id,
    );
  });
});

describe("ingress", () => {
  const event = () =>
    stage.slack.envelope(
      {
        type: "app_home_opened",
        user: "U0PEACH",
        channel: "D0DM",
        tab: "messages",
      },
      { eventId: `Ev-${Math.random()}` },
    );

  // Coverage: `slack.in.url-verification`.
  test("url_verification is answered with its challenge, signed or refused", async () => {
    const body = JSON.stringify({
      token: "x",
      challenge: "c-123",
      type: "url_verification",
    });
    const ok = await stage.slack.post(body);
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toEqual({ challenge: "c-123" });
    const forged = await stage.slack.post(body, {
      secret: "not-the-secret-at-all",
    });
    expect(forged.status).toBe(404);
  });

  test("url_verification is answered before install; other events are dropped", async () => {
    await api.db.db
      .update(botInstallations)
      .set({ status: "pending" })
      .where(eq(botInstallations.id, stage.installationId));
    const body = JSON.stringify({
      challenge: "early",
      type: "url_verification",
    });
    expect(JSON.parse((await stage.slack.post(body)).body)).toEqual({
      challenge: "early",
    });
    const dropped = await stage.slack.post(event());
    expect(dropped.status).toBe(200);
    expect(await api.db.db.select().from(triggerEvents)).toHaveLength(0);
  });

  // Coverage: `slack.in.signature`.
  test("signing: valid, stale, wrong secret, the previous secret, an unknown key", async () => {
    expect((await stage.slack.post(event())).status).toBe(200);
    const unknown = await stage.slack.post(event(), {
      url: `${stage.u.url}/api/webhooks/slack/hyp_rk_nobodyhasthiskey`,
    });
    const stale = await stage.slack.post(event(), {
      timestamp: Math.floor(Date.now() / 1000) - 301,
    });
    const future = await stage.slack.post(event(), {
      timestamp: Math.floor(Date.now() / 1000) + 301,
    });
    const wrong = await stage.slack.post(event(), {
      secret: "a-different-secret-entirely",
    });
    expect(unknown.status).toBe(404);
    for (const r of [stale, future, wrong]) {
      expect({ status: r.status, body: r.body }).toEqual({
        status: unknown.status,
        body: unknown.body,
      });
    }
    // Rotation: the old secret still verifies after a new one is connected.
    const old = stage.slack.signingSecret;
    const rotated = await call<{ installation: { status: string } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot/${stage.botId}/installation`,
      {
        type: "slack",
        externalWorkspaceId: stage.slack.team.id,
        config: { clientId: stage.slack.clientId },
        credentials: { signingSecret: "slack-signing-secret-rotated-1" },
      },
    );
    expect(rotated.body.installation.status).toBe("active");
    expect((await stage.slack.post(event(), { secret: old })).status).toBe(200);
    expect(
      (
        await stage.slack.post(event(), {
          secret: "slack-signing-secret-rotated-1",
        })
      ).status,
    ).toBe(200);
    // Put the secret back for the rest of the suite.
    await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot/${stage.botId}/installation`,
      {
        type: "slack",
        externalWorkspaceId: stage.slack.team.id,
        config: { clientId: stage.slack.clientId },
        credentials: { signingSecret: old },
      },
    );
  });

  // Coverage: `slack.in.retry`, `slack.in.app-home`.
  test("a retry with X-Slack-Retry-Num is one event", async () => {
    const body = event();
    expect((await stage.slack.post(body)).status).toBe(200);
    expect((await stage.slack.post(body, { retryNum: 1 })).status).toBe(200);
    expect((await stage.slack.post(body, { retryNum: 2 })).status).toBe(200);
    expect(await api.db.db.select().from(triggerEvents)).toHaveLength(1);
    await drainQueue("ingress");
    const [row] = await api.db.db.select().from(triggerEvents);
    expect(row.outcome).toBe("empty");
  });

  // Coverage: `slack.in.app-home`.
  test("the assistant view's thread events are recorded and change nothing", async () => {
    const before = (await api.db.db.select().from(triggerEvents)).length;
    for (const type of [
      "assistant_thread_started",
      "assistant_thread_context_changed",
    ]) {
      const body = stage.slack.envelope(
        {
          type,
          assistant_thread: {
            user_id: "U0PEACH",
            channel_id: "D0DM",
            thread_ts: "1700000000.000100",
            context: {},
          },
        },
        { eventId: `Ev-${type}` },
      );
      expect((await stage.slack.post(body)).status).toBe(200);
    }
    await drainQueue("ingress");
    const rows = (await api.db.db.select().from(triggerEvents)).slice(before);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.outcome)).toEqual(["empty", "empty"]);
  });

  test("a body past the cap is a 413", async () => {
    const big = JSON.stringify({
      type: "event_callback",
      pad: "x".repeat(1_100_000),
    });
    expect((await stage.slack.post(big)).status).toBe(413);
  });
});
