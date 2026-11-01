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
import { pylonSignature } from "../../platforms/pylon/adapter";
import { approvals } from "../../schema/approvals";
import { botInstallations } from "../../schema/bot_installations";
import { conversationEntries } from "../../schema/conversation_entries";
import { triggerEvents } from "../../schema/trigger_events";
import { clearLoopQueues, drainQueue } from "../agent/harness";
import { call, HOOK_TIMEOUT } from "../setup";
import {
  buildPylonStage,
  conversationForIssue,
  editPylonSettings,
  flow,
  type PylonStage,
  resetPylon,
} from "./harness";

/**
 * Connecting a bot to Pylon and taking its deliveries: the manifest a Pylon
 * admin follows, the token checked at once (its identity, its region), the
 * V2 signature and its clock, the legacy signature only on request, the one
 * byte-identical 404, credentials that never come back — and the Pylon
 * tools, each held to the conversation's own issue and customer.
 */
let stage: PylonStage;

beforeAll(async () => {
  stage = await buildPylonStage();
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  await resetPylon();
  expect(stage.models.expectationFailures).toEqual([]);
  expect(stage.pylon.requests.filter((r) => !r.valid)).toEqual([]);
  stage.models.reset();
  stage.pylon.clearRequests();
  stage.pylon.webhook = {
    url: stage.conn.webhookUrl,
    secret: stage.conn.webhookSecret,
    legacy: false,
  };
  await editPylonSettings(stage, {
    legacySignature: false,
    customerReplyPolicy: "never",
  });
});

afterAll(async () => {
  config.platforms.pylon.apiUrlUs = stage.saved.apiUrlUs;
  config.platforms.pylon.apiUrlEu = stage.saved.apiUrlEu;
  await stage.pylon.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/** The installation, as the dashboard reads it. */
async function view() {
  return call<{ installation: Record<string, unknown> }>(
    stage.u.url,
    stage.u.peach,
    "GET",
    `/project/${stage.u.projectId}/bot-installation/${stage.conn.installationId}`,
  );
}

/**
 * Post a body to the bot's webhook, signed as Pylon signs.
 * @param body - The body.
 * @param opts - Another secret, timestamp, or URL.
 * @returns The status and body.
 */
async function post(
  body: string,
  opts: {
    secret?: string;
    timestamp?: number;
    url?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const ts = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const res = await fetch(opts.url ?? stage.conn.webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-pylon-timestamp": ts,
      "x-pylon-signature-v2": pylonSignature(
        opts.secret ?? stage.conn.webhookSecret,
        ts,
        body,
      ),
      ...(opts.headers ?? {}),
    },
    body,
  });
  return { status: res.status, body: await res.text() };
}

describe("connecting", () => {
  // Coverage: `pylon.manifest`, `pylon.connect`, `pylon.out.me`, `pylon.secrets`.
  test("the manifest names the token, the webhook, and four Triggers; the token is checked and its identity kept; no secret comes back", async () => {
    const minted = await call<{
      manifest: {
        webhook: { url: string };
        triggers: { kickoff: string; body: string }[];
      };
      instructions: string;
    }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}/installation/pylon/manifest`,
      { externalWorkspaceId: "second" },
    );
    expect(minted.status).toBe(200);
    expect(minted.body.instructions).toContain("own identity");
    expect(minted.body.manifest.triggers.map((t) => t.kickoff)).toEqual([
      "New issue created",
      "Issue has a new message",
      "Issue assigned",
      "Issue status changed",
    ]);
    // Ids only: nothing a template could paste that breaks the JSON.
    for (const t of minted.body.manifest.triggers) {
      expect(t.body).toContain('"issue_id": "{{ issue.id }}"');
      expect(t.body).not.toContain("title");
    }
    const [row] = await api.db.db
      .select()
      .from(botInstallations)
      .where(eq(botInstallations.id, stage.conn.installationId));
    expect(row.status).toBe("active");
    expect(row.externalBotUserId).toBe(stage.conn.userId);
    expect(row.config).toMatchObject({
      region: "us",
      selfName: "Toadsworth",
      organizationId: stage.pylon.org.id,
      customerReplyPolicy: "never",
    });
    const seen = await view();
    const dump = JSON.stringify(seen.body);
    expect(dump).not.toContain(stage.conn.token);
    expect(dump).not.toContain(stage.conn.webhookSecret);
    expect(seen.body.installation.hasCredentials).toBe(true);
  });

  // Coverage: `pylon.region`.
  test("a token for the other region is refused with the region to use; an EU token works at the EU origin", async () => {
    const eu = stage.pylon.createToken("Toadsworth EU", "eu");
    const minted = await call<{ installation: { id: number } }>(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}/installation/pylon/manifest`,
      { externalWorkspaceId: "europe" },
    );
    const connect = (region: string) =>
      call<{ installation: { status: string; lastError: string | null } }>(
        stage.u.url,
        stage.u.peach,
        "PUT",
        `/project/${stage.u.projectId}/bot/${stage.botId}/installation`,
        {
          type: "pylon",
          externalWorkspaceId: "europe",
          config: { region },
          credentials: { apiToken: eu.token, webhookSecret: "eu-secret-123" },
        },
      );
    const wrong = await connect("us");
    expect(wrong.body.installation.status).toBe("error");
    expect(wrong.body.installation.lastError).toContain('region "eu"');
    const right = await connect("eu");
    expect(right.body.installation.status).toBe("active");
    await api.db.db
      .delete(botInstallations)
      .where(eq(botInstallations.id, minted.body.installation.id));
  });

  // Coverage: `pylon.connect.refused`.
  test("a token Pylon refuses leaves the installation errored with Pylon's reason", async () => {
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}/installation/pylon/manifest`,
      { externalWorkspaceId: "broken" },
    );
    const res = await call<{
      installation: { status: string; lastError: string };
    }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot/${stage.botId}/installation`,
      {
        type: "pylon",
        externalWorkspaceId: "broken",
        config: { region: "us" },
        credentials: {
          apiToken: "pylon_not_a_token",
          webhookSecret: "whatever-1",
        },
      },
    );
    expect(res.body.installation.status).toBe("error");
    expect(res.body.installation.lastError).toContain("invalid_api_token");
    await api.db.db
      .delete(botInstallations)
      .where(eq(botInstallations.externalWorkspaceId, "broken"));
  });
});

