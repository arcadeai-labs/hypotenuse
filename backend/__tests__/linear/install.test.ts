import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { api, config } from "keryx";
import { openInstallation } from "../../ops/InstallationOps";
import { refreshLinearToken } from "../../ops/LinearOps";
import { botInstallations } from "../../schema/bot_installations";
import { triggerEvents } from "../../schema/trigger_events";
import { clearLoopQueues, drainQueue } from "../agent/harness";
import { lastEvent, settle } from "../channels/harness";
import { call, cookieHeader, HOOK_TIMEOUT, runAction } from "../setup";
import { FINEAR } from "./finear";
import {
  buildLinearStage,
  completeLinearInstall,
  createIssue,
  delegate,
  inject,
  installLinear,
  type LinearApp,
  type LinearStage,
  newestConversation,
  resetLinear,
  sessionOf,
} from "./harness";

/**
 * A bot's own Linear app: its manifest, its install by OAuth with PKCE, the
 * webhook it verifies, the tokens it refreshes — and no Linear credential in
 * any answer, audit row, log line, or stored row outside the sealed column.
 */
let stage: LinearStage;
const logged: string[] = [];
const methods = ["debug", "info", "warn", "error"] as const;
const originals = methods.map((m) => api.logger[m]);

beforeAll(async () => {
  methods.forEach((m, i) => {
    api.logger[m] = ((...args: unknown[]) => {
      logged.push(JSON.stringify(args));
      return (originals[i] as (...a: unknown[]) => unknown).apply(
        api.logger,
        args,
      );
    }) as never;
  });
  stage = await buildLinearStage();
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  await resetLinear();
  stage.models.reset();
});

afterAll(async () => {
  methods.forEach((m, i) => {
    api.logger[m] = originals[i] as never;
  });
  config.platforms.linear.apiUrl = stage.saved.apiUrl;
  config.platforms.linear.authorizeUrl = stage.saved.authorizeUrl;
  await stage.linear.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * The installation row.
 * @param id - The installation.
 * @returns It, with its credentials opened.
 */
async function installationRow(id = stage.app.installationId) {
  const [row] = await api.db.db
    .select()
    .from(botInstallations)
    .where(eq(botInstallations.id, id));
  return openInstallation(row);
}

/** A minimal signed body for the stage's workspace. */
const body = (extra: Record<string, unknown> = {}) => ({
  type: "AppUserNotification",
  action: "issueNewComment",
  organizationId: FINEAR.primary.organization,
  createdAt: new Date().toISOString(),
  notification: { id: crypto.randomUUID(), type: "issueNewComment" },
  ...extra,
});

describe("the app and its install", () => {
  // Coverage: `linear.manifest`.
  test("the manifest: Linear's schema 1.0.0, public, the webhook and its resources, the redirect, and a pre-filled creation link", async () => {
    const minted = await call<{
      manifest: Record<string, never>;
      instructions: string;
      link: string;
      urls: { events: string; oauthRedirect: string };
    }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}/installation/linear/manifest`,
      { externalWorkspaceId: "draft" },
    );
    expect(minted.status).toBe(200);
    const m = minted.body.manifest as Record<string, never>;
    expect(m).toMatchObject({
      schemaVersion: "1.0.0",
      distribution: "public",
      oauth: {
        client_name: "Toadsworth",
        redirect_uris: [minted.body.urls.oauthRedirect],
        grant_types: ["authorization_code", "refresh_token"],
      },
      webhook: {
        enabled: true,
        url: minted.body.urls.events,
        resourceTypes: [
          "AgentSessionEvent",
          "AppUserNotification",
          "PermissionChange",
          "Issue",
        ],
      },
    });
    expect(minted.body.urls.events).toMatch(/\/api\/webhooks\/linear\/hyp_rk_/);
    const link = new URL(minted.body.link);
    expect(link.origin + link.pathname).toBe(
      "https://linear.app/settings/api/applications/new",
    );
    const prefilled = JSON.parse(String(link.searchParams.get("manifest")));
    expect(prefilled).toEqual(m);
    // The suite's server is not public HTTPS, which Linear would refuse: said.
    expect(minted.body.instructions).toContain("is not HTTPS");
  });

  // Coverage: `linear.app.register`, `linear.oauth.install`, `linear.out.viewer`.
  test("connected credentials wait for the install; the install is OAuth with actor=app and PKCE, and records the workspace and the app user", async () => {
    // A second bot, so this test drives a fresh app end to end.
    const bot = await call<{ bot: { id: number } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot`,
      { name: "Kamek", persona: "A careful wizard." },
    );
    stage.linear.clearRequests();
    const app = await installLinear(stage, stage.linear, bot.body.bot.id);
    const inst = await installationRow(app.installationId);
    expect(inst.installation.status).toBe("active");
    expect(inst.installation.externalWorkspaceId).toBe(
      FINEAR.primary.organization,
    );
    expect(inst.installation.externalBotUserId).toBe(app.appUserId);
    expect(inst.installation.config).toMatchObject({
      clientId: app.clientId,
      organizationName: "Workspace 1",
      urlKey: "eng",
    });
    expect(typeof inst.installation.config.accessTokenExpiresAt).toBe("number");
    const token = stage.linear
      .requests()
      .find((r) => r.path === "/oauth/token");
    expect(token?.grantType).toBe("authorization_code");
    expect(token?.formKeys).toContain("code_verifier");

    const start = await call<{ url: string }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/bot-installation/${app.installationId}/oauth?format=json`,
    );
    const url = new URL(start.body.url);
    expect(url.searchParams.get("actor")).toBe("app");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("scope")).toBe(
      "read,write,app:assignable,app:mentionable,issues:create,comments:create",
    );

    const tested = await call<{ ok: boolean }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot-installation/${app.installationId}/test`,
      {},
    );
    expect(tested.body.ok).toBe(true);
  });

  // Coverage: `linear.oauth.denied`.
  test("a person declining the install leaves the installation as it was, with the reason", async () => {
    const landed = await completeLinearInstall(
      stage,
      stage.linear,
      stage.app.installationId,
      "deny",
    );
    expect(landed).toContain("installError=");
    const inst = await installationRow();
    expect(inst.installation.status).toBe("active");
    expect(inst.installation.lastError).toContain("did not install the app");
  });
});

