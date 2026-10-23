import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  attributes,
  encodeOtlpProtobuf,
  formatTraceparent,
  NOT_YOUR_WORK,
  newSpanId,
  newTraceId,
  parseTraceparent,
  sampledBy,
  TELEMETRY_LATE,
  TELEMETRY_NOT_WANTED,
  TELEMETRY_RATE_LIMITED,
  type TracesRequest,
  unixNano,
  type WorkAssignment,
} from "@hypotenuse/protocol";
import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import { forgetProjectTelemetry } from "../../ops/TelemetryOps";
import {
  enqueueTelemetry,
  exportAll,
  streamKey,
} from "../../ops/TelemetryRelayOps";
import { telemetryExporters } from "../../schema/telemetry_exporters";
import { workItems } from "../../schema/work_items";
import { OtlpCollector } from "../fixtures/otlp-collector";
import { useFinear } from "../linear/finear";
import { integrationRow } from "../linear/helpers";
import { settle } from "../linear/sessions";
import {
  ago,
  delegatedSession,
  ScriptedDaemon,
  setItem,
  withoutRunnerRateLimits,
} from "../routing/helpers";
import { daemonHeaders } from "../runners/helpers";
import {
  authHeaders,
  buildTestUniverse,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";

/**
 * The relay, from a scripted daemon's batch to a collector: `daemon:telemetry`'s
 * checks in order, the late window, the project's byte budget, per-exporter
 * consumer groups that retry `429`/`5xx` without holding up one another, a
 * refusal that drops and says so, and sampling that gives each exporter its
 * share — every turn a 0.2 exporter keeps is one a 0.6 exporter keeps too.
 */

let universe: TestUniverse;
beforeAll(async () => {
  universe = await buildTestUniverse();
}, HOOK_TIMEOUT);
const linear = useFinear();
withoutRunnerRateLimits();
const collector = new OtlpCollector();

afterAll(async () => {
  collector.stop();
  await api.stop();
}, HOOK_TIMEOUT);

let appUserId: string;
let mario: ScriptedDaemon;
let luigi: ScriptedDaemon;
let exporterId: number;

/** The runner owner's cap a scripted daemon reports. */
const CAP = { enabled: true, maxContent: "full", agentNative: true } as const;

/**
 * Create an exporter as Peach.
 * @param body - The exporter.
 * @returns Its id.
 */
async function createExporter(body: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${universe.url}/api/telemetry-exporter`, {
    method: "PUT",
    headers: authHeaders(universe.peach.sessionId),
    body: JSON.stringify({ projectId: universe.projectId, ...body }),
  });
  const json = (await res.json()) as { telemetryExporter: { id: number } };
  if (!json.telemetryExporter) throw new Error(JSON.stringify(json));
  return json.telemetryExporter.id;
}

/**
 * A traces batch of one span in a trace.
 * @param traceId - The trace.
 * @param name - The span's name.
 * @returns The request.
 */
function oneSpan(traceId: string, name = "daemon.turn"): TracesRequest {
  return {
    resourceSpans: [
      {
        resource: { attributes: attributes({ "service.name": "test-daemon" }) },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId: newSpanId(),
                name,
                startTimeUnixNano: unixNano(Date.now() - 10),
                endTimeUnixNano: unixNano(Date.now()),
              },
            ],
          },
        ],
      },
    ],
  };
}

/**
 * POST a batch to `daemon:telemetry` as a runner.
 * @param daemon - The runner.
 * @param workItemId - The turn.
 * @param traceparent - Its traceparent.
 * @param body - The body bytes.
 * @param headers - Content type and encoding.
 * @returns The status, body, and headers.
 */
async function post(
  daemon: ScriptedDaemon,
  workItemId: number,
  traceparent: string,
  body: Uint8Array,
  headers: Record<string, string> = { "Content-Type": "application/json" },
) {
  const res = await fetch(`${universe.url}/api/daemon/telemetry`, {
    method: "POST",
    headers: {
      ...daemonHeaders(daemon.runner.token),
      "X-Hypotenuse-Signal": "traces",
      "X-Hypotenuse-Work-Item": String(workItemId),
      traceparent,
      ...headers,
    },
    body: new Uint8Array(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as { error?: { type: string } },
    headers: res.headers,
  };
}

/** JSON bytes. */
const json = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));

beforeAll(async () => {
  await linear.install(universe.projectId, universe.peach.sessionId);
  appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
  const shape = {
    limits: { maxParallelJobs: 4 },
  };
  mario = await ScriptedDaemon.register(
    universe.url,
    universe.mario,
    universe.projectId,
    "mario-laptop",
    shape,
  );
  mario.shape.capabilities = { ...mario.shape.capabilities, telemetry: CAP };
  luigi = await ScriptedDaemon.register(
    universe.url,
    universe.luigi,
    universe.projectId,
    "luigi-laptop",
    shape,
  );
  await mario.heartbeat();
  exporterId = await createExporter({
    name: "collector",
    endpoint: `${collector.url}/a`,
    content: "full",
  });
}, HOOK_TIMEOUT);

/**
 * A turn mario holds, claimed.
 * @param title - The issue.
 * @returns The assignment.
 */
async function heldTurn(title: string): Promise<WorkAssignment> {
  await delegatedSession(linear, appUserId, title);
  await mario.heartbeat();
  const assignment = await mario.claim();
  if (!assignment) throw new Error("nothing to claim");
  return assignment;
}

describe("daemon:telemetry", () => {
  let turn: WorkAssignment;

  test("the claim carries the turn's trace and what to collect", async () => {
    turn = await heldTurn("Traced work");
    expect(turn.telemetry).toMatchObject({
      sampled: true,
      content: "full",
      agentNative: true,
    });
    const [row] = await api.db.db
      .select()
      .from(workItems)
      .where(eq(workItems.id, turn.workItemId));
    expect(turn.telemetry?.traceparent).toBe(row?.traceparent);
    expect(parseTraceparent(row?.traceparent)?.sampled).toBe(true);
  });

  test("a batch is accepted with 202, pinned to the turn's trace, stamped, and exported", async () => {
    const traceId = parseTraceparent(turn.telemetry!.traceparent)!.traceId;
    const batch = oneSpan(traceId);
    // A span of another trace rides along; it is dropped.
    batch.resourceSpans![0]!.scopeSpans![0]!.spans!.push(
      oneSpan(newTraceId(), "intruder").resourceSpans![0]!.scopeSpans![0]!
        .spans![0]!,
    );
    const answer = await post(
      mario,
      turn.workItemId,
      turn.telemetry!.traceparent,
      Bun.gzipSync(json(batch)),
      { "Content-Type": "application/json", "Content-Encoding": "gzip" },
    );
    expect(answer.status).toBe(202);
    const protobuf = await post(
      mario,
      turn.workItemId,
      turn.telemetry!.traceparent,
      encodeOtlpProtobuf("traces", oneSpan(traceId, "from.protobuf")),
      { "Content-Type": "application/x-protobuf" },
    );
    expect(protobuf.status).toBe(202);
    collector.reset();
    await exportAll();
    const spans = collector.spans("/a").filter((s) => s.traceId === traceId);
    expect(spans.map((s) => s.name).sort()).toEqual(
      expect.arrayContaining(["daemon.turn", "from.protobuf"]),
    );
    expect(collector.spans("/a").some((s) => s.name === "intruder")).toBe(
      false,
    );
    const daemonSpan = spans.find((s) => s.name === "daemon.turn");
    expect(daemonSpan?.resource).toMatchObject({
      "hypotenuse.project.id": universe.projectId,
      "hypotenuse.work_item.id": turn.workItemId,
      "hypotenuse.runner.id": mario.id,
      "hypotenuse.runner.name": "mario-laptop",
    });
  });

  test("another runner, or another trace, is not this runner's turn", async () => {
    const theirs = await post(
      luigi,
      turn.workItemId,
      turn.telemetry!.traceparent,
      json(oneSpan(newTraceId())),
    );
    expect(theirs.status).toBe(409);
    expect(theirs.body.error?.type).toBe(NOT_YOUR_WORK);
    const wrongTrace = await post(
      mario,
      turn.workItemId,
      formatTraceparent({
        traceId: newTraceId(),
        spanId: newSpanId(),
        sampled: true,
      }),
      json(oneSpan(newTraceId())),
    );
    expect(wrongTrace.status).toBe(409);
    expect(wrongTrace.body.error?.type).toBe(NOT_YOUR_WORK);
    const garbage = await post(
      mario,
      turn.workItemId,
      turn.telemetry!.traceparent,
      new TextEncoder().encode("not otlp"),
      { "Content-Type": "application/x-protobuf" },
    );
    expect(garbage.status).toBe(400);
  });

  test("inside the late window a finished turn's batch is taken; past it, 410", async () => {
    const traceId = parseTraceparent(turn.telemetry!.traceparent)!.traceId;
    await mario.complete(turn.workItemId, "completed");
    const late = await post(
      mario,
      turn.workItemId,
      turn.telemetry!.traceparent,
      json(oneSpan(traceId, "after.complete")),
    );
    expect(late.status).toBe(202);
    await setItem(turn.workItemId, {
      finishedAt: ago(config.telemetry.lateWindowMs + 1000),
    });
    const tooLate = await post(
      mario,
      turn.workItemId,
      turn.telemetry!.traceparent,
      json(oneSpan(traceId, "too.late")),
    );
    expect(tooLate.status).toBe(410);
    expect(tooLate.body.error?.type).toBe(TELEMETRY_LATE);
  });

  test("the project's byte budget answers 429 with Retry-After", async () => {
    const next = await heldTurn("Chatty telemetry");
    const traceId = parseTraceparent(next.telemetry!.traceparent)!.traceId;
    const saved = {
      rate: config.telemetry.projectBytesPerSecond,
      burst: config.telemetry.projectBurstBytes,
    };
    config.telemetry.projectBytesPerSecond = 10;
    config.telemetry.projectBurstBytes = 300;
    await api.redis.redis.del(`telemetry:bucket:${universe.projectId}`);
    try {
      const first = await post(
        mario,
        next.workItemId,
        next.telemetry!.traceparent,
        json(oneSpan(traceId)),
      );
      expect(first.status).toBe(202);
      const second = await post(
        mario,
        next.workItemId,
        next.telemetry!.traceparent,
        json(oneSpan(traceId)),
      );
      expect(second.status).toBe(429);
      expect(second.body.error?.type).toBe(TELEMETRY_RATE_LIMITED);
      expect(Number(second.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      config.telemetry.projectBytesPerSecond = saved.rate;
      config.telemetry.projectBurstBytes = saved.burst;
      await api.redis.redis.del(`telemetry:bucket:${universe.projectId}`);
    }
    await mario.complete(next.workItemId, "completed");
  });

  test("with no enabled exporter the turn's telemetry is not wanted", async () => {
    const next = await heldTurn("Nobody listening");
    await api.db.db
      .update(telemetryExporters)
      .set({ enabled: false })
      .where(eq(telemetryExporters.id, exporterId));
    forgetProjectTelemetry(universe.projectId);
    try {
      const answer = await post(
        mario,
        next.workItemId,
        next.telemetry!.traceparent,
        json(oneSpan(parseTraceparent(next.telemetry!.traceparent)!.traceId)),
      );
      expect(answer.status).toBe(409);
      expect(answer.body.error?.type).toBe(TELEMETRY_NOT_WANTED);
    } finally {
      await api.db.db
        .update(telemetryExporters)
        .set({ enabled: true })
        .where(eq(telemetryExporters.id, exporterId));
      forgetProjectTelemetry(universe.projectId);
    }
    await mario.complete(next.workItemId, "completed");
    await settle();
  });
});

describe("export", () => {
  test("503 backs off and retries the same batch once; a second collector is not held up", async () => {
    const other = await createExporter({
      name: "second",
      endpoint: `${collector.url}/b`,
    });
    await exportAll();
    collector.reset();
    const traceId = newTraceId();
    await enqueueTelemetry(
      universe.projectId,
      "traces",
      oneSpan(traceId, "retried"),
      traceId,
    );
    collector.fail(503, 1);
    const first = await exportAll();
    // The second collector got it at once; the first, which answered 503, not.
    expect(first.sent[other]).toBeGreaterThanOrEqual(1);
    expect(
      collector
        .spans()
        .filter((s) => s.name === "retried")
        .map((s) => s.prefix),
    ).toEqual(["/b"]);
    const [row] = await api.db.db
      .select()
      .from(telemetryExporters)
      .where(eq(telemetryExporters.id, exporterId));
    expect(row?.lastError).toContain("503");
    // Backing off: a pass now skips it.
    expect((await exportAll()).backedOff).toContain(exporterId);
    // Move the clock: the backoff is a key with a TTL.
    await api.redis.redis.del(`telemetry:backoff:${exporterId}`);
    await exportAll();
    const received = collector
      .spans()
      .filter((s) => s.name === "retried")
      .map((s) => s.prefix)
      .sort();
    expect(received).toEqual(["/a", "/b"]);
    await api.db.db
      .delete(telemetryExporters)
      .where(eq(telemetryExporters.id, other));
    forgetProjectTelemetry(universe.projectId);
  });

  test("two overlapping export passes send each batch once", async () => {
    await exportAll();
    collector.reset();
    const traceId = newTraceId();
    await enqueueTelemetry(
      universe.projectId,
      "traces",
      oneSpan(traceId, "once"),
      traceId,
    );
    await Promise.all([exportAll(), exportAll(), exportAll()]);
    await exportAll();
    expect(collector.spans().filter((s) => s.name === "once")).toHaveLength(1);
  });

  test("429 honours Retry-After", async () => {
    const traceId = newTraceId();
    await enqueueTelemetry(
      universe.projectId,
      "traces",
      oneSpan(traceId),
      traceId,
    );
    collector.fail(429, 1, "120");
    await exportAll();
    const ttl = await api.redis.redis.pttl(`telemetry:backoff:${exporterId}`);
    expect(ttl).toBeGreaterThan(100_000);
    expect(ttl).toBeLessThanOrEqual(120_000);
    await api.redis.redis.del(`telemetry:backoff:${exporterId}`);
    await exportAll();
  });

  test("a refusal that is not retryable drops the batch and says so", async () => {
    collector.reset();
    const traceId = newTraceId();
    await enqueueTelemetry(
      universe.projectId,
      "traces",
      oneSpan(traceId, "refused"),
      traceId,
    );
    collector.fail(400, 1);
    const report = await exportAll();
    expect(report.dropped[exporterId]).toBe(1);
    await exportAll();
    expect(collector.spans().some((s) => s.name === "refused")).toBe(false);
    const [row] = await api.db.db
      .select()
      .from(telemetryExporters)
      .where(eq(telemetryExporters.id, exporterId));
    expect(row?.lastError).toContain("400");
  });
});

describe("sampling", () => {
  test("each exporter gets its share, the lower a subset of the higher; ratio 0 still gets metrics", async () => {
    await api.db.db
      .delete(telemetryExporters)
      .where(eq(telemetryExporters.projectId, universe.projectId));
    forgetProjectTelemetry(universe.projectId);
    await api.redis.redis.del(streamKey(universe.projectId));
    const low = await createExporter({
      name: "low",
      endpoint: `${collector.url}/low`,
      traceSampleRatio: 0.2,
    });
    const high = await createExporter({
      name: "high",
      endpoint: `${collector.url}/high`,
      traceSampleRatio: 0.6,
    });
    const none = await createExporter({
      name: "none",
      endpoint: `${collector.url}/none`,
      traceSampleRatio: 0,
    });
    expect([low, high, none].every(Boolean)).toBe(true);
    collector.reset();
    const ids: string[] = [];
    for (let i = 0; i < 400; i++) {
      const traceId = newTraceId();
      ids.push(traceId);
      await enqueueTelemetry(
        universe.projectId,
        "traces",
        oneSpan(traceId),
        traceId,
      );
    }
    await enqueueTelemetry(universe.projectId, "metrics", {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "always",
                  gauge: {
                    dataPoints: [
                      { timeUnixNano: unixNano(Date.now()), asInt: "1" },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    for (let i = 0; i < 5; i++) await exportAll();
    const kept = (prefix: string) =>
      new Set(collector.spans(prefix).map((s) => s.traceId));
    const lowKept = kept("/low");
    const highKept = kept("/high");
    expect(lowKept.size / 400).toBeGreaterThan(0.1);
    expect(lowKept.size / 400).toBeLessThan(0.3);
    expect(highKept.size / 400).toBeGreaterThan(0.5);
    expect(highKept.size / 400).toBeLessThan(0.7);
    for (const id of lowKept) expect(highKept.has(id)).toBe(true);
    // Exactly the decisions the shared sample number makes.
    expect([...lowKept].sort()).toEqual(
      ids.filter((id) => sampledBy(id, 0.2)).sort(),
    );
    expect(kept("/none").size).toBe(0);
    expect(collector.metrics("/none").map((m) => m.name)).toContain("always");
  }, 60_000);
});
