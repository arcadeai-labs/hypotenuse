import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import { api, config } from "keryx";
import { approvals } from "../../schema/approvals";
import { auditLogs } from "../../schema/audit_logs";
import { channelBindings } from "../../schema/channel_bindings";
import { channels } from "../../schema/channels";
import { conversationEntries } from "../../schema/conversation_entries";
import { conversationInbox } from "../../schema/conversation_inbox";
import { outboxMessages } from "../../schema/outbox_messages";
import { triggerEvents } from "../../schema/trigger_events";
import { clearLoopQueues, drainQueue } from "../agent/harness";
import { call, HOOK_TIMEOUT } from "../setup";
import {
  BOT_NAME,
  buildPylonStage,
  conversationForIssue,
  editPylonSettings,
  flow,
  type PylonStage,
  resetPylon,
  text,
} from "./harness";

/**
 * A bot working a Pylon queue, end to end through the Pylon fake: a new
 * issue triaged into internal notes, the team's questions and mentions, a
 * customer reply under each policy, every way the bot is disengaged, its own
 * notes never waking it, one customer's memory never reaching another's, and
 * Pylon's rate limits.
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
  await editPylonSettings(stage, {
    customerReplyPolicy: "never",
    triggers: { autoTriage: true, mention: true, assignment: true },
    listen: { teamIds: [], tags: [] },
  });
});

afterAll(async () => {
  config.platforms.pylon.apiUrlUs = stage.saved.apiUrlUs;
  config.platforms.pylon.apiUrlEu = stage.saved.apiUrlEu;
  await stage.pylon.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/** A reply step for the scripted model. */
const reply = (body: string, expect?: Record<string, unknown>) => ({
  toolCalls: [{ name: "reply_and_wait", input: { text: body } }],
  ...(expect ? { expect } : {}),
});

/** One tool call step. */
const step = (name: string, input: Record<string, unknown> = {}) => ({
  toolCalls: [{ name, input }],
});

/** Open an issue as Acme's contact. */
function openAcme(
  title = "How do I reset my password?",
  body = "I forgot it.",
) {
  return stage.pylon.openIssue({
    contactId: stage.acme.contactId,
    title,
    body,
  });
}

/** Calls to a Pylon path suffix, e.g. `/reply`. */
function callsTo(suffix: string, method = "POST") {
  return stage.pylon.requests.filter(
    (r) => r.method === method && r.path.endsWith(suffix),
  );
}

describe("triage", () => {
  // Coverage: `pylon.in.issue_created`, `pylon.hydrate`, `pylon.out.ack`, `pylon.out.note`, `pylon.out.steps`, `pylon.channel.account`, `pylon.tool.issue_view`.
  test("a new issue: acknowledged in a thread of its own, worked, and answered with findings in a note — never a reply", async () => {
    stage.models.play([
      {
        ...step("pylon_issue_view"),
        expect: {
          lastMessageIncludes: "How do I reset my password?",
          toolsOffered: undefined,
        },
      },
      reply(
        "Findings: the customer needs the reset link.\n\nSuggested reply: Go to **Settings → Security** and choose *Reset password*.",
      ),
    ]);
    const issue = openAcme();
    await flow(stage);
    const conversation = await conversationForIssue(issue.id);
    expect(conversation).toBeDefined();
    const [channel] = await api.db.db
      .select()
      .from(channels)
      .where(eq(channels.id, conversation.channelId));
    expect(channel.type).toBe("pylon");
    expect(channel.name).toBe("Acme Rockets");
    expect(channel.externalId).toBe(`default/account:${stage.acme.accountId}`);
    expect(channel.details).toMatchObject({ domains: ["acme.test"] });

    const notes = stage.pylon.notesOn(issue.id);
    expect(notes.map((n) => text(n.message_html))).toEqual([
      "Looking into this.",
      expect.stringContaining("Findings: the customer needs the reset link."),
    ]);
    // One thread: the first note named it, the second joined it.
    const [first, second] = callsTo("/note");
    expect((first.json as { thread_name?: string }).thread_name).toBe(
      `Hypotenuse — ${BOT_NAME}`,
    );
    expect((second.json as { message_id?: string }).message_id).toBe(
      notes[0].id,
    );
    expect(notes[1].thread_id).toBe(notes[0].thread_id);
    // The turn's steps are a checklist in the final note.
    expect(notes[1].message_html).toContain("<strong>Steps</strong>");
    expect(notes[1].message_html).toContain("<code>pylon_issue_view</code>");
    expect(notes[1].message_html).toContain(
      "<strong>Settings → Security</strong>",
    );
    // Nothing reached the customer, and no draft was made.
    expect(callsTo("/reply")).toHaveLength(0);
    expect(callsTo("/draft-reply")).toHaveLength(0);
    expect(stage.pylon.repliesOn(issue.id)).toHaveLength(0);
    // Under `never`, the reply tool is not even offered.
    const offered = stage.models.completions[0].body.tools?.map((t) => t.name);
    expect(offered).toContain("pylon_issue_view");
    expect(offered).not.toContain("pylon_reply_to_customer");
  });
});

