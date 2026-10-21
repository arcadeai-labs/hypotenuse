import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import { api, config } from "keryx";
import {
  deliverSession,
  enqueueActivity,
  enqueueSessionUpdate,
  type OutboundContent,
  OutboxValidationError,
} from "../../ops/ActivityOutboxOps";
import { bucketKey } from "../../ops/LinearBucketOps";
import { rateLimitKey } from "../../ops/LinearOps";
import { LINEAR_OPERATIONS } from "../../ops/linear/operations";
import { agentActivities } from "../../schema/agent_activities";
import type { AgentSession } from "../../schema/agent_sessions";
import { integrations } from "../../schema/integrations";
import {
  buildTestUniverse,
  HOOK_TIMEOUT,
  runAction,
  type TestUniverse,
} from "../setup";
import { useFinear } from "./finear";
import { appToken, integrationRow } from "./helpers";
import {
  activityRows,
  finearSession,
  mirroredQuietly,
  sessionRow,
} from "./sessions";

/**
 * The activity outbox against finear: per-session order, client ids, retries,
 * superseding, validation, and the request budget. Each test starts from a
 * session finear holds `pending` and the server has mirrored but not answered,
 * so every activity on it is one this file put there.
 */

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

let token: string;
let integrationId: number;
let appUserId: string;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  const row = await integrationRow(universe.projectId);
  integrationId = row.id;
  appUserId = row.externalAppUserId;
  token = await appToken(universe.projectId);
}, HOOK_TIMEOUT);

let burst: number;
beforeAll(() => {
  burst = config.linear.bucketBurst;
});
beforeEach(async () => {
  config.linear.bucketBurst = burst;
  await api.redis.redis.del(
    bucketKey(integrationId),
    rateLimitKey(integrationId),
  );
  linear.clearRequests();
});

/**
 * A quiet session in this file's project.
 * @param title - The issue title.
 * @returns The mirror row.
 */
const quietSession = (title: string) =>
  mirroredQuietly(linear, universe.projectId, appUserId, title);

/**
 * Enqueue activities on a session in one transaction.
 * @param session - The session.
 * @param items - Content and options, in order.
 */
async function enqueue(
  session: AgentSession,
  ...items: [OutboundContent, Parameters<typeof enqueueActivity>[3]?][]
) {
  await api.db.db.transaction(async (tx) => {
    for (const [content, options] of items) {
      await enqueueActivity(tx, session.id, content, options);
    }
  });
}

/** How many times an operation reached the proxy since the log was cleared. */
const sent = (operation: string) =>
  linear.requests().filter((r) => r.operationName === operation).length;

describe("ordering", () => {
  test("LC-ACT-01 50 activities across 5 sessions arrive in seq order per session, all sessions in one tick", async () => {
    config.linear.bucketBurst = 500;
    const sessions = [];
    for (let i = 0; i < 5; i++) sessions.push(await quietSession(`Order ${i}`));
    for (const session of sessions) {
      await enqueue(
        session,
        ...Array.from(
          { length: 10 },
          (_, n) =>
            [{ type: "thought", body: `${session.id}:${n}` }] as [
              OutboundContent,
            ],
        ),
      );
    }

    const tick = await runAction<{ sessions: number; sent: number }>(
      "activities:deliver-due",
    );
    expect(tick).toMatchObject({ sessions: 5, sent: 50 });

    for (const session of sessions) {
      const finear = await finearSession(
        linear,
        token,
        session.externalSessionId,
      );
      expect(finear.activities.map((a) => a.content.body)).toEqual(
        Array.from({ length: 10 }, (_, n) => `${session.id}:${n}`),
      );
      const rows = await activityRows(session.id);
      expect(rows.map((r) => r.seq)).toEqual(
        Array.from({ length: 10 }, (_, n) => n + 1),
      );
      // LC-ACT-10: the id Linear holds is the row's client id.
      expect(finear.activities.map((a) => a.id)).toEqual(
        rows.map((r) => r.clientActivityId),
      );
    }
  });

  test("a second sender for the same session finds it held and sends nothing", async () => {
    const session = await quietSession("Held");
    await enqueue(session, [{ type: "thought", body: "once" }]);
    const [a, b] = await Promise.all([
      deliverSession(session.id),
      deliverSession(session.id),
    ]);
    expect([a.ran, b.ran].sort()).toEqual([false, true]);
    expect(a.sent + b.sent).toBe(1);
  });
});

