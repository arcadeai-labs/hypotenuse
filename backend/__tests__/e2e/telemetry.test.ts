import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  CONTENT_ATTRIBUTE_PREFIX,
  LEVEL_ATTRIBUTE,
} from "@hypotenuse/protocol";
import { eq, ne } from "drizzle-orm";
import { api } from "keryx";
import { decryptSecret } from "../../ops/CryptoOps";
import { runners } from "../../schema/runners";
import { workItems } from "../../schema/work_items";
import type { DaemonHome } from "../daemon/helpers";
import { until } from "../daemon/helpers";
import {
  OtlpCollector,
  type ReceivedLog,
  type ReceivedSpan,
} from "../fixtures/otlp-collector";
import { appToken, integrationRow } from "../linear/helpers";
import { authHeaders, HOOK_TIMEOUT, runAction } from "../setup";
import { bodies, useE2E } from "./harness";

/**
 * Telemetry export, end to end: a project with two exporters (one at `full`,
 * one at `metadata`), a real daemon running the fake agent's `otel` scenario,
 * and the test collector standing in for a vendor. One turn arrives as **one
 * trace** — the server's `turn` span at its root, the daemon's tree under it,
 * the server's spans for the daemon's calls under the daemon spans they were
 * made from, and the agent's own telemetry joined in — and each exporter
 * receives exactly its level. No secret of the run reaches either. Then each
 * row of the runner owner's cap table, one runner at a time.
 */

const e2e = useE2E();
const collector = new OtlpCollector();

/** The full exporter's header value. */
const HEADER_SECRET = "vendor-api-key-7d1e2f3a4b";
/** A value the daemon resolves from `$E2E_SERVICE_TOKEN` in its config. */
const ENV_SECRET = "svc-token-91c2b3a4d5e6";

/** The agent table: the fake agent, with a `$VAR` env value. */
const AGENT = `command = ["bun", "${new URL("../../../cli/__tests__/fixtures/fake-acp-agent.ts", import.meta.url).pathname}"]\nenv = { MY_SERVICE_TOKEN = "$E2E_SERVICE_TOKEN" }`;

let home: DaemonHome;

/**
 * Create an exporter as Peach, the project's admin.
 * @param body - The exporter.
 * @returns Its id.
 */
async function createExporter(body: Record<string, unknown>): Promise<number> {
  const res = await fetch(`${e2e.universe.url}/api/telemetry-exporter`, {
    method: "PUT",
    headers: authHeaders(e2e.universe.peach.sessionId),
    body: JSON.stringify({ projectId: e2e.universe.projectId, ...body }),
  });
  const json = (await res.json()) as { telemetryExporter: { id: number } };
  if (!json.telemetryExporter) throw new Error(JSON.stringify(json));
  return json.telemetryExporter.id;
}

/**
 * Make one runner the only one routing can choose.
 * @param keep - The runner to keep enabled.
 */
async function only(keep: DaemonHome): Promise<void> {
  await api.db.db
    .update(runners)
    .set({ enabled: false })
    .where(ne(runners.id, keep.runner.id));
  await api.db.db
    .update(runners)
    .set({ enabled: true })
    .where(eq(runners.id, keep.runner.id));
}

/**
 * Delegate an issue and wait for the turn to answer and its trace to land.
 * @param title - The issue title.
 * @returns The session's first turn, and the trace's spans for an exporter.
 */
async function runTurn(title: string) {
  const delegated = await e2e.delegate(title);
  await e2e.linearSession(
    delegated.externalSessionId,
    (s) =>
      bodies(s, "AgentActivityResponseContent").length +
        bodies(s, "AgentActivityErrorContent").length >
      0,
    60_000,
  );
  const item = await until(async () => {
    const [row] = await api.db.db
      .select()
      .from(workItems)
      .where(eq(workItems.agentSessionId, delegated.agentSessionId));
    return row?.finishedAt ? row : null;
  }, 30_000);
  const traceId = item.traceparent.split("-")[1] as string;
  return { ...delegated, item, traceId };
}

/**
 * The spans of one trace an exporter received.
 * @param prefix - The exporter's path.
 * @param traceId - The trace.
 * @returns The spans.
 */