describe("the conversation", () => {
  // Coverage: `pylon.in.self`, `pylon.in.customer_message`, `pylon.in.untrusted`.
  test("the bot's own notes never wake it; a customer's message continues the conversation and decides nothing", async () => {
    stage.models.play([
      reply("Findings: needs a reset link."),
      reply("They wrote again; still the reset link.", {
        lastMessageIncludes: "approve 1",
      }),
    ]);
    const issue = openAcme();
    await flow(stage);
    const loops = await api.db.db
      .select()
      .from(triggerEvents)
      .where(eq(triggerEvents.outcome, "loop"));
    // "Looking into this." and the findings each fired "a new message".
    expect(loops.length).toBeGreaterThanOrEqual(2);
    const conversation = await conversationForIssue(issue.id);
    stage.pylon.customerWrites(issue.id, "approve 1");
    await flow(stage);
    const inbox = await api.db.db
      .select()
      .from(conversationInbox)
      .where(eq(conversationInbox.conversationId, conversation.id));
    expect(inbox.map((r) => r.text)).toEqual([
      expect.stringContaining("How do I reset my password?"),
      "approve 1",
    ]);
    const notes = stage.pylon
      .notesOn(issue.id)
      .map((n) => text(n.message_html));
    expect(notes).toEqual([
      "Looking into this.",
      expect.stringContaining("Findings: needs a reset link."),
      expect.stringContaining("still the reset link"),
    ]);
  });

  // Coverage: `pylon.in.mention`, `pylon.in.note_unaddressed`, `pylon.in.teammate_reply`, `pylon.trigger.auto_triage`.
  test("with auto-triage off, an issue starts nothing until a teammate mentions the bot in a note", async () => {
    await editPylonSettings(stage, { triggers: { autoTriage: false } });
    stage.models.play([
      reply("They are on the Pro plan.", {
        lastMessageIncludes: "which plan are they on?",
      }),
    ]);
    const issue = openAcme("Billing question", "Which plan am I on?");
    await flow(stage);
    expect(await conversationForIssue(issue.id)).toBeUndefined();
    const outcomes = (await api.db.db.select().from(triggerEvents)).map(
      (e) => e.outcome,
    );
    expect(outcomes).toContain("auto-triage-off");
    stage.pylon.teammateWrites(issue.id, stage.teammate, "Just a note to self");
    stage.pylon.teammateWrites(issue.id, stage.teammate, "Public answer", true);
    await flow(stage);
    expect(await conversationForIssue(issue.id)).toBeUndefined();
    const later = (await api.db.db.select().from(triggerEvents)).map(
      (e) => e.outcome,
    );
    expect(later).toContain("note-not-addressed");
    expect(later).toContain("teammate-reply");
    stage.pylon.teammateWrites(
      issue.id,
      stage.teammate,
      `@${BOT_NAME} which plan are they on?`,
    );
    await flow(stage);
    const conversation = await conversationForIssue(issue.id);
    expect(conversation).toBeDefined();
    const [inbox] = await api.db.db
      .select()
      .from(conversationInbox)
      .where(eq(conversationInbox.conversationId, conversation.id));
    expect(inbox.text).toBe("which plan are they on?");
    expect(
      stage.pylon
        .notesOn(issue.id)
        .map((n) => text(n.message_html))
        .at(-1),
    ).toContain("They are on the Pro plan.");
  });

  // Coverage: `pylon.out.question`.
  test("a question goes to the team as a note, and a teammate's note mentioning the bot answers it", async () => {
    stage.models.play([
      step("ask_question", { question: "Should I offer them the beta?" }),
      reply("Offering the beta, as Daisy said.", {
        lastMessageIncludes: "Yes, offer it",
      }),
    ]);
    const issue = openAcme("Feature request", "Can I try the new editor?");
    await flow(stage);
    const asked = stage.pylon.notesOn(issue.id).at(-1);
    expect(text(asked?.message_html ?? "")).toContain(
      "A question for the team Should I offer them the beta?",
    );
    expect(text(asked?.message_html ?? "")).toContain(
      `Answer in a note that mentions ${BOT_NAME}`,
    );
    // The customer writing meanwhile does not answer the team's question.
    stage.pylon.customerWrites(issue.id, "Any news?");
    await flow(stage);
    const waiting = await conversationForIssue(issue.id);
    expect(waiting.state).toBe("waiting");
    expect(waiting.waitingOn?.kind).toBe("answer");
    stage.pylon.teammateWrites(
      issue.id,
      stage.teammate,
      `${BOT_NAME}: Yes, offer it`,
    );
    await flow(stage);
    expect(
      text(stage.pylon.notesOn(issue.id).at(-1)?.message_html ?? ""),
    ).toContain("Offering the beta");
  });
});