describe("idempotency", () => {
  test("LC-ACT-10 a send whose response is lost is retried with the same client id, and finear holds one activity", async () => {
    const session = await quietSession("Lost response");
    await enqueue(session, [{ type: "thought", body: "said once" }]);
    linear.fault({
      kind: "drop",
      match: (r) => r.operationName === "CreateAgentActivity",
    });
    await deliverSession(session.id);

    expect(sent("CreateAgentActivity")).toBe(2);
    const finear = await finearSession(
      linear,
      token,
      session.externalSessionId,
    );
    expect(finear.activities.map((a) => a.content.body)).toEqual(["said once"]);
    const [row] = await activityRows(session.id);
    expect(row).toMatchObject({
      deliveryStatus: "sent",
      externalActivityId: row.clientActivityId,
    });
  });

  test("two lost responses back off, and the next attempt's duplicate id counts as sent", async () => {
    const session = await quietSession("Twice lost");
    await enqueue(session, [{ type: "thought", body: "still once" }]);
    for (let i = 0; i < 2; i++) {
      linear.fault({
        kind: "drop",
        match: (r) => r.operationName === "CreateAgentActivity",
      });
    }
    const first = await deliverSession(session.id);
    expect(first).toMatchObject({ sent: 0, deferred: true });
    let [row] = await activityRows(session.id);
    expect(row.deliveryStatus).toBe("pending");
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 500);

    // Control time by writing the column, not by waiting.
    await api.db.db
      .update(agentActivities)
      .set({ nextAttemptAt: new Date() })
      .where(eq(agentActivities.id, row.id));
    expect((await deliverSession(session.id)).sent).toBe(1);
    [row] = await activityRows(session.id);
    expect(row.deliveryStatus).toBe("sent");
    const finear = await finearSession(
      linear,
      token,
      session.externalSessionId,
    );
    expect(finear.activities).toHaveLength(1);
  });

  test("a session update whose response is lost is re-sent, and its link appears once", async () => {
    const session = await quietSession("Lost update");
    await enqueue(session, [{ type: "thought", body: "Linking" }]);
    await api.db.db.transaction((tx) =>
      enqueueSessionUpdate(tx, session.id, {
        addedExternalUrls: [
          { label: "Hypotenuse", url: "https://example.com/s/lost" },
        ],
      }),
    );
    linear.fault({
      kind: "drop",
      match: (r) => r.operationName === "UpdateAgentSession",
    });
    await deliverSession(session.id);

    expect(sent("UpdateAgentSession")).toBe(2);
    const reply = await linear.graphql<{
      agentSession: { externalLinks: { url: string }[] };
    }>(
      `Bearer ${token}`,
      "query($id: String!) { agentSession(id: $id) { externalLinks { url } } }",
      { id: session.externalSessionId },
    );
    expect(reply.data?.agentSession.externalLinks).toEqual([
      { url: "https://example.com/s/lost" },
    ]);
    expect((await activityRows(session.id)).at(-1)?.deliveryStatus).toBe(
      "sent",
    );
  });

  test("a row out of attempts is failed, and the session moves on", async () => {
    const session = await quietSession("Out of attempts");
    await enqueue(
      session,
      [{ type: "thought", body: "doomed" }],
      [{ type: "thought", body: "next" }],
    );
    const [doomed] = await activityRows(session.id);
    await api.db.db
      .update(agentActivities)
      .set({ attempts: config.linear.deliverMaxAttempts - 1 })
      .where(eq(agentActivities.id, doomed.id));
    // The proxy answers 502 without letting finear act: it was never sent.
    for (let i = 0; i < 2; i++) {
      linear.fault({
        kind: "drop",
        match: (r) => r.operationName === "CreateAgentActivity",
      });
    }
    await deliverSession(session.id);
    const rows = await activityRows(session.id);
    expect(rows[0].deliveryStatus).toBe("failed");
    expect(rows[0].attempts).toBe(config.linear.deliverMaxAttempts);
    expect(rows[1].deliveryStatus).toBe("sent");
  });
});

