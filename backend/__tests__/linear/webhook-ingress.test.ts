import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import { triggerEvents } from "../../schema/trigger_events";
import { buildTestUniverse, HOOK_TIMEOUT, type TestUniverse } from "../setup";
import { useFinear } from "./finear";
import { integrationRow } from "./helpers";
import {
  agentSessionEvent,
  deliver,
  sign,
  type Target,
  webhookSession,
} from "./inject";
import { createIssue, delegate, recordedEvent } from "./sessions";

/**
 * `webhooks:linear` — the security properties, one per test, in the order the
 * endpoint checks them: cap, signature over the raw bytes, signed timestamp,
 * dedupe, route, answer.
 */

let universe: TestUniverse;
let url: string;
beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
}, HOOK_TIMEOUT);
afterAll(async () => {
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

/**
 * A `created` event for an injected session.
 * @returns The payload.
 */
const created = () =>
  agentSessionEvent(target, {
    action: "created",
    agentSession: webhookSession(),
  });

/**
 * The recorded rows for one delivery id.
 * @param deliveryId - `Linear-Delivery`.
 * @returns The rows.
 */
const rowsFor = (deliveryId: string) =>
  api.db.db
    .select()
    .from(triggerEvents)
    .where(eq(triggerEvents.deliveryId, deliveryId));

/**
 * How many `triggers:process-event` jobs are queued for one event.
 * @param eventId - The event row.
 * @returns The count.
 */
async function processJobsFor(eventId: number): Promise<number> {
  const jobs = (await api.resque.queue.queued("triggers", 0, -1)) as {
    class: string;
    args: { eventId?: number }[];
  }[];
  return jobs.filter(
    (j) =>
      j.class === "triggers:process-event" && j.args[0]?.eventId === eventId,
  ).length;
}

describe("webhooks:linear", () => {
  test("LC-WH-01 LC-WH-04 a real Linear delivery is verified, recorded with its headers' delivery id, and answered 200", async () => {
    const issue = await createIssue(linear, "Ingress issue");
    const externalSessionId = await delegate(
      linear,
      issue.id,
      target.appUserId,
    );
    const event = await recordedEvent(
      (e) =>
        (e.payload as { agentSession?: { id?: string } }).agentSession?.id ===
        externalSessionId,
    );
    expect(event).toMatchObject({
      eventType: "AgentSessionEvent",
      action: "created",
      outcome: "pending",
      processedAt: null,
    });

    const { deliveries } = await linear.control<{
      deliveries: { id: string; resource_type: string; envelope: string }[];
    }>("/__test/deliveries");
    const delivery = deliveries.find((d) =>
      d.envelope.includes(externalSessionId),
    );
    expect(delivery?.id).toBe(event.deliveryId);
    const { attempts } = await linear.control<{
      attempts: { http_status: number; headers: string }[];
    }>(`/__test/attempts?deliveryId=${delivery?.id}`);
    expect(attempts.map((a) => a.http_status)).toEqual([200]);
    expect(Object.keys(JSON.parse(attempts[0].headers)).sort()).toEqual(
      [
        "Content-Type",
        "Linear-Delivery",
        "Linear-Event",
        "Linear-Signature",
        "Linear-Timestamp",
        "User-Agent",
      ].sort(),
    );
  });

  test("LC-WH-05 LC-WH-10 the signature is over the raw bytes: re-serialized whitespace or one flipped digit fails", async () => {
    const payload = created();
    const compact = JSON.stringify(payload);
    const pretty = JSON.stringify(payload, null, 2);

    // Signed over the compact bytes, sent as the same JSON re-indented.
    const reserialized = await deliver(url, payload, {
      raw: pretty,
      signature: sign(compact),
    });
    expect(reserialized.status).toBe(401);

    const good = sign(compact);
    const flipped = good.slice(0, -1) + (good.at(-1) === "0" ? "1" : "0");
    expect(
      (await deliver(url, payload, { raw: compact, signature: flipped }))
        .status,
    ).toBe(401);
    expect((await deliver(url, payload, { signature: null })).status).toBe(401);
    expect((await deliver(url, payload, { signature: "not-hex" })).status).toBe(
      401,
    );
    expect(
      (await deliver(url, payload, { secret: "someone-elses-secret" })).status,
    ).toBe(401);

    // The same bytes, correctly signed, are accepted.
    expect((await deliver(url, payload, { raw: pretty })).status).toBe(200);
  });

  test("LC-WH-06 a correctly signed body 61 s old fails, byte-identical to a bad signature", async () => {
    const stale = { ...created(), webhookTimestamp: Date.now() - 61_000 };
    const late = await deliver(url, stale);
    const forged = await deliver(url, created(), { signature: "0".repeat(64) });
    expect(late.status).toBe(401);
    expect(forged.status).toBe(401);
    expect(late.text).toBe(forged.text);

    const future = { ...created(), webhookTimestamp: Date.now() + 61_000 };
    expect((await deliver(url, future)).status).toBe(401);
    const fresh = { ...created(), webhookTimestamp: Date.now() - 59_000 };
    expect((await deliver(url, fresh)).status).toBe(200);
    // Nothing refused was recorded.
    expect(await rowsFor(late.deliveryId!)).toHaveLength(0);
    expect(await rowsFor(forged.deliveryId!)).toHaveLength(0);
  });

  test("retries are free: the same delivery three times is one row, one job, and three 200s", async () => {
    const payload = created();
    const deliveryId = crypto.randomUUID();
    const raw = JSON.stringify(payload);
    const answers = [];
    for (let i = 0; i < 3; i++) {
      answers.push((await deliver(url, payload, { raw, deliveryId })).status);
    }
    expect(answers).toEqual([200, 200, 200]);
    const rows = await rowsFor(deliveryId);
    expect(rows).toHaveLength(1);
    expect(await processJobsFor(rows[0].id)).toBe(1);
  });

  test("a delivery without Linear-Delivery is deduplicated by its bytes", async () => {
    const raw = JSON.stringify(created());
    const first = await deliver(url, {}, { raw, deliveryId: null });
    const second = await deliver(url, {}, { raw, deliveryId: null });
    expect([first.status, second.status]).toEqual([200, 200]);
    const rows = (await api.db.db.select().from(triggerEvents)).filter((r) =>
      r.deliveryId.startsWith("sha256:"),
    );
    expect(rows).toHaveLength(1);
  });

  test("a verified delivery for no connected workspace is answered 200 and recorded unknown_integration", async () => {
    const res = await deliver(
      url,
      agentSessionEvent(
        { organizationId: crypto.randomUUID(), appUserId: "someone" },
        { action: "created", agentSession: webhookSession() },
      ),
    );
    expect(res.status).toBe(200);
    const [row] = await rowsFor(res.deliveryId!);
    expect(row).toMatchObject({
      integrationId: null,
      outcome: "unknown_integration",
    });
    expect(row.processedAt).not.toBeNull();
    expect(await processJobsFor(row.id)).toBe(0);
  });

  test("fast: the endpoint calls nobody, and answers before the job runs", async () => {
    linear.clearRequests();
    const res = await deliver(url, created());
    expect(res.status).toBe(200);
    expect(linear.requests()).toEqual([]);
    const [row] = await rowsFor(res.deliveryId!);
    expect(row.processedAt).toBeNull();
    expect(await processJobsFor(row.id)).toBe(1);
  });

  test("bounded: a body over the cap is refused 413", async () => {
    const big = new Uint8Array(config.linear.webhookMaxBodyBytes + 1024 * 1024);
    big.fill(0x20);
    const res = await deliver(url, {}, { raw: big });
    expect(res.status).toBe(413);
    // At the cap exactly is read (and then fails verification, being spaces).
    const atCap = new Uint8Array(config.linear.webhookMaxBodyBytes).fill(0x20);
    expect(
      (await deliver(url, {}, { raw: atCap, signature: sign(atCap) })).status,
    ).toBe(401);
  });

  test("no body text reaches the logs, only the delivery id and the reason", async () => {
    const marker = `secret-issue-text-${crypto.randomUUID()}`;
    const lines: string[] = [];
    const original = api.logger.log.bind(api.logger);
    api.logger.log = (level, message, data) => {
      // What a deployment emits: `LOG_LEVEL` is info or above there. (Debug
      // is Drizzle echoing every query with its parameters.)
      if (!["trace", "debug"].includes(level)) {
        lines.push(`${message} ${JSON.stringify(data ?? {})}`);
      }
      original(level, message, data);
    };
    try {
      const payload = agentSessionEvent(target, {
        action: "created",
        agentSession: webhookSession(),
        promptContext: marker,
      });
      await deliver(url, payload);
      await deliver(url, payload, { signature: "0".repeat(64) });
      await deliver(url, { ...payload, webhookTimestamp: 1 });
    } finally {
      api.logger.log = original;
    }
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(marker);
  });

  test("LC-OAUTH-24 while a previous secret is set, deliveries signed with either verify", async () => {
    const saved = config.linear.webhookSecretPrevious;
    try {
      const old = await deliver(url, created(), { secret: "rotated-out" });
      expect(old.status).toBe(401);
      config.linear.webhookSecretPrevious = "rotated-out";
      expect(
        (await deliver(url, created(), { secret: "rotated-out" })).status,
      ).toBe(200);
      expect((await deliver(url, created())).status).toBe(200);
    } finally {
      config.linear.webhookSecretPrevious = saved;
    }
    expect(
      (await deliver(url, created(), { secret: "rotated-out" })).status,
    ).toBe(401);
  });

  test("LC-SDK-01 the signed body's type wins over a disagreeing Linear-Event header", async () => {
    const res = await deliver(url, created(), { event: "Issue" });
    expect(res.status).toBe(200);
    const [row] = await rowsFor(res.deliveryId!);
    expect(row.eventType).toBe("AgentSessionEvent");
  });
});