describe("replies to customers", () => {
  // Coverage: `pylon.policy.never`.
  test("under never, a reply is impossible: the tool is not offered, and connect cannot change the policy", async () => {
    const refused = await call<{ error: { message: string } }>(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/bot/${stage.botId}/installation`,
      {
        type: "pylon",
        config: { region: "us", customerReplyPolicy: "approve" },
        credentials: {
          apiToken: stage.conn.token,
          webhookSecret: stage.conn.webhookSecret,
        },
      },
    );
    expect(refused.status).toBe(406);
    expect(refused.body.error.message).toContain("pylon:settings-edit");
    stage.models.play([
      {
        ...reply("Findings only."),
        expect: { noMessageIncludes: "pylon_reply_to_customer" },
      },
    ]);
    const issue = openAcme();
    await flow(stage);
    const tools = stage.models.completions[0].body.tools?.map((t) => t.name);
    expect(tools).not.toContain("pylon_reply_to_customer");
    expect(callsTo("/reply")).toHaveLength(0);
    expect(stage.pylon.repliesOn(issue.id)).toHaveLength(0);
  });

  // Coverage: `pylon.policy.approve`, `pylon.out.draft`, `pylon.out.approval_note`, `pylon.in.approve_note`, `pylon.out.reply`, `pylon.out.reply_idempotent`.
  test("under approve: a draft and a note ask the team; a teammate's 'approve' note sends exactly that text, once", async () => {
    const policy = await editPylonSettings(stage, {
      customerReplyPolicy: "approve",
    });
    expect(policy.status).toBe(200);
    const answer =
      "Go to **Settings → Security** and choose *Reset password*. It's quick.";
    stage.models.play([
      step("pylon_reply_to_customer", { text: answer }),
      reply("Replied with the reset steps."),
    ]);
    const issue = openAcme();
    await flow(stage);
    const [approval] = await api.db.db.select().from(approvals);
    expect(approval.status).toBe("pending");
    expect(approval.server).toBe("pylon");
    expect(approval.tool).toBe("reply_to_customer");
    // The draft is in the bot's drafts, and the note quotes it.
    const drafts = stage.pylon.drafts.filter((d) => d.issueId === issue.id);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].userId).toBe(stage.conn.userId);
    const asking = text(
      stage.pylon.notesOn(issue.id).at(-1)?.message_html ?? "",
    );
    expect(asking).toContain(`waiting for approval (#${approval.id})`);
    expect(asking).toContain("Settings → Security");
    expect(asking).toContain(`approve ${approval.id}`);
    expect(stage.pylon.repliesOn(issue.id)).toHaveLength(0);

    // A customer cannot approve their own reply.
    stage.pylon.customerWrites(issue.id, `approve ${approval.id}`);
    await stage.pylon.drain();
    await drainQueue("ingress");
    const [still] = await api.db.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id));
    expect(still.status).toBe("pending");

    stage.pylon.teammateWrites(
      issue.id,
      stage.teammate,
      `approve ${approval.id}`,
    );
    await flow(stage);
    const replies = stage.pylon.repliesOn(issue.id);
    expect(replies).toHaveLength(1);
    // Byte for byte what was drafted and approved.
    expect(replies[0].message_html).toBe(drafts[0].body_html);
    const [sent] = callsTo("/reply");
    const body = sent.json as {
      message_id: string;
      custom_source: { external_id: string };
    };
    // It answers the customer's newest visible message.
    const visible = stage.pylon.messages.filter(
      (m) => m.issueId === issue.id && !m.is_private && m.author.contact,
    );
    expect(body.message_id).toBe(String(visible.at(-1)?.id));
    // A resend with the same external id is the same message.
    const again = await fetch(
      `${stage.pylon.url}/us/issues/${issue.id}/reply`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${stage.conn.token}`,
          "content-type": "application/json",
        },
        body: sent.body,
      },
    );
    expect(((await again.json()) as { data: { id: string } }).data.id).toBe(
      replies[0].id,
    );
    expect(stage.pylon.repliesOn(issue.id)).toHaveLength(1);
    const [decision] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "approval:decide"));
    expect(decision.actorType).toBe("participant");
    expect(decision.metadata).toMatchObject({
      via: "pylon",
      decision: "approve",
    });
  });

  // Coverage: `pylon.policy.auto_low`, `pylon.risk`.
  test("under auto-on-low-risk, a how-to answer is sent at once, audited as the admin's policy", async () => {
    await editPylonSettings(stage, { customerReplyPolicy: "auto-on-low-risk" });
    stage.models.play([
      step("pylon_reply_to_customer", {
        text: "Go to Settings → Security and choose Reset password.",
      }),
      {
        toolCalls: [
          {
            name: "json",
            input: { risk: "low", reason: "A documented how-to." },
          },
        ],
        expect: { anyMessageIncludes: "Reset password" },
      },
      reply("Replied with the reset steps."),
    ]);
    const issue = openAcme();
    await flow(stage);
    expect(stage.pylon.repliesOn(issue.id)).toHaveLength(1);
    expect(await api.db.db.select().from(approvals)).toHaveLength(0);
    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "pylon:auto-reply"));
    expect(audit.actorType).toBe("user");
    expect(audit.userId).toBe(stage.u.peach.userId);
    expect(audit.metadata).toMatchObject({
      policy: "auto-on-low-risk",
      issueId: issue.id,
    });
  });

  // Coverage: `pylon.policy.auto_high`.
  test("under auto-on-low-risk, a refund goes to approval instead", async () => {
    await editPylonSettings(stage, { customerReplyPolicy: "auto-on-low-risk" });
    stage.models.play([
      step("pylon_reply_to_customer", {
        text: "We will refund your last invoice in full.",
      }),
      {
        toolCalls: [
          { name: "json", input: { risk: "high", reason: "A refund." } },
        ],
      },
    ]);
    const issue = openAcme("Refund please", "I want my money back.");
    await flow(stage);
    expect(stage.pylon.repliesOn(issue.id)).toHaveLength(0);
    const [approval] = await api.db.db.select().from(approvals);
    expect(approval.status).toBe("pending");
    expect(
      stage.pylon.drafts.filter((d) => d.issueId === issue.id),
    ).toHaveLength(1);
  });

  // Coverage: `pylon.settings`.
  test("only a project admin sets the policy, and the change is audited", async () => {
    const denied = await call(
      stage.u.url,
      stage.u.toad,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}/pylon/settings`,
      { customerReplyPolicy: "approve" },
    );
    expect([403, 404]).toContain(denied.status);
    await editPylonSettings(stage, { customerReplyPolicy: "approve" });
    const rows = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "pylon:settings-edit"))
      .orderBy(auditLogs.id);
    const last = rows.at(-1);
    expect(
      (last?.after as { config: { customerReplyPolicy: string } }).config
        .customerReplyPolicy,
    ).toBe("approve");
  });
});