describe("superseding", () => {
  test("LC-ACT-09 three pending ephemeral thoughts then a response is one request", async () => {
    const session = await quietSession("Superseded");
    await enqueue(
      session,
      [{ type: "thought", body: "thinking 1" }, { ephemeral: true }],
      [
        { type: "action", action: "Reading", parameter: "a.ts" },
        { ephemeral: true },
      ],
      [{ type: "thought", body: "thinking 3" }, { ephemeral: true }],
      [{ type: "response", body: "Done." }],
    );
    await deliverSession(session.id);

    expect(sent("CreateAgentActivity")).toBe(1);
    const rows = await activityRows(session.id);
    expect(
      rows.map((r) => [r.ephemeral, r.priority, r.deliveryStatus]),
    ).toEqual([
      [true, "bulk", "superseded"],
      [true, "bulk", "superseded"],
      [true, "bulk", "superseded"],
      [false, "normal", "sent"],
    ]);
    const finear = await finearSession(
      linear,
      token,
      session.externalSessionId,
    );
    expect(finear.activities.map((a) => a.content.body)).toEqual(["Done."]);
    expect((await sessionRow(session.externalSessionId))?.status).toBe(
      "complete",
    );
  });

  test("an ephemeral thought is sent when nothing replaces it", async () => {
    const session = await quietSession("Ephemeral alone");
    await enqueue(session, [
      { type: "thought", body: "Looking" },
      { ephemeral: true },
    ]);
    await deliverSession(session.id);
    const finear = await finearSession(
      linear,
      token,
      session.externalSessionId,
    );
    expect(finear.activities).toEqual([
      expect.objectContaining({ ephemeral: true }),
    ]);
  });

  test("LC-SES-12 two pending plan updates are one request, and links are merged, never dropped", async () => {
    const session = await quietSession("Plans");
    // Something visible first, so the session is not a summary-only update.
    await enqueue(session, [{ type: "thought", body: "Planning" }]);
    await api.db.db.transaction(async (tx) => {
      await enqueueSessionUpdate(tx, session.id, {
        plan: [{ content: "Read the code", status: "inProgress" }],
        addedExternalUrls: [
          { label: "Hypotenuse", url: "https://example.com/s/1" },
        ],
      });
      await enqueueSessionUpdate(tx, session.id, {
        plan: [{ content: "Read the code", status: "completed" }],
      });
      await enqueueSessionUpdate(tx, session.id, {
        plan: [
          { content: "Read the code", status: "completed" },
          { content: "Fix it", status: "inProgress" },
        ],
        summary: "Fixing the flaky test",
      });
    });
    await deliverSession(session.id);

    const rows = await activityRows(session.id);
    expect(rows.map((r) => [r.kind, r.deliveryStatus, r.content])).toEqual([
      ["activity", "sent", { type: "thought", body: "Planning" }],
      [
        "session_update",
        "sent",
        {
          addedExternalUrls: [
            { label: "Hypotenuse", url: "https://example.com/s/1" },
          ],
        },
      ],
      [
        "session_update",
        "superseded",
        { plan: [{ content: "Read the code", status: "completed" }] },
      ],
      [
        "session_update",
        "sent",
        expect.objectContaining({ summary: "Fixing the flaky test" }),
      ],
    ]);
    expect(sent("UpdateAgentSession")).toBe(2);
    const mirror = await sessionRow(session.externalSessionId);
    expect(mirror).toMatchObject({
      summary: "Fixing the flaky test",
      plan: [
        { content: "Read the code", status: "completed" },
        { content: "Fix it", status: "inProgress" },
      ],
      externalUrls: [{ label: "Hypotenuse", url: "https://example.com/s/1" }],
    });
  });
});

