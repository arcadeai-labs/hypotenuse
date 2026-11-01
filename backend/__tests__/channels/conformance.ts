import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { emitStatus } from "../../ops/SurfaceOps";
import { approvals } from "../../schema/approvals";
import { auditLogs } from "../../schema/audit_logs";
import { conversationInbox } from "../../schema/conversation_inbox";
import { conversationRow } from "../agent/harness";
import type { ModelServer } from "../fixtures/model-server";

/**
 * **The conformance suite**: one set of cases every surface adapter runs
 * against its platform (a fake over the real wire, or for the dashboard, its
 * own reads). A new platform passes it before anything else.
 *
 * | Case | Needs the wire |
 * |---|---|
 * | ordering | no |
 * | supersession (on a surface with a status line) | no |
 * | nothing after a question | no |
 * | question round trip | no |
 * | approval round trip, per policy the surface has | no |
 * | loop filtering | yes |
 * | dedupe of a message carried by two events | yes |
 * | the 404 on an unknown routing key | yes |
 * | signature failure | yes |
 * | uninstall | yes |
 */

/** One thing the surface showed. */
export interface Shown {
  kind: string;
  [key: string]: unknown;
}

/** How a suite drives one surface. */
export interface ConformanceDriver {
  /** The scripted model. */
  models: ModelServer;
  /** Start or continue a thread with a person's message. */
  say(thread: string, text: string): Promise<number>;
  /** Run the pipeline until it settles (events, ticks, deliveries). */
  settle(): Promise<void>;
  /** What the surface showed for a conversation, oldest first. */
  shown(conversationId: number): Promise<Shown[]>;
  /** The status lines a surface shows now, newest last. */
  statuses(conversationId: number): Promise<string[]>;
  /**
   * The surface has no status line at all (Pylon: a note is permanent), so
   * the supersession case does not apply.
   */
  noStatusLine?: boolean;
  /** Answer a question by pressing its option. */
  pressAnswer(
    conversationId: number,
    questionEntryId: number,
    label: string,
  ): Promise<void>;
  /** The approval policies this surface has; the dashboard has none of its own. */
  policies: ("dashboard" | "participants" | "listed" | "card")[];
  /** Set the thread's policy (no-op for the dashboard). */
  setPolicy(
    conversationId: number,
    policy: "dashboard" | "participants" | "listed",
    listed?: string[],
  ): Promise<void>;
  /** Decide an approval in place, as a given person; whether it was taken. */
  decide(
    conversationId: number,
    approvalId: number,
    approve: boolean,
    as?: string,
  ): Promise<boolean>;
  /** Decide it in the dashboard, as a person with write access. */
  decideInDashboard(approvalId: number): Promise<void>;
  /** Wire-only cases, when the surface has a wire. */
  wire?: {
    send(
      draft: Record<string, unknown>,
    ): Promise<{ status: number; body: string }>;
    sendToUnknownKey(): Promise<{ status: number; body: string }>;
    sendBadSignature(): Promise<{ status: number; body: string }>;
    uninstall(): Promise<void>;
    lastOutcome(): Promise<string | null>;
  };
}

/** The scripted steps of a gated call: read its info, call it, then reply. */
const gatedThenReply = [
  { toolCalls: [{ name: "mcp_info", input: { name: "mail/send_email" } }] },
  {
    toolCalls: [
      {
        name: "mcp_exec",
        input: { name: "mail/send_email", args: { to: "toad", subject: "hi" } },
      },
    ],
  },
  { toolCalls: [{ name: "reply_and_wait", input: { text: "Sent." } }] },
];

/**
 * Register every conformance case for a surface.
 * @param name - The surface, for test names.
 * @param driver - How to drive it (read lazily: suites build it in `beforeAll`).
 */