function traceSpans(prefix: string, traceId: string): ReceivedSpan[] {
  return collector.spans(prefix).filter((s) => s.traceId === traceId);
}

/**
 * Wait until an exporter has a trace's root and daemon spans.
 * @param prefix - The exporter's path.
 * @param traceId - The trace.
 * @param names - Span names that must be there.
 * @returns The spans.
 */
async function waitForTrace(
  prefix: string,
  traceId: string,
  names: string[],
): Promise<ReceivedSpan[]> {
  return until(async () => {
    const spans = traceSpans(prefix, traceId);
    const have = new Set(spans.map((s) => s.name));
    return names.every((n) => have.has(n)) ? spans : null;
  }, 30_000);
}

/**
 * A trace's shape: every distinct `parent → child` edge by span name, with
 * `linear.graphql <op>` names collapsed — compared whole, not spot-checked.
 * @param spans - The trace's spans.
 * @returns The sorted edges.
 */
function shape(spans: ReceivedSpan[]): string[] {
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const name = (s: ReceivedSpan) =>
    s.name.startsWith("linear.graphql ") ? "linear.graphql" : s.name;
  const edges = new Set<string>();
  for (const s of spans) {
    const parent = s.parentSpanId ? byId.get(s.parentSpanId) : undefined;
    edges.add(`${parent ? name(parent) : "(root)"} → ${name(s)}`);
  }
  return [...edges].sort();
}

beforeAll(async () => {
  await createExporter({
    name: "full",
    endpoint: `${collector.url}/full`,
    protocol: "http/json",
    content: "full",
    headers: { "x-api-key": HEADER_SECRET },
  });
  await createExporter({
    name: "meta",
    endpoint: `${collector.url}/meta`,
    content: "metadata",
  });
  home = await e2e.daemon(e2e.universe.mario, "otel-laptop", {
    scenario: "otel",
    agent: AGENT,
    env: { E2E_SERVICE_TOKEN: ENV_SECRET },
  });
}, HOOK_TIMEOUT);

afterAll(() => {
  collector.stop();
});