describe("ingress", () => {
  // Coverage: `pylon.in.signature`, `pylon.in.refusal`.
  test("a stale timestamp, the wrong secret, no signature, and an unknown key get one byte-identical 404", async () => {
    const body = JSON.stringify({ event: "issue_created", issue_id: "x" });
    const good = await post(body);
    expect(good.status).toBe(200);
    const stale = await post(body, {
      timestamp: Math.floor(Date.now() / 1000) - 400,
    });
    const forged = await post(body, { secret: "not-the-secret" });
    const unsigned = await fetch(stage.conn.webhookUrl, {
      method: "POST",
      body,
    }).then(async (r) => ({ status: r.status, body: await r.text() }));
    const unknown = await post(body, {
      url: stage.conn.webhookUrl.replace(/hyp_rk_[^/]+$/, "hyp_rk_nope"),
    });
    expect(stale.status).toBe(404);
    for (const r of [forged, unsigned, unknown]) expect(r).toEqual(stale);
    // A legacy body-only signature is refused unless the bot accepts it.
    const legacyHeaders = {
      "x-pylon-signature": (await import("node:crypto"))
        .createHmac("sha256", stage.conn.webhookSecret)
        .update(body)
        .digest("hex"),
    };
    const legacy = await fetch(stage.conn.webhookUrl, {
      method: "POST",
      headers: legacyHeaders,
      body,
    });
    expect(legacy.status).toBe(404);
  });

  // Coverage: `pylon.in.legacy`, `pylon.in.retry`.
  test("the legacy signature works once accepted; Pylon's retries of one delivery are one event", async () => {
    await editPylonSettings(stage, { legacySignature: true });
    stage.pylon.webhook = {
      url: stage.conn.webhookUrl,
      secret: stage.conn.webhookSecret,
      legacy: true,
    };
    stage.models.play([
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "Findings." } }],
      },
    ]);
    const issue = stage.pylon.openIssue({
      contactId: stage.acme.contactId,
      title: "Legacy",
      body: "Signed the old way",
    });
    await flow(stage);
    expect(await conversationForIssue(issue.id)).toBeDefined();
    // A retry (new timestamp, same body) records nothing new.
    stage.pylon.webhook.legacy = false;
    const body = JSON.stringify({
      event: "issue_status_changed",
      issue_id: issue.id,
      status: "on_hold",
      assignee_id: "",
      message_id: "",
    });
    const before = (await api.db.db.select().from(triggerEvents)).length;
    expect((await post(body)).status).toBe(200);
    expect(
      (await post(body, { headers: { "x-pylon-retry-number": "1" } })).status,
    ).toBe(200);
    expect((await api.db.db.select().from(triggerEvents)).length).toBe(
      before + 1,
    );
  });

  // Coverage: `pylon.in.unknown`.
  test("an event Hypotenuse does not read, or an issue Pylon no longer has, is recorded and starts nothing", async () => {
    await post(JSON.stringify({ event: "issue_tags_changed", issue_id: "x" }));
    await post(
      JSON.stringify({ event: "issue_created", issue_id: "no-such-issue" }),
    );
    await drainQueue("ingress");
    const outcomes = (await api.db.db.select().from(triggerEvents)).map(
      (e) => e.outcome,
    );
    expect(outcomes).toContain("issue-not-found");
  });
});