describe("the webhook", () => {
  // Coverage: `linear.in.signature`.
  test("a bad signature and a stale timestamp are the same 404; the previous secret verifies during a rotation", async () => {
    const forged = await inject(stage.app, body(), { secret: "not-the-one" });
    const stale = await inject(stage.app, body(), {
      timestamp: Date.now() - 61_000,
    });
    expect(forged.status).toBe(404);
    expect(stale.status).toBe(404);
    expect(await forged.text()).toBe(await stale.text());
    expect((await api.db.db.select().from(triggerEvents)).length).toBe(0);

    const rotated = `lin-wh-${crypto.randomUUID()}`;
    const connected = await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot/${stage.botId}/installation`,
      {
        type: "linear",
        externalWorkspaceId: FINEAR.primary.organization,
        config: { clientId: stage.app.clientId },
        credentials: {
          clientSecret: stage.app.clientSecret,
          webhookSecret: rotated,
        },
      },
    );
    expect(connected.status).toBe(200);
    expect((await inject(stage.app, body())).status).toBe(200);
    expect((await inject(stage.app, body(), { secret: rotated })).status).toBe(
      200,
    );
    // Connecting again kept the install's tokens, and the old secret as the previous one.
    const inst = await installationRow();
    expect(inst.installation.status).toBe("active");
    expect(inst.credentials.webhookSecretPrevious).toBe(
      stage.app.webhookSecret,
    );
    expect(typeof inst.credentials.accessToken).toBe("string");
  });

  // Coverage: `linear.in.dedupe`, `linear.in.unknown-workspace`, `linear.in.body-cap`.
  test("a retried delivery is one event; another workspace is 200 and recorded unknown; a body past the cap is 413", async () => {
    const delivery = crypto.randomUUID();
    const one = body();
    expect((await inject(stage.app, one, { delivery })).status).toBe(200);
    expect((await inject(stage.app, one, { delivery })).status).toBe(200);
    expect((await api.db.db.select().from(triggerEvents)).length).toBe(1);

    const other = await inject(
      stage.app,
      body({ organizationId: FINEAR.secondary.organization }),
    );
    expect(other.status).toBe(200);
    await drainQueue("ingress");
    expect((await lastEvent()).outcome).toBe("unknown-installation");

    const huge = await inject(stage.app, {
      ...body(),
      pad: "x".repeat(config.platforms.maxBodyBytes),
    });
    expect(huge.status).toBe(413);
  });

  // Coverage: `linear.in.inactive`.
  test("an errored installation is answered 200 and the delivery dropped, never refused", async () => {
    await api.db.db
      .update(botInstallations)
      .set({ status: "error" })
      .where(eq(botInstallations.id, stage.app.installationId));
    const res = await inject(stage.app, body());
    expect(res.status).toBe(200);
    expect((await api.db.db.select().from(triggerEvents)).length).toBe(0);
  });

  // Coverage: `linear.multi-bot`.
  test("two bots, two apps, one workspace: each verifies with its own secret, and each session goes to its own bot", async () => {
    const bot = await call<{ bot: { id: number } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot`,
      { name: "Bowser", persona: "Loud." },
    );
    const second: LinearApp = await installLinear(
      stage,
      stage.linear,
      bot.body.bot.id,
    );
    expect(second.appUserId).not.toBe(stage.app.appUserId);
    // Bot A's secret on bot B's URL is refused.
    const crossed = await inject(second, body(), {
      secret: stage.app.webhookSecret,
    });
    expect(crossed.status).toBe(404);

    const issue = await createIssue(stage.linear);
    await delegate(stage, issue.id, second);
    await drainQueue("ingress");
    const conversation = await newestConversation();
    expect(conversation.botId).toBe(second.botId);
    await drainQueue("outbox");
    const session = await sessionOf(
      stage.linear,
      String(conversation.externalConversationKey),
    );
    expect(session.activities.nodes).toHaveLength(1);
  });
});

