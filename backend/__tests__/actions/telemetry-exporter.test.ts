import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { api, config } from "keryx";
import {
  EndpointRefused,
  endpointRefusal,
  postToEndpoint,
} from "../../ops/EndpointSafetyOps";
import { emitLogs } from "../../ops/TelemetryOps";
import { exportAll, streamKey } from "../../ops/TelemetryRelayOps";
import { auditLogs } from "../../schema/audit_logs";
import { telemetryExporters } from "../../schema/telemetry_exporters";
import { OtlpCollector } from "../fixtures/otlp-collector";
import {
  authHeaders,
  buildTestUniverse,
  HOOK_TIMEOUT,
  type TestUniverse,
} from "../setup";

/**
 * Telemetry exporters over HTTP: admin-only writes, member reads, audit rows
 * with the headers redacted, a paginated list, header values never answered,
 * `edit` keeping or clearing headers, private endpoints refused, and
 * `test` reporting what the collector said per signal.
 */

let universe: TestUniverse;
let url: string;
const collector = new OtlpCollector();

/** A header value that must never be answered or logged. */
const SECRET = "vendor-key-0f3c9a1b2d";

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
}, HOOK_TIMEOUT);

afterAll(async () => {
  collector.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Call an action as a person.
 * @param sessionId - Their session.
 * @param method - The HTTP method.
 * @param path - The route under /api.
 * @param body - The params.
 * @returns The status and JSON body.
 */
async function call(
  sessionId: string,
  method: string,
  path: string,
  body: Record<string, unknown> = {},
) {
  const params = { projectId: universe.projectId, ...body };
  const res = await fetch(
    method === "GET"
      ? `${url}/api${path}?${new URLSearchParams(Object.entries(params).map(([k, v]): [string, string] => [k, String(v)]))}`
      : `${url}/api${path}`,
    {
      method,
      headers: authHeaders(sessionId),
      body: method === "GET" ? undefined : JSON.stringify(params),
    },
  );
  // biome-ignore lint/suspicious/noExplicitAny: assertions read whatever the action answered.
  return { status: res.status, body: (await res.json()) as any };
}

describe("telemetry-exporter CRUD", () => {
  let id: number;

  test("an admin creates one; header values are sealed and never answered", async () => {
    const { status, body } = await call(
      universe.peach.sessionId,
      "PUT",
      "/telemetry-exporter",
      {
        name: "vendor",
        endpoint: `${collector.url}/vendor/v1/traces`,
        headers: { "x-api-key": SECRET },
        content: "content",
        traceSampleRatio: 0.5,
        resourceAttributes: { "deployment.environment": "test" },
      },
    );
    expect(status).toBe(200);
    const exporter = body.telemetryExporter;
    id = exporter.id;
    expect(exporter).toMatchObject({
      name: "vendor",
      endpoint: `${collector.url}/vendor`,
      protocol: "http/protobuf",
      headerNames: ["x-api-key"],
      signals: ["traces", "metrics", "logs"],
      content: "content",
      agentNative: true,
      traceSampleRatio: 0.5,
      enabled: true,
    });
    expect(JSON.stringify(body)).not.toContain(SECRET);
    const [row] = await api.db.db
      .select()
      .from(telemetryExporters)
      .where(eq(telemetryExporters.id, id));
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect(row?.headersEncrypted).not.toBeNull();
  });

  test("the audit row is written, and the headers are not in it", async () => {
    const [row] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "telemetry-exporter:create"))
      .orderBy(desc(auditLogs.id));
    expect(row?.targetType).toBe("telemetry_exporter");
    expect(row?.targetPath).toBe("vendor");
    expect(JSON.stringify(row)).not.toContain(SECRET);
    expect((row?.after as { headerNames: string[] }).headerNames).toEqual([
      "x-api-key",
    ]);
  });

  test("members read; only admins write; outsiders get nothing", async () => {
    const list = await call(
      universe.mario.sessionId,
      "GET",
      "/telemetry-exporters",
    );
    expect(list.status).toBe(200);
    expect(
      list.body.telemetryExporters.map((e: { name: string }) => e.name),
    ).toEqual(["vendor"]);
    expect(list.body.pagination).toEqual({
      page: 1,
      limit: 25,
      total: 1,
      pages: 1,
    });
    const view = await call(
      universe.mario.sessionId,
      "GET",
      `/telemetry-exporter/${id}`,
    );
    expect(view.status).toBe(200);
    expect(JSON.stringify(view.body)).not.toContain(SECRET);

    for (const [method, path, extra] of [
      ["PUT", "/telemetry-exporter", { name: "x", endpoint: collector.url }],
      ["POST", `/telemetry-exporter/${id}`, { name: "renamed" }],
      ["DELETE", `/telemetry-exporter/${id}`, {}],
      ["POST", `/telemetry-exporter/${id}/test`, {}],
    ] as const) {
      const res = await call(universe.mario.sessionId, method, path, extra);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
    const outside = await call(
      universe.bowser.sessionId,
      "GET",
      "/telemetry-exporters",
    );
    expect(outside.status).toBe(403);
  });

  test("the list is paginated", async () => {
    for (const name of ["b", "c"]) {
      await call(universe.peach.sessionId, "PUT", "/telemetry-exporter", {
        name,
        endpoint: collector.url,
        enabled: false,
      });
    }
    const page = await call(
      universe.peach.sessionId,
      "GET",
      "/telemetry-exporters",
      { limit: 2, page: 2 },
    );
    expect(
      page.body.telemetryExporters.map((e: { name: string }) => e.name),
    ).toEqual(["c"]);
    expect(page.body.pagination).toEqual({
      page: 2,
      limit: 2,
      total: 3,
      pages: 2,
    });
  });

  test("a taken name is refused", async () => {
    const res = await call(
      universe.peach.sessionId,
      "PUT",
      "/telemetry-exporter",
      {
        name: "vendor",
        endpoint: collector.url,
      },
    );
    expect(res.status).toBe(406);
    expect(res.body.error.message).toContain("already exists");
  });

  test("edit without headers keeps them; {} clears them", async () => {
    const kept = await call(
      universe.peach.sessionId,
      "POST",
      `/telemetry-exporter/${id}`,
      { content: "full" },
    );
    expect(kept.body.telemetryExporter.headerNames).toEqual(["x-api-key"]);
    expect(kept.body.telemetryExporter.content).toBe("full");
    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "telemetry-exporter:edit"))
      .orderBy(desc(auditLogs.id));
    expect((audit?.before as { content: string }).content).toBe("content");
    expect((audit?.after as { content: string }).content).toBe("full");

    const replaced = await call(
      universe.peach.sessionId,
      "POST",
      `/telemetry-exporter/${id}`,
      { headers: { authorization: `Bearer ${SECRET}`, "x-tenant": "t1" } },
    );
    expect(replaced.body.telemetryExporter.headerNames).toEqual([
      "authorization",
      "x-tenant",
    ]);
    const cleared = await call(
      universe.peach.sessionId,
      "POST",
      `/telemetry-exporter/${id}`,
      { headers: {} },
    );
    expect(cleared.body.telemetryExporter.headerNames).toEqual([]);
    const [row] = await api.db.db
      .select()
      .from(telemetryExporters)
      .where(eq(telemetryExporters.id, id));
    expect(row?.headersEncrypted).toBeNull();
    // And put them back for the tests below.
    await call(universe.peach.sessionId, "POST", `/telemetry-exporter/${id}`, {
      headers: { "x-api-key": SECRET },
      content: "metadata",
    });
  });

  test("test sends a probe per signal and reports what the collector said", async () => {
    collector.reset();
    const ok = await call(
      universe.peach.sessionId,
      "POST",
      `/telemetry-exporter/${id}/test`,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);
    expect(
      ok.body.results.map((r: { signal: string; status: number }) => [
        r.signal,
        r.status,
      ]),
    ).toEqual([
      ["traces", 200],
      ["metrics", 200],
      ["logs", 200],
    ]);
    expect(collector.requests.map((r) => r.path).sort()).toEqual([
      "/vendor/v1/logs",
      "/vendor/v1/metrics",
      "/vendor/v1/traces",
    ]);
    // The collector got the exporter's own headers, protobuf, gzipped.
    for (const r of collector.requests) {
      expect(r.headers["x-api-key"]).toBe(SECRET);
      expect(r.contentType).toBe("application/x-protobuf");
      expect(r.headers["content-encoding"]).toBe("gzip");
    }
    expect(collector.spans()[0]?.resource["deployment.environment"]).toBe(
      "test",
    );

    collector.reset();
    collector.fail(503, 1);
    const failed = await call(
      universe.peach.sessionId,
      "POST",
      `/telemetry-exporter/${id}/test`,
    );
    expect(failed.body.ok).toBe(false);
    expect(failed.body.results[0]).toMatchObject({
      signal: "traces",
      ok: false,
      status: 503,
    });
    expect(failed.body.results[1]).toMatchObject({
      signal: "metrics",
      ok: true,
    });
  });

  test("an admin's decision on the project is exported as a log", async () => {
    collector.reset();
    await api.redis.redis.del(streamKey(universe.projectId));
    await call(universe.peach.sessionId, "POST", `/telemetry-exporter/${id}`, {
      traceSampleRatio: 1,
    });
    await exportAll();
    const audit = collector
      .logs("/vendor")
      .filter((l) => l.eventName === "hypotenuse.audit");
    expect(audit.map((l) => l.attrs["hypotenuse.audit.action"])).toEqual([
      "telemetry-exporter:edit",
    ]);
    expect(audit[0]?.attrs["hypotenuse.audit.target"]).toBe("vendor");
  });

  test("delete removes it, audited", async () => {
    const res = await call(
      universe.peach.sessionId,
      "DELETE",
      `/telemetry-exporter/${id}`,
    );
    expect(res.body).toEqual({ success: true });
    const gone = await call(
      universe.peach.sessionId,
      "GET",
      `/telemetry-exporter/${id}`,
    );
    expect(gone.status).toBe(404);
    const [audit] = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "telemetry-exporter:delete"))
      .orderBy(desc(auditLogs.id));
    expect(audit?.targetPath).toBe("vendor");
    expect(JSON.stringify(audit)).not.toContain(SECRET);
  });
});