describe("disengagement", () => {
  // Coverage: `pylon.in.closed`.
  test("closing the issue ends the conversation silently", async () => {
    stage.models.play([reply("Findings.")]);
    const issue = openAcme();
    await flow(stage);
    const before = stage.pylon.notesOn(issue.id).length;
    stage.pylon.setState(issue.id, "closed");
    await flow(stage);
    const conversation = await conversationForIssue(issue.id);
    expect(conversation.state).toBe("ended");
    expect(stage.pylon.notesOn(issue.id)).toHaveLength(before);
  });

  // Coverage: `pylon.in.assigned`, `pylon.in.unassigned`, `pylon.trigger.assignment`.
  test("assigned to the bot, it works the issue; reassigned away, it stops — an issue it only triaged is not stopped by an assignment", async () => {
    await editPylonSettings(stage, { triggers: { autoTriage: false } });
    stage.models.play([
      reply("On it.", { lastMessageIncludes: "Assigned to you in Pylon" }),
    ]);
    const issue = openAcme("Broken export", "CSV export fails.");
    await flow(stage);
    stage.pylon.assign(issue.id, stage.conn.userId);
    await flow(stage);
    const conversation = await conversationForIssue(issue.id);
    expect(conversation.details).toMatchObject({ assignedIssueId: issue.id });
    stage.pylon.assign(issue.id, stage.teammate);
    await flow(stage);
    expect((await conversationForIssue(issue.id)).state).toBe("ended");

    await editPylonSettings(stage, { triggers: { autoTriage: true } });
    stage.models.play([reply("Findings.")]);
    const other = openAcme();
    await flow(stage);
    stage.pylon.assign(other.id, stage.teammate);
    await flow(stage);
    expect((await conversationForIssue(other.id)).state).not.toBe("ended");
  });

  // Coverage: `pylon.listen`.
  test("an issue outside the listened tags is not triaged", async () => {
    await editPylonSettings(stage, { listen: { tags: ["billing"] } });
    const issue = stage.pylon.openIssue({
      contactId: stage.acme.contactId,
      title: "Unrelated",
      body: "Hello",
      tags: ["bug"],
    });
    await flow(stage);
    expect(await conversationForIssue(issue.id)).toBeUndefined();
    const outcomes = (await api.db.db.select().from(triggerEvents)).map(
      (e) => e.outcome,
    );
    expect(outcomes).toContain("not-listened");
  });
});