// Coverage: `webhook.in.interaction.approval`, `webhook.out.surface`.
export function conformance(name: string, driver: () => ConformanceDriver) {
  test(`${name}: ordering — a turn's rows arrive in the order written, the reply last`, async () => {
    const d = driver();
    d.models.play([
      { toolCalls: [{ name: "search_history", input: { query: "cake" } }] },
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Cake." } }] },
    ]);
    const id = await d.say("ord", "Cake?");
    await d.settle();
    const shown = await d.shown(id);
    expect(shown.at(-1)).toMatchObject({ kind: "message", text: "Cake." });
    const ids = shown.map((s) => Number(s.deliveryId ?? s.id));
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  test(`${name}: supersession — only the newest status line is shown`, async () => {
    const d = driver();
    if (d.noStatusLine) return;
    const id = await d.say("sup", "Hello?");
    const conversation = await conversationRow(id);
    await emitStatus(api.db.db, conversation, "First");
    await emitStatus(api.db.db, conversation, "Second");
    const statuses = await d.statuses(id);
    expect(statuses.at(-1)).toBe("Second");
    expect(statuses).not.toContain("First");
  });

  test(`${name}: nothing follows a question`, async () => {
    const d = driver();
    d.models.play([
      { toolCalls: [{ name: "ask_question", input: { question: "Which?" } }] },
    ]);
    const id = await d.say("ask", "Ask me.");
    await d.settle();
    const waiting = await conversationRow(id);
    expect(waiting.waitingOn?.kind).toBe("answer");
    expect(await emitStatus(api.db.db, waiting, "Late")).toBeNull();
    await d.settle();
    expect((await d.shown(id)).at(-1)).toMatchObject({ kind: "question" });
  });

  test(`${name}: question round trip — a button answers it`, async () => {
    const d = driver();
    d.models.play([
      {
        toolCalls: [
          {
            name: "ask_question",
            input: { question: "Which?", options: ["Cake", "Pie"] },
          },
        ],
      },
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "Pie." } }],
        expect: { lastMessageIncludes: "Pie" },
      },
    ]);
    const id = await d.say("qrt", "Dessert?");
    await d.settle();
    const question = (await d.shown(id)).find((s) => s.kind === "question");
    expect(question).toMatchObject({ options: ["Cake", "Pie"] });
    await d.pressAnswer(id, Number(question?.questionEntryId), "Pie");
    await d.settle();
    expect((await conversationRow(id)).state).toBe("hibernating");
    expect((await d.shown(id)).at(-1)).toMatchObject({
      kind: "message",
      text: "Pie.",
    });
    const [answer] = await api.db.db
      .select()
      .from(conversationInbox)
      .where(eq(conversationInbox.conversationId, id))
      .orderBy(conversationInbox.id)
      .then((rows) => rows.slice(-1));
    expect(answer.text).toBe("Pie");
  });

  for (const policy of [
    "dashboard",
    "participants",
    "listed",
    "card",
  ] as const) {
    test(`${name}: approval round trip — ${policy}`, async () => {
      const d = driver();
      if (!d.policies.includes(policy)) return;
      d.models.play(gatedThenReply);
      const id = await d.say(`apr-${policy}`, "Email Toad.");
      if (policy !== "card") {
        await d.setPolicy(id, policy, policy === "listed" ? ["U-boss"] : []);
      }
      await d.settle();
      const [approval] = await api.db.db
        .select()
        .from(approvals)
        .where(eq(approvals.conversationId, id));
      expect(approval.status).toBe("pending");
      const card = (await d.shown(id)).find((s) => s.kind === "approval");
      expect(card).toMatchObject({ approvalId: approval.id });

      if (policy === "dashboard") {
        expect(await d.decide(id, approval.id, true)).toBe(false);
        await d.decideInDashboard(approval.id);
      } else if (policy === "listed") {
        expect(await d.decide(id, approval.id, true, "U-peach")).toBe(false);
        expect(await d.decide(id, approval.id, true, "U-boss")).toBe(true);
      } else {
        expect(await d.decide(id, approval.id, true)).toBe(true);
      }
      await d.settle();
      const [after] = await api.db.db
        .select()
        .from(approvals)
        .where(eq(approvals.id, approval.id));
      expect(after.status).toBe("consumed");
      expect((await d.shown(id)).at(-1)).toMatchObject({
        kind: "message",
        text: "Sent.",
      });
      if (policy === "participants" || policy === "listed") {
        expect(after.decidedByParticipantId).not.toBeNull();
        const audit = await api.db.db
          .select()
          .from(auditLogs)
          .where(eq(auditLogs.action, "approval:decide"))
          .orderBy(auditLogs.id);
        expect(audit.at(-1)).toMatchObject({
          actorType: "participant",
          participantId: after.decidedByParticipantId,
        });
      }
    });
  }

  test(`${name}: wire — loops, dedupe, the 404, signatures, uninstall`, async () => {
    const d = driver();
    const wire = d.wire;
    if (!wire) return;
    // Loop filtering.
    await wire.send({
      sender: { id: "B-toadsworth", name: "Me" },
      text: "Echo",
    });
    await d.settle();
    expect(await wire.lastOutcome()).toBe("loop");
    // Two events carrying one message are one inbox row.
    d.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Once." } }] },
    ]);
    await wire.send({ messageId: "dup-1", eventId: "e-1", text: "Once?" });
    await wire.send({ messageId: "dup-1", eventId: "e-2", text: "Once?" });
    await d.settle();
    const inbox = await api.db.db
      .select()
      .from(conversationInbox)
      .where(eq(conversationInbox.deliveryKey, "C-general:dup-1"));
    expect(inbox).toHaveLength(1);
    // The 404, byte for byte, for an unknown key and a bad signature.
    const unknown = await wire.sendToUnknownKey();
    const forged = await wire.sendBadSignature();
    expect(unknown.status).toBe(404);
    expect(forged).toEqual(unknown);
    // Uninstall: the installation's URL becomes the same 404.
    await wire.uninstall();
    await d.settle();
    const after = await wire.send({ text: "Anyone?" });
    expect(after).toEqual(unknown);
  });
}