describe("validation", () => {
  test("Linear's rules are enforced at enqueue, and nothing invalid reaches Linear", async () => {
    const session = await quietSession("Validation");
    const refused = async (fn: Parameters<typeof api.db.db.transaction>[0]) => {
      let error: unknown;
      try {
        await api.db.db.transaction(fn);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(OutboxValidationError);
    };
    // LC-ACT-09: only thoughts and actions may be ephemeral.
    await refused((tx) =>
      enqueueActivity(
        tx,
        session.id,
        { type: "response", body: "x" },
        {
          ephemeral: true,
        },
      ),
    );
    // LC-ACT-08: a prompt is a person's.
    await refused((tx) =>
      enqueueActivity(tx, session.id, {
        type: "prompt",
        body: "x",
      } as unknown as OutboundContent),
    );
    await refused((tx) =>
      enqueueActivity(tx, session.id, { type: "thought", body: "  " }),
    );
    await refused((tx) =>
      enqueueActivity(
        tx,
        session.id,
        { type: "thought", body: "x" },
        {
          signal: "stop" as "select",
        },
      ),
    );
    await refused((tx) =>
      enqueueActivity(
        tx,
        session.id,
        { type: "thought", body: "x" },
        {
          signal: "select",
        },
      ),
    );
    await refused((tx) =>
      enqueueSessionUpdate(tx, session.id, { summary: "two\nlines" }),
    );
    await refused((tx) =>
      enqueueSessionUpdate(tx, session.id, { summary: "x".repeat(256) }),
    );
    await refused((tx) =>
      enqueueSessionUpdate(tx, session.id, {
        plan: [{ content: "x", status: "done" as "completed" }],
      }),
    );
    await refused((tx) => enqueueSessionUpdate(tx, session.id, {}));
    // LC-SES-14: the deprecated externalLink is never written.
    await refused((tx) =>
      enqueueSessionUpdate(tx, session.id, {
        externalLink: "https://example.com",
      } as never),
    );

    expect(await activityRows(session.id)).toEqual([]);
    expect(sent("CreateAgentActivity") + sent("UpdateAgentSession")).toBe(0);
  });

  test("LC-SES-21 LC-SES-14 no operation writes externalLink or the legacy external-URL mutation", () => {
    for (const op of LINEAR_OPERATIONS) {
      expect(op.query, op.name).not.toContain("externalLink");
      expect(op.query, op.name).not.toContain("agentSessionUpdateExternalUrl");
    }
  });

  test("a row Linear refuses fails at once, and the rows behind it still go", async () => {
    const session = await quietSession("Refused");
    await enqueue(
      session,
      [{ type: "response", body: "Finished." }],
      // Linear refuses an agent's thought on a completed session.
      [{ type: "thought", body: "an afterthought" }],
    );
    await deliverSession(session.id);
    const rows = await activityRows(session.id);
    expect(rows.map((r) => r.deliveryStatus)).toEqual(["sent", "failed"]);
    expect(rows[1].lastError).toMatch(/Terminal sessions/);
    expect(rows[1].attempts).toBe(1);
  });

  test("an integration that cannot act fails every pending row", async () => {
    const session = await quietSession("Unavailable");
    await enqueue(
      session,
      [{ type: "thought", body: "a" }],
      [{ type: "thought", body: "b" }],
    );
    await api.db.db
      .update(integrations)
      .set({ status: "error" })
      .where(eq(integrations.id, integrationId));
    try {
      await deliverSession(session.id);
    } finally {
      await api.db.db
        .update(integrations)
        .set({ status: "active" })
        .where(eq(integrations.id, integrationId));
    }
    const rows = await activityRows(session.id);
    expect(rows.map((r) => [r.deliveryStatus, r.lastError])).toEqual([
      ["failed", "integration unavailable"],
      ["failed", "integration unavailable"],
    ]);
    expect(sent("CreateAgentActivity")).toBe(0);
  });
});

describe("budget", () => {
  test("LC-RATE-01 an empty bucket defers the session's head without spending an attempt", async () => {
    const session = await quietSession("Empty bucket");
    await enqueue(session, [{ type: "thought", body: "waits" }]);
    await api.redis.redis.hset(bucketKey(integrationId), {
      tokens: "0",
      ts: String(Date.now()),
    });
    const run = await deliverSession(session.id);
    expect(run).toMatchObject({ sent: 0, deferred: true });
    const [row] = await activityRows(session.id);
    expect(row).toMatchObject({ deliveryStatus: "pending", attempts: 0 });
    // Eleven tokens at 5,000 an hour is about eight seconds.
    expect(row.nextAttemptAt.getTime() - Date.now()).toBeGreaterThan(5000);
    expect(sent("CreateAgentActivity")).toBe(0);
  });

  test("LC-RATE-03 RATELIMITED defers to Linear's reset without counting an attempt, and empties the bucket", async () => {
    const session = await quietSession("Rate limited");
    await enqueue(
      session,
      [{ type: "thought", body: "first" }],
      [{ type: "thought", body: "second" }],
    );
    const resetAt = Date.now() + 30_000;
    linear.fault({
      kind: "ratelimit",
      resetAt,
      match: (r) => r.operationName === "CreateAgentActivity",
    });
    const run = await deliverSession(session.id);
    expect(run).toMatchObject({ sent: 0, deferred: true });
    const rows = await activityRows(session.id);
    expect(rows[0]).toMatchObject({
      deliveryStatus: "pending",
      attempts: 0,
      lastError: "Rate limit exceeded",
    });
    expect(rows[0].nextAttemptAt.getTime()).toBe(resetAt);
    // The second waits behind the first.
    expect(rows[1]).toMatchObject({ deliveryStatus: "pending", attempts: 0 });

    // Linear said none remain, so the next take is refused before any request.
    await api.db.db
      .update(agentActivities)
      .set({ nextAttemptAt: new Date() })
      .where(
        and(
          eq(agentActivities.agentSessionId, session.id),
          eq(agentActivities.seq, 1),
        ),
      );
    linear.clearRequests();
    expect((await deliverSession(session.id)).deferred).toBe(true);
    expect(sent("CreateAgentActivity")).toBe(0);
  });
});

describe("the mirror", () => {
  test("LC-SES-06 an elicitation leaves the session awaitingInput", async () => {
    const session = await quietSession("Elicited");
    await enqueue(session, [
      { type: "elicitation", body: "Which repository?" },
      {
        signal: "select",
        signalMetadata: {
          options: [{ value: "https://github.com/acme/api" }],
        },
      },
    ]);
    await deliverSession(session.id);
    expect((await sessionRow(session.externalSessionId))?.status).toBe(
      "awaitingInput",
    );
    const finear = await finearSession(
      linear,
      token,
      session.externalSessionId,
    );
    expect(finear).toMatchObject({
      status: "awaitingInput",
      activities: [expect.objectContaining({ signal: "select" })],
    });
  });
});