describe("one turn, one trace", () => {
  let turn: Awaited<ReturnType<typeof runTurn>>;
  let spans: ReceivedSpan[];

  test("the whole tree: server, daemon, the server's spans for the daemon's calls, and the agent's own", async () => {
    turn = await runTurn("Fix the rounding, traced");
    spans = await waitForTrace("/full", turn.traceId, [
      "turn",
      "daemon.turn",
      "daemon:complete",
      "fake.model_request",
      "worktree.cleanup",
    ]);
    const roots = spans.filter((s) => !s.parentSpanId);
    expect(roots.map((s) => s.name)).toEqual(["turn"]);
    expect(shape(spans)).toEqual(
      [
        "(root) → turn",
        "turn → linear.webhook",
        "turn → routing.select",
        "routing.select → linear.graphql",
        "turn → routing.offer",
        "turn → routing.claim",
        "turn → outbox.deliver",
        "outbox.deliver → linear.graphql",
        "turn → daemon.turn",
        "daemon.turn → worktree.prepare",
        "daemon.turn → agent.spawn",
        "daemon.turn → acp.initialize",
        "daemon.turn → acp.session.new",
        "daemon.turn → acp.prompt",
        "daemon.turn → daemon:events",
        "daemon.turn → daemon:complete",
        "daemon.turn → worktree.cleanup",
        "acp.prompt → tool_call",
        "acp.prompt → mcp.call",
        "mcp.call → daemon:linear-get-issue",
        "daemon:linear-get-issue → linear.graphql",
        // The agent honoured TRACEPARENT: its span is under the prompt.
        "acp.prompt → fake.model_request",
        // The one it sent in a trace of its own is moved under the turn.
        "daemon.turn → fake.model_request",
      ].sort(),
    );
  }, 120_000);

  test("every resource and root span names the turn", () => {
    const root = spans.find((s) => s.name === "turn") as ReceivedSpan;
    expect(root.attrs).toMatchObject({
      "hypotenuse.project.id": e2e.universe.projectId,
      "hypotenuse.session.id": turn.agentSessionId,
      "hypotenuse.work_item.id": turn.item.id,
      "hypotenuse.turn": 1,
      "hypotenuse.role": "worker",
      "hypotenuse.runner.id": home.runner.id,
      "hypotenuse.runner.name": "otel-laptop",
      "hypotenuse.agent.id": "claude",
      "linear.issue.identifier": turn.issue.identifier,
      "linear.agent_session.id": turn.externalSessionId,
      "hypotenuse.repository": "github.com/acme/web",
    });
    for (const s of spans.filter(
      (s) => s.resource["hypotenuse.source"] !== "server",
    )) {
      expect(s.resource["hypotenuse.work_item.id"], s.name).toBe(turn.item.id);
      expect(s.resource["hypotenuse.runner.id"], s.name).toBe(home.runner.id);
    }
    const native = spans.filter((s) => s.name === "fake.model_request");
    for (const s of native) {
      expect(s.resource["hypotenuse.source"]).toBe("agent_native");
      expect(s.resource["service.name"]).toBe("fake-agent");
    }
  });

  test("each tool call is a span with its result; the turn's items are recorded", () => {
    const tools = spans.filter((s) => s.name === "tool_call");
    // The edit, the shell command, and the MCP call the agent reported.
    expect(tools).toHaveLength(3);
    const edit = tools.find((t) => t.attrs["gen_ai.tool.call.id"] === "edit-1");
    expect(edit?.attrs).toMatchObject({
      "gen_ai.tool.type": "edit",
      "hypotenuse.tool.status": "completed",
      "hypotenuse.tool.locations": "src/a.ts",
    });
    expect(
      String(edit?.attrs[`${CONTENT_ATTRIBUTE_PREFIX}tool.input`]),
    ).toContain("Math.round");
    const prompt = spans.find((s) => s.name === "acp.prompt");
    expect(prompt?.attrs["gen_ai.response.finish_reasons"]).toBe("end_turn");
    expect(prompt?.events?.map((e) => e.name)).toEqual(
      expect.arrayContaining(["agent.thought", "plan", "agent.message"]),
    );
  });

  test("the full exporter gets every ACP frame; the metadata one gets no free text at all", async () => {
    const fullLogs = await until(async () => {
      const logs = collector
        .logs("/full")
        .filter((l) => l.traceId === turn.traceId);
      return logs.some((l) => l.eventName === "acp.frame") ? logs : null;
    });
    const frames = fullLogs.filter((l) => l.eventName === "acp.frame");
    const methods = new Set(frames.map((f) => f.attrs["rpc.method"]));
    for (const m of [
      "initialize",
      "session/new",
      "session/prompt",
      "session/update",
    ])
      expect(methods.has(m), m).toBe(true);
    expect(fullLogs.some((l) => l.eventName === "agent.stderr")).toBe(true);
    // Native logs, collected at the turn's level, reach the full exporter.
    expect(
      fullLogs.some((l) => l.body?.stringValue === "fake.api_request"),
    ).toBe(true);

    const metaSpans = traceSpans("/meta", turn.traceId);
    expect(metaSpans.length).toBeGreaterThan(10);
    const leaked = metaSpans
      .flatMap((s) => [
        ...Object.keys(s.attrs),
        ...(s.events ?? []).flatMap((e) =>
          (e.attributes ?? []).map((a) => a.key),
        ),
      ])
      .filter((k) => k.startsWith(CONTENT_ATTRIBUTE_PREFIX));
    expect(leaked).toEqual([]);
    const metaLogs: ReceivedLog[] = collector
      .logs("/meta")
      .filter((l) => l.traceId === turn.traceId);
    expect(
      metaLogs.filter(
        (l) => (l.attrs[LEVEL_ATTRIBUTE] ?? "metadata") !== "metadata",
      ),
    ).toEqual([]);
    // The agent's own telemetry was collected at full, so it goes to full only.
    expect(metaSpans.some((s) => s.name === "fake.model_request")).toBe(false);
    // The full exporter got its headers; the relay sent JSON.
    const fullRequest = collector.requests.find((r) =>
      r.path.startsWith("/full"),
    );
    expect(fullRequest?.headers["x-api-key"]).toBe(HEADER_SECRET);
    expect(fullRequest?.contentType).toBe("application/json");
  });

  test("metrics arrive: token usage, Linear requests, slots, and runners", async () => {
    const names = await until(async () => {
      const have = new Set(collector.metrics("/meta").map((m) => m.name));
      return [
        "hypotenuse.linear.requests",
        "hypotenuse.runner.slots",
        "hypotenuse.runners.online",
        "fake.token.usage",
      ].every((n) => have.has(n))
        ? have
        : null;
    });
    expect(names.has("hypotenuse.outbox.lag")).toBe(true);
  });

  test("no secret of the run reaches any collector", async () => {
    const integration = await integrationRow(e2e.universe.projectId);
    const accessToken = await appToken(e2e.universe.projectId);
    const refreshToken = integration.refreshTokenEncrypted
      ? decryptSecret(integration.refreshTokenEncrypted)
      : null;
    const received = home.received();
    const mcpNonce = JSON.stringify(received).match(
      /"--nonce","([0-9a-f]{32})"/,
    )?.[1];
    const posted = received.find((r) => r.method === "otel/posted");
    const receiverNonce = String(
      (posted?.params as { endpoint?: string } | undefined)?.endpoint ?? "",
    )
      .split("/")
      .at(-1);
    const secrets = {
      runnerToken: home.runner.token,
      headerSecret: HEADER_SECRET,
      envSecret: ENV_SECRET,
      accessToken,
      refreshToken,
      mcpNonce,
      receiverNonce,
    };
    for (const [name, value] of Object.entries(secrets))
      expect(value, `${name} is known to the test`).toBeTruthy();
    // The shell step echoed the env secret, so the agent did report it: as
    // the command's output, redacted.
    const shell = spans.find((s) =>
      String(s.attrs[`${CONTENT_ATTRIBUTE_PREFIX}tool.input`] ?? "").includes(
        "echo the token is",
      ),
    );
    expect(
      String(shell?.attrs[`${CONTENT_ATTRIBUTE_PREFIX}tool.output`]),
    ).toContain("the token is [REDACTED]");
    const everything = collector.everything();
    for (const [name, value] of Object.entries(secrets))
      expect(everything.includes(String(value)), name).toBe(false);
  });

  test("the dashboard says what the turn collected", async () => {
    const res = await fetch(
      `${e2e.universe.url}/api/agent-session/${turn.agentSessionId}?projectId=${e2e.universe.projectId}`,
      { headers: authHeaders(e2e.universe.mario.sessionId) },
    );
    const body = (await res.json()) as {
      workItems?: { telemetry: unknown }[];
    };
    expect(body.workItems?.[0]?.telemetry).toEqual({
      content: "full",
      agentNative: true,
      sampled: true,
      note: null,
      traceId: turn.traceId,
    });
  });
});

