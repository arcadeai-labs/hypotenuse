import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import { ipAllowed, webhookClock } from "../../ops/LinearWebhookOps";
import { triggerEvents } from "../../schema/trigger_events";
import {
  buildTestUniverse,
  HOOK_TIMEOUT,
  runAction,
  type TestUniverse,
} from "../setup";
import { useFinear } from "./finear";
import { integrationRow } from "./helpers";
import {
  agentSessionEvent,
  deliver,
  type Target,
  webhookSession,
} from "./inject";
import {
  createIssue,
  delegate,
  recordedEvent,
  settle,
  waitFor,
} from "./sessions";

/**
 * How the endpoint behaves under Linear's delivery rules: its five-second
 * deadline, its retry schedule, the signed timestamp against a clock that is
 * not ours, and event types and actions nobody told us about.
 */

let universe: TestUniverse;
let url: string;
beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
}, HOOK_TIMEOUT);
afterAll(async () => {
  webhookClock.now = () => Date.now();
  await api.stop();
}, HOOK_TIMEOUT);

const linear = useFinear();

let target: Target;
beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  const row = await integrationRow(universe.projectId);
  target = {
    organizationId: row.externalWorkspaceId,
    appUserId: row.externalAppUserId,
  };
}, HOOK_TIMEOUT);