describe("memory", () => {
  // Coverage: `pylon.memory.isolation`, `pylon.memory.promotion`.
  test("one customer's memory is never read on another's issue, and a fact naming a customer is not promoted", async () => {
    stage.models.play([
      step("memory_write", {
        path: "setup.md",
        scope: "channel",
        content: "Acme Rockets signs in with Okta SSO.",
        changeNote: "Learned from the issue",
      }),
      reply("Noted their SSO."),
    ]);
    const acmeIssue = openAcme("SSO trouble", "Okta login loops.");
    await flow(stage);
    stage.models.play([
      step("memory_search", { query: "Okta SSO" }),
      reply("Nothing known about their SSO."),
    ]);
    const globexIssue = stage.pylon.openIssue({
      contactId: stage.globex.contactId,
      title: "SSO question",
      body: "Do you support Okta SSO?",
    });
    await flow(stage);
    const globex = await conversationForIssue(globexIssue.id);
    const results = await api.db.db
      .select()
      .from(conversationEntries)
      .where(
        and(
          eq(conversationEntries.conversationId, globex.id),
          eq(conversationEntries.kind, "tool_result"),
        ),
      );
    const searched = results.find((r) => r.toolName === "memory_search");
    expect(searched).toBeDefined();
    expect(JSON.stringify(searched?.content)).not.toContain("Acme");

    const acme = await conversationForIssue(acmeIssue.id);
    const promote = (path: string) =>
      call<{ error?: { message: string } }>(
        stage.u.url,
        stage.u.peach,
        "POST",
        `/project/${stage.u.projectId}/memory/document/promote`,
        { botId: stage.botId, channelId: acme.channelId, path },
      );
    const refused = await promote("setup.md");
    expect(refused.status).toBe(406);
    expect(refused.body.error?.message).toContain("Acme Rockets");
    await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/memory/document`,
      {
        scope: "channel",
        botId: stage.botId,
        channelId: acme.channelId,
        path: "general.md",
        content: "Okta SSO login loops are fixed by clearing cookies.",
      },
    );
    expect((await promote("general.md")).status).toBe(200);
  });
});

describe("rate limits", () => {
  // Coverage: `pylon.out.bucket`, `pylon.out.429`.
  test("31 notes in a minute are spread out by the outbox, and Pylon's 429 is honoured", async () => {
    stage.models.play([reply("Findings.")]);
    const issue = openAcme();
    await flow(stage);
    const conversation = await conversationForIssue(issue.id);
    stage.pylon.clearRequests();
    await api.db.db.delete(outboxMessages);
    await api.redis.redis.del(`pylon:bucket:${stage.conn.installationId}`);
    const { emit } = await import("../../ops/SurfaceOps");
    for (let i = 0; i < 31; i++) {
      await emit(api.db.db, conversation, {
        kind: "message",
        payload: { messageKind: "reply", text: `Note ${i}` },
      });
    }
    await api.actions.enqueue(
      "outbox:deliver",
      { conversationId: conversation.id },
      "outbox",
    );
    await drainQueue("outbox");
    const posted = callsTo("/note");
    // The bucket (10, keeping 2 for acknowledgements) sent what it could.
    expect(posted.length).toBe(
      config.platforms.pylon.writeBucketCapacity -
        config.platforms.pylon.writeBucketReserve,
    );
    const rows = await api.db.db
      .select()
      .from(outboxMessages)
      .where(eq(outboxMessages.conversationId, conversation.id));
    const waiting = rows.filter((r) => r.status !== "sent");
    expect(waiting).toHaveLength(31 - posted.length);
    const next = waiting.find((r) => r.status === "failed");
    expect(next?.nextAttemptAt?.getTime() ?? 0).toBeGreaterThan(Date.now());
    expect(next?.error).toContain("bucket is empty");

    // Pylon's own 429 reschedules the row after its Retry-After.
    await api.redis.redis.del(`pylon:bucket:${stage.conn.installationId}`);
    await api.db.db
      .update(outboxMessages)
      .set({ nextAttemptAt: new Date() })
      .where(eq(outboxMessages.conversationId, conversation.id));
    stage.pylon.answers.push({
      status: 429,
      headers: { "retry-after": "17", "x-retry-after": "60" },
      body: {
        errors: ["rate limit exceeded"],
        code: "rate_limited",
        request_id: "r",
      },
    });
    await api.actions.enqueue(
      "outbox:deliver",
      { conversationId: conversation.id },
      "outbox",
    );
    await drainQueue("outbox");
    const [after] = await api.db.db
      .select()
      .from(outboxMessages)
      .where(
        and(
          eq(outboxMessages.conversationId, conversation.id),
          eq(outboxMessages.status, "failed"),
        ),
      )
      .orderBy(outboxMessages.id)
      .limit(1);
    expect(after.error).toContain("rate_limited");
    expect(after.nextAttemptAt?.getTime() ?? 0).toBeGreaterThan(
      Date.now() + 15_000,
    );
  });
});

describe("bindings", () => {
  // Coverage: `pylon.binding`.
  test("an account binds itself with in-channel approvals, since only the team sees notes", async () => {
    stage.models.play([reply("Findings.")]);
    openAcme();
    await flow(stage);
    const [binding] = await api.db.db.select().from(channelBindings);
    expect(binding.autoBound).toBe(true);
    expect(binding.approvalPolicy).toBe("participants");
  });
});