describe("tokens", () => {
  // Coverage: `linear.tokens.refresh`.
  test("the clock refreshes a token about to expire, rotating both; the new one works", async () => {
    const before = await installationRow();
    await api.db.db
      .update(botInstallations)
      .set({
        config: sql`${botInstallations.config} || ${JSON.stringify({
          accessTokenExpiresAt: Date.now() + 60_000,
        })}::jsonb`,
      })
      .where(eq(botInstallations.id, stage.app.installationId));
    stage.linear.clearRequests();
    const ran = await runAction<{ refreshed: number }>(
      "installations:refresh-tokens",
      {},
    );
    expect(ran.refreshed).toBe(1);
    const after = await installationRow();
    expect(after.credentials.accessToken).not.toBe(
      before.credentials.accessToken,
    );
    expect(after.credentials.refreshToken).not.toBe(
      before.credentials.refreshToken,
    );
    expect(
      Number(after.installation.config.accessTokenExpiresAt),
    ).toBeGreaterThan(Date.now() + 3_600_000);
    expect(
      stage.linear.requests().filter((r) => r.grantType === "refresh_token"),
    ).toHaveLength(1);
    const tested = await call<{ ok: boolean }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot-installation/${stage.app.installationId}/test`,
      {},
    );
    expect(tested.body.ok).toBe(true);
  });

  // Coverage: `linear.tokens.replay`.
  test("a refresh whose answer was lost is replayed with the same refresh token, within Linear's grace", async () => {
    const before = await installationRow();
    stage.linear.fault({
      kind: "drop",
      match: (r) => r.grantType === "refresh_token",
    });
    await expect(
      refreshLinearToken(stage.app.installationId, { force: true }),
    ).rejects.toThrow();
    const kept = await installationRow();
    expect(kept.credentials.refreshToken).toBe(before.credentials.refreshToken);
    expect(kept.installation.status).toBe("active");
    const again = await refreshLinearToken(stage.app.installationId, {
      force: true,
    });
    expect(again.kind).toBe("refreshed");
    const after = await installationRow();
    expect(after.credentials.accessToken).not.toBe(
      before.credentials.accessToken,
    );
  });

  // Coverage: `linear.tokens.invalid-grant`, `linear.tokens.never-revoke`.
  test("invalid_grant marks the installation errored; nothing ever calls Linear's revoke", async () => {
    const inst = await installationRow();
    const { sealCredentials } = await import("../../ops/InstallationOps");
    await api.db.db
      .update(botInstallations)
      .set({
        credentials: sealCredentials({
          ...inst.credentials,
          refreshToken: "not-a-refresh-token",
        }),
      })
      .where(eq(botInstallations.id, stage.app.installationId));
    const r = await refreshLinearToken(stage.app.installationId, {
      force: true,
    });
    expect(r.kind).toBe("refused");
    const after = await installationRow();
    expect(after.installation.status).toBe("error");
    expect(after.installation.lastError).toContain("Install it again");
    // Put the working install back for the next test.
    const landed = await completeLinearInstall(
      stage,
      stage.linear,
      stage.app.installationId,
    );
    expect(landed).toContain("installed=linear");
    expect(
      stage.linear.requests().some((q) => q.path === "/oauth/revoke"),
    ).toBe(false);
  });
});

describe("no Linear credential leaves the server", () => {
  // Coverage: `linear.secrets`.
  test("no answer, audit row, stored row outside the sealed column, or log line carries one", async () => {
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Hi." } }] },
    ]);
    const issue = await createIssue(stage.linear);
    await delegate(stage, issue.id);
    await settle();
    const inst = await installationRow();
    const secrets = {
      clientSecret: stage.app.clientSecret,
      webhookSecret: stage.app.webhookSecret,
      accessToken: String(inst.credentials.accessToken),
      refreshToken: String(inst.credentials.refreshToken),
    };
    const clean = (where: string, text: string) => {
      for (const [name, value] of Object.entries(secrets)) {
        expect(text.includes(value), `${where}: ${name}`).toBe(false);
      }
    };
    const p = `/project/${stage.u.projectId}`;
    for (const path of [
      `${p}/bot/${stage.botId}/installations`,
      `${p}/bot-installation/${stage.app.installationId}`,
      `${p}/channels?botId=${stage.botId}`,
      `${p}/trigger-events`,
      `${p}/participants`,
      `${p}/audit`,
    ]) {
      const res = await fetch(`${stage.u.url}/api${path}`, {
        headers: cookieHeader(stage.u.peach.sessionId),
      });
      expect(res.status, path).toBe(200);
      clean(path, await res.text());
    }
    for (const table of [
      "audit_logs",
      "trigger_events",
      "outbox_messages",
      "channels",
      "participants",
      "conversations",
      "bot_installations",
    ]) {
      const rows = await api.db.db.execute(
        sql.raw(`select row_to_json(t)::text as j from ${table} t`),
      );
      clean(table, JSON.stringify(rows.rows));
    }
    clean("logs", logged.join("\n"));
  });
});