describe("webhook robustness", () => {
  test("LC-WH-02 every delivery is answered well inside Linear's five seconds", async () => {
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const res = await deliver(
        url,
        agentSessionEvent(target, {
          action: "created",
          agentSession: webhookSession(),
        }),
      );
      expect(res.status).toBe(200);
      times.push(res.ms);
    }
    expect(Math.max(...times)).toBeLessThan(500);
  });

  test("LC-WH-02 Linear's volume is never rate-limited: one address sends every workspace's deliveries", async () => {
    const saved = { ...config.rateLimit };
    config.rateLimit.enabled = true;
    config.rateLimit.unauthenticatedLimit = 3;
    try {
      // The limit is live: a rate-limited unauthenticated route (sign-in)
      // refuses past it.
      const statuses = [];
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${url}/api/session`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            email: "nobody@example.com",
            password: "not-the-password",
          }),
        });
        statuses.push(res.status);
      }
      expect(statuses).toContain(429);

      for (let i = 0; i < 10; i++) {
        const res = await deliver(
          url,
          agentSessionEvent(target, {
            action: "created",
            agentSession: webhookSession(),
          }),
        );
        expect(res.status).toBe(200);
      }
    } finally {
      Object.assign(config.rateLimit, saved);
    }
  });

  test("LC-WH-09 non-POST is not routed; oversized is 413; unverified is 401", async () => {
    const get = await fetch(`${url}/api/webhooks/linear`);
    expect(get.status).toBe(404);
    const big = new Uint8Array(config.linear.webhookMaxBodyBytes + 1).fill(32);
    expect((await deliver(url, {}, { raw: big })).status).toBe(413);
    expect(
      (
        await deliver(
          url,
          agentSessionEvent(target, {
            action: "created",
            agentSession: webhookSession(),
          }),
          { signature: "f".repeat(64) },
        )
      ).status,
    ).toBe(401);
  });

  test("LC-WH-07 an IP allowlist refuses other senders with the unverified 401, and reads a trusted proxy's last hop", async () => {
    const saved = {
      list: config.linear.webhookIpAllowlist,
      trust: config.linear.webhookTrustForwarded,
    };
    const fresh = () =>
      agentSessionEvent(target, {
        action: "archived",
        agentSession: webhookSession(),
      });
    try {
      const unverified = await deliver(url, fresh(), {
        signature: "f".repeat(64),
      });
      config.linear.webhookIpAllowlist = "203.0.113.0/24";
      const refused = await deliver(url, fresh());
      expect(refused.status).toBe(401);
      expect(refused.text).toBe(unverified.text);
      // A forged header is not believed unless a proxy is trusted.
      const forged = await deliver(url, fresh(), {
        headers: { "X-Forwarded-For": "203.0.113.9" },
      });
      expect(forged.status).toBe(401);
      config.linear.webhookTrustForwarded = true;
      const proxied = await deliver(url, fresh(), {
        headers: { "X-Forwarded-For": "198.51.100.1, 203.0.113.9" },
      });
      expect(proxied.status).toBe(200);
      const spoofedFirstHop = await deliver(url, fresh(), {
        headers: { "X-Forwarded-For": "203.0.113.9, 198.51.100.1" },
      });
      expect(spoofedFirstHop.status).toBe(401);
      config.linear.webhookTrustForwarded = false;
      config.linear.webhookIpAllowlist = "127.0.0.1, ::1";
      expect((await deliver(url, fresh())).status).toBe(200);
    } finally {
      config.linear.webhookIpAllowlist = saved.list;
      config.linear.webhookTrustForwarded = saved.trust;
    }
  });

  test("LC-WH-07 ipAllowed matches addresses and IPv4 CIDRs; an empty list allows all", () => {
    expect(ipAllowed("1.2.3.4", "")).toBe(true);
    expect(ipAllowed("10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipAllowed("11.1.2.3", "10.0.0.0/8")).toBe(false);
    expect(ipAllowed("::ffff:10.1.2.3", "10.0.0.0/8")).toBe(true);
    expect(ipAllowed("2001:db8::1", "2001:db8::1")).toBe(true);
    expect(ipAllowed("2001:db8::2", "2001:db8::1, 10.0.0.0/8")).toBe(false);
    expect(ipAllowed("1.2.3.4", "0.0.0.0/0")).toBe(true);
    expect(ipAllowed("1.2.3.4", "1.2.3.0/33")).toBe(false);
  });

  test("LC-WH-14 an AgentSessionEvent action Linear adds later is recorded, ignored, and answered 200", async () => {
    const res = await deliver(
      url,
      agentSessionEvent(target, {
        action: "archived",
        agentSession: webhookSession(),
      }),
    );
    expect(res.status).toBe(200);
    await settle();
    const [row] = await api.db.db
      .select()
      .from(triggerEvents)
      .where(eq(triggerEvents.deliveryId, res.deliveryId!));
    expect(row).toMatchObject({ action: "archived", outcome: "ignored" });
  });

  test("LC-WH-25 a resource type Hypotenuse does not subscribe to is recorded and ignored", async () => {
    const res = await deliver(url, {
      type: "Project",
      action: "update",
      organizationId: target.organizationId,
      createdAt: new Date().toISOString(),
      data: { id: crypto.randomUUID(), name: "A project" },
      webhookTimestamp: Date.now(),
    });
    expect(res.status).toBe(200);
    await settle();
    const [row] = await api.db.db
      .select()
      .from(triggerEvents)
      .where(eq(triggerEvents.deliveryId, res.deliveryId!));
    expect(row.outcome).toBe("ignored");
  });

  test("LC-WH-03 a delivery whose processing job was lost is processed by the clock", async () => {
    const res = await deliver(
      url,
      agentSessionEvent(target, {
        action: "archived",
        agentSession: webhookSession(),
      }),
    );
    // As if Redis lost the job.
    await api.resque.queue.delQueue("triggers");
    const [row] = await api.db.db
      .select()
      .from(triggerEvents)
      .where(eq(triggerEvents.deliveryId, res.deliveryId!));
    expect(row.processedAt).toBeNull();

    // Young deliveries are left to their own job…
    expect(
      (await runAction<{ processed: number }>("triggers:process-pending", {}))
        .processed,
    ).toBe(0);
    await api.db.db
      .update(triggerEvents)
      .set({ receivedAt: new Date(Date.now() - 10_000) })
      .where(eq(triggerEvents.id, row.id));
    // …and old ones are the clock's.
    expect(
      (await runAction<{ processed: number }>("triggers:process-pending", {}))
        .processed,
    ).toBe(1);
    // Exactly once: the job, had it survived, finds nothing to do.
    expect(
      await runAction("triggers:process-event", { eventId: row.id }),
    ).toEqual({ outcome: "skipped" });
  });

  test("recorded deliveries older than the retention period are swept", async () => {
    const res = await deliver(url, {
      type: "Project",
      action: "remove",
      organizationId: target.organizationId,
      webhookTimestamp: Date.now(),
    });
    await api.db.db
      .update(triggerEvents)
      .set({
        receivedAt: new Date(
          Date.now() -
            (config.linear.eventRetentionDays + 1) * 24 * 60 * 60 * 1000,
        ),
      })
      .where(eq(triggerEvents.deliveryId, res.deliveryId!));
    const before = (await api.db.db.select().from(triggerEvents)).length;
    const { deleted } = await runAction<{ deleted: number }>(
      "trigger-events:sweep",
    );
    expect(deleted).toBe(1);
    expect((await api.db.db.select().from(triggerEvents)).length).toBe(
      before - 1,
    );
  });

  // Last in the file: it moves finear's clock, and the server's with it.
  test("LC-WH-03 LC-WH-06 LC-DIFF-04 a refused delivery is retried after a minute and an hour in Linear's time, with the same Linear-Delivery, and recorded once", async () => {
    const issue = await createIssue(linear, "Retried delivery");
    const attemptsOf = async (id: string) =>
      (
        await linear.control<{
          attempts: { http_status: number | null; body: string }[];
        }>(`/__test/attempts?deliveryId=${id}`)
      ).attempts;

    const secret = config.linear.webhookSecret;
    config.linear.webhookSecret = "a-secret-linear-does-not-sign-with";
    let deliveryId: string;
    try {
      const externalSessionId = await delegate(
        linear,
        issue.id,
        target.appUserId,
      );
      // finear's scheduler delivers within ~50 ms; the server refuses it.
      deliveryId = await waitFor(async () => {
        const { deliveries } = await linear.control<{
          deliveries: { id: string; envelope: string }[];
        }>("/__test/deliveries");
        const delivery = deliveries.find((d) =>
          d.envelope.includes(externalSessionId),
        );
        if (!delivery) return undefined;
        return (await attemptsOf(delivery.id)).length > 0
          ? delivery.id
          : undefined;
      });
      // Linear's first retry, a minute on, is refused too.
      await linear.advance(60_000);
    } finally {
      config.linear.webhookSecret = secret;
    }

    // The second retry is stamped an hour ahead of real time: inside the
    // tolerance only against a clock aligned to finear's.
    const offset = (await linear.now()) - Date.now();
    webhookClock.now = () => Date.now() + offset + 3_600_000;
    await linear.advance(3_600_000);

    const event = await recordedEvent((e) => e.deliveryId === deliveryId);
    expect(event.eventType).toBe("AgentSessionEvent");
    const attempts = await attemptsOf(deliveryId);
    expect(attempts.map((a) => a.http_status)).toEqual([401, 401, 200]);
    const stamps = attempts.map(
      (a) => JSON.parse(a.body).webhookTimestamp as number,
    );
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(60_000);
    expect(stamps[2] - stamps[1]).toBeGreaterThanOrEqual(3_600_000);
    expect(
      await api.db.db
        .select()
        .from(triggerEvents)
        .where(eq(triggerEvents.deliveryId, deliveryId)),
    ).toHaveLength(1);

    // Against the real clock, the accepted retry would have been a replay.
    expect(
      Math.abs(Date.now() - stamps[2]) > config.linear.webhookToleranceMs,
    ).toBe(true);
  });
});