describe("endpoint safety", () => {
  test("with private endpoints refused, loopback, private, and http are refused at write", async () => {
    const before = config.telemetry.allowPrivateEndpoints;
    config.telemetry.allowPrivateEndpoints = false;
    try {
      for (const endpoint of [
        "http://collector.example.com",
        "https://127.0.0.1:4318",
        "https://localhost:4318",
        "https://10.1.2.3",
        "https://169.254.169.254",
        "https://[::1]:4318",
        "https://otel.internal",
        "https://user:pass@collector.example.com",
      ]) {
        const res = await call(
          universe.peach.sessionId,
          "PUT",
          "/telemetry-exporter",
          { name: `bad-${endpoint.length}`, endpoint },
        );
        expect(res.status, endpoint).toBe(406);
      }
    } finally {
      config.telemetry.allowPrivateEndpoints = before;
    }
  });

  test("a public name that resolves to a private address is refused", async () => {
    const resolve = async (host: string) =>
      host === "sneaky.example.com"
        ? ["93.184.216.34", "10.0.0.5"]
        : ["93.184.216.34"];
    expect(
      await endpointRefusal("https://sneaky.example.com", {
        allowPrivate: false,
        resolve,
      }),
    ).toContain("10.0.0.5");
    expect(
      await endpointRefusal("https://fine.example.com", {
        allowPrivate: false,
        resolve,
      }),
    ).toBeNull();
    expect(
      await endpointRefusal("https://nowhere.example.com", {
        allowPrivate: false,
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).toContain("does not resolve");
  });

  test("the export connects only to the address it checked: a rebinding answer is refused", async () => {
    // Public when the endpoint was checked; private when the export connects.
    await expect(
      postToEndpoint("https://rebind.example.com/v1/traces", {
        headers: {},
        body: new Uint8Array(0),
        timeoutMs: 2000,
        allowPrivate: false,
        resolve: async () => ["169.254.169.254"],
      }),
    ).rejects.toBeInstanceOf(EndpointRefused);
    // A DNS failure is not a refusal: it may pass, and the export retries.
    const failed = await postToEndpoint("https://flaky.example.com/v1/traces", {
      headers: {},
      body: new Uint8Array(0),
      timeoutMs: 2000,
      allowPrivate: false,
      resolve: async () => {
        throw new Error("EAI_AGAIN");
      },
    }).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(EndpointRefused);
    // And the address it checked is the one it connects to, whatever the name.
    collector.reset();
    const pinned = await postToEndpoint(
      `http://pinned.example.invalid:${new URL(collector.url).port}/pin/v1/logs`,
      {
        headers: { "Content-Type": "application/json" },
        body: new TextEncoder().encode(JSON.stringify({ resourceLogs: [] })),
        timeoutMs: 2000,
        allowPrivate: true,
        resolve: async () => ["127.0.0.1"],
      },
    );
    expect(pinned.status).toBe(200);
    expect(collector.requests.map((r) => r.path)).toEqual(["/pin/v1/logs"]);
  });

  test("an endpoint that turned private is refused at export too", async () => {
    const created = await call(
      universe.peach.sessionId,
      "PUT",
      "/telemetry-exporter",
      { name: "turned", endpoint: `${collector.url}/turned` },
    );
    const exporterId = created.body.telemetryExporter.id;
    collector.reset();
    await emitLogs(universe.projectId, [{ atMs: Date.now(), body: "hello" }]);
    const before = config.telemetry.allowPrivateEndpoints;
    config.telemetry.allowPrivateEndpoints = false;
    try {
      const report = await exportAll();
      expect(report.dropped[exporterId]).toBeGreaterThan(0);
    } finally {
      config.telemetry.allowPrivateEndpoints = before;
    }
    expect(collector.requests).toEqual([]);
    const [row] = await api.db.db
      .select()
      .from(telemetryExporters)
      .where(eq(telemetryExporters.id, exporterId));
    expect(row?.lastError).toBe("The endpoint must use https.");
  });
});