describe("the runner owner's cap", () => {
  /**
   * Run a turn on a fresh runner with a `[telemetry]` table.
   * @param name - The runner.
   * @param table - The table's keys.
   * @returns The turn.
   */
  async function capped(name: string, table: string) {
    const capHome = await e2e.daemon(e2e.universe.luigi, name, {
      scenario: "otel",
      agent: AGENT,
      env: { E2E_SERVICE_TOKEN: ENV_SECRET },
      extraConfig: `[telemetry]\n${table}`,
    });
    await only(capHome);
    const t = await runTurn(`Capped by ${name}`);
    return { home: capHome, ...t };
  }

  test("cap below the exporters': collected at the cap, and the transcript says so", async () => {
    const t = await capped("cap-content", 'max_content = "content"');
    expect(t.item.telemetry).toEqual({
      content: "content",
      agentNative: true,
      sampled: true,
      note: "telemetry capped at `content` by runner `cap-content`",
    });
    const spans = await waitForTrace("/full", t.traceId, [
      "daemon.turn",
      "acp.prompt",
    ]);
    expect(
      spans.find((s) => s.name === "daemon.turn")?.attrs[
        "hypotenuse.telemetry.content"
      ],
    ).toBe("content");
    const logs = collector.logs("/full").filter((l) => l.traceId === t.traceId);
    expect(logs.some((l) => l.eventName === "acp.frame")).toBe(false);
    expect(logs.some((l) => l.eventName === "agent.stderr")).toBe(true);
    await t.home.kill();
  }, 120_000);

  test("native off: no receiver, no agent spans, and the transcript says so", async () => {
    const t = await capped("no-native", "agent_native = false");
    expect(t.item.telemetry).toEqual({
      content: "full",
      agentNative: false,
      sampled: true,
      note: "native agent telemetry disabled on runner `no-native`",
    });
    const spans = await waitForTrace("/full", t.traceId, [
      "daemon.turn",
      "acp.prompt",
    ]);
    expect(spans.some((s) => s.name === "fake.model_request")).toBe(false);
    const posted = t.home.received().find((r) => r.method === "otel/posted");
    expect(posted?.params).toEqual({ skipped: "no endpoint" });
    await t.home.kill();
  }, 120_000);

  test("telemetry off: server spans only, and the transcript says so", async () => {
    const t = await capped("no-telemetry", "enabled = false");
    expect(t.item.telemetry).toEqual({
      content: null,
      agentNative: false,
      sampled: true,
      note: "runner `no-telemetry` sends no telemetry",
    });
    const spans = await waitForTrace("/full", t.traceId, [
      "turn",
      "routing.claim",
    ]);
    expect(
      spans.filter((s) => s.resource["hypotenuse.source"] !== "server"),
    ).toEqual([]);
    await t.home.kill();
  }, 120_000);

  test("everything allowed, native off at the exporters: collected at their level, no native", async () => {
    await api.db.db
      .update(runners)
      .set({ enabled: true })
      .where(eq(runners.id, home.runner.id));
    await only(home);
    for (const name of ["full", "meta"]) {
      const res = await fetch(
        `${e2e.universe.url}/api/telemetry-exporters?projectId=${e2e.universe.projectId}`,
        {
          headers: authHeaders(e2e.universe.peach.sessionId),
        },
      );
      const { telemetryExporters } = (await res.json()) as {
        telemetryExporters: { id: number; name: string }[];
      };
      const id = telemetryExporters.find((x) => x.name === name)?.id;
      await fetch(`${e2e.universe.url}/api/telemetry-exporter/${id}`, {
        method: "POST",
        headers: authHeaders(e2e.universe.peach.sessionId),
        body: JSON.stringify({
          projectId: e2e.universe.projectId,
          agentNative: false,
        }),
      });
    }
    const t = await runTurn("No native wanted");
    expect(t.item.telemetry).toEqual({
      content: "full",
      agentNative: false,
      sampled: true,
      note: null,
    });
    const spans = await waitForTrace("/full", t.traceId, [
      "daemon.turn",
      "acp.prompt",
    ]);
    expect(spans.some((s) => s.name === "fake.model_request")).toBe(false);
  }, 120_000);

  test("no exporter: the claim carries no telemetry and nothing is recorded", async () => {
    const res = await fetch(
      `${e2e.universe.url}/api/telemetry-exporters?projectId=${e2e.universe.projectId}`,
      {
        headers: authHeaders(e2e.universe.peach.sessionId),
      },
    );
    const { telemetryExporters } = (await res.json()) as {
      telemetryExporters: { id: number }[];
    };
    for (const x of telemetryExporters)
      await fetch(`${e2e.universe.url}/api/telemetry-exporter/${x.id}`, {
        method: "POST",
        headers: authHeaders(e2e.universe.peach.sessionId),
        body: JSON.stringify({
          projectId: e2e.universe.projectId,
          enabled: false,
        }),
      });
    const before = collector.requests.length;
    const t = await runTurn("Nobody exports this");
    expect(t.item.telemetry).toBeNull();
    // The pump runs the export clock; two more passes leave nothing queued.
    await runAction("telemetry:export");
    await runAction("telemetry:export");
    expect(
      collector.requests
        .slice(before)
        .filter((r) => JSON.stringify(r.decoded).includes(t.traceId)),
    ).toEqual([]);
  }, 120_000);
});