describe("tools", () => {
  // Coverage: `pylon.tool.account_view`, `pylon.tool.account_issues`, `pylon.tool.contact_view`.
  test("the customer's account, issues, and contacts — and never another customer's contact", async () => {
    stage.models.play([
      { toolCalls: [{ name: "pylon_account_view", input: {} }] },
      { toolCalls: [{ name: "pylon_account_issues", input: {} }] },
      {
        toolCalls: [
          {
            name: "pylon_contact_view",
            input: { contactId: stage.acme.contactId },
          },
        ],
      },
      {
        toolCalls: [
          {
            name: "pylon_contact_view",
            input: { contactId: stage.globex.contactId },
          },
        ],
      },
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Done." } }] },
    ]);
    const issue = stage.pylon.openIssue({
      contactId: stage.acme.contactId,
      title: "Who are we?",
      body: "Tell me about my account.",
    });
    await flow(stage);
    const conversation = await conversationForIssue(issue.id);
    const results = await api.db.db
      .select()
      .from(conversationEntries)
      .where(eq(conversationEntries.conversationId, conversation.id))
      .orderBy(conversationEntries.seq);
    const out = (name: string) =>
      results
        .filter((r) => r.kind === "tool_result" && r.toolName === name)
        .map((r) => JSON.stringify(r.content));
    expect(out("pylon_account_view")[0]).toContain("Acme Rockets");
    expect(out("pylon_account_issues")[0]).toContain("Who are we?");
    const [mine, theirs] = out("pylon_contact_view");
    expect(mine).toContain("pat@acme.test");
    expect(theirs).toContain("other_account");
    expect(theirs).not.toContain("globex.test");
  });

  // Coverage: `pylon.tool.issue_update`.
  test("an issue update waits for an approval, then runs once", async () => {
    stage.models.play([
      {
        toolCalls: [
          {
            name: "pylon_issue_update",
            input: { state: "waiting_on_customer", tags: ["needs-info"] },
          },
        ],
      },
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Updated." } }] },
    ]);
    const issue = stage.pylon.openIssue({
      contactId: stage.acme.contactId,
      title: "Missing details",
      body: "It broke.",
    });
    await flow(stage);
    const [approval] = await api.db.db.select().from(approvals);
    expect(approval.tool).toBe("issue_update");
    expect(stage.pylon.issues.get(issue.id)?.state).toBe("new");
    stage.pylon.teammateWrites(
      issue.id,
      stage.teammate,
      `approve ${approval.id}`,
    );
    await flow(stage);
    expect(stage.pylon.issues.get(issue.id)?.state).toBe("waiting_on_customer");
    expect(stage.pylon.issues.get(issue.id)?.tags).toEqual(["needs-info"]);
    const patches = stage.pylon.requests.filter((r) => r.method === "PATCH");
    expect(patches).toHaveLength(1);
  });
});
