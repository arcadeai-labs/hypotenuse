import { describe, expect, test } from "bun:test";
import { ApiError } from "../../src/api/client";
import { RpcError } from "../../src/daemon/control-socket";
import {
  type BrokerTurn,
  type CallAnswer,
  McpBroker,
  NONCE_REFUSED,
} from "../../src/daemon/mcp-broker";
import { ReadCache } from "../../src/mcp/cache";

/**
 * The daemon's broker for `hypotenuse mcp`: nonces per turn, the role's
 * tools, the per-turn read cache, and the order a question is posted in.
 */

/** A transport that records calls and answers what a test scripts. */
function transport(answer: (route: string) => unknown = () => ({})) {
  const calls: { route: string; body: Record<string, unknown> }[] = [];
  return {
    calls,
    tool: async (route: string, body: Record<string, unknown>) => {
      calls.push({ route, body });
      const scripted = answer(route);
      if (scripted instanceof Error) throw scripted;
      return {
        text: `ok ${route}`,
        data: (scripted as Record<string, unknown>) ?? {},
      };
    },
  };
}

/** A turn with recording hooks. */
function turn(over: Partial<BrokerTurn> = {}) {
  const events: string[] = [];
  const t: BrokerTurn = {
    agentSessionId: 7,
    workItemId: 70,
    role: "worker",
    issueIdentifier: "ENG-7",
    askingUser: (asking) => events.push(`asking:${asking}`),
    settle: async () => {
      events.push("settled");
    },
    reportedPullRequest: (url) => events.push(`pr:${url}`),
    ...over,
  };
  return { t, events };
}

/**
 * What a refused call threw.
 * @param fn - The call.
 * @returns The RpcError.
 */
async function refused(fn: () => unknown): Promise<RpcError> {
  try {
    await fn();
  } catch (e) {
    return e as RpcError;
  }
  throw new Error("expected a refusal");
}

describe("nonces", () => {
  test("hello answers the role's tools for the live turn", () => {
    const broker = new McpBroker(transport());
    const nonce = broker.register(turn().t);
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    const hello = broker.hello({ agentSessionId: 7, nonce });
    expect(hello.role).toBe("worker");
    expect(hello.tools).toHaveLength(8);
    expect(hello.issueIdentifier).toBe("ENG-7");
  });

  test("a nonce from a finished turn is refused", async () => {
    const broker = new McpBroker(transport());
    const nonce = broker.register(turn().t);
    broker.end(nonce);
    const e = await refused(() => broker.hello({ agentSessionId: 7, nonce }));
    expect(e.code).toBe(NONCE_REFUSED);
    const c = await refused(() =>
      broker.call({ agentSessionId: 7, nonce, tool: "linear_get_issue" }),
    );
    expect(c.code).toBe(NONCE_REFUSED);
  });

  test("session A's nonce with session B's id is refused", async () => {
    const broker = new McpBroker(transport());
    const a = broker.register(turn().t);
    broker.register(turn({ agentSessionId: 8, workItemId: 80 }).t);
    const e = await refused(() =>
      broker.call({ agentSessionId: 8, nonce: a, tool: "linear_get_issue" }),
    );
    expect(e.code).toBe(NONCE_REFUSED);
  });
});

describe("calls", () => {
  test("a worker cannot call a manager tool, and bad input is a tool error", async () => {
    const wire = transport();
    const broker = new McpBroker(wire);
    const nonce = broker.register(turn().t);
    const manager = await broker.call({
      agentSessionId: 7,
      nonce,
      tool: "linear_create_issue",
      input: { title: "x" },
    });
    expect(manager.isError).toBe(true);
    const bad = await broker.call({
      agentSessionId: 7,
      nonce,
      tool: "linear_comment",
      input: { body: 3 },
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("body");
    expect(wire.calls).toEqual([]);
  });

  test("a read is cached for 60 s and emptied by a write", async () => {
    let now = 1_000;
    const wire = transport();
    const broker = new McpBroker(
      wire,
      () => {},
      new ReadCache<CallAnswer>(60_000, () => now),
    );
    const nonce = broker.register(turn().t);
    const read = () =>
      broker.call({
        agentSessionId: 7,
        nonce,
        tool: "linear_get_issue",
        input: {},
      });
    await read();
    await read();
    expect(wire.calls).toHaveLength(1);
    now += 60_001;
    await read();
    expect(wire.calls).toHaveLength(2);

    await broker.call({
      agentSessionId: 7,
      nonce,
      tool: "linear_comment",
      input: { body: "hi" },
    });
    await read();
    expect(wire.calls.map((c) => c.route)).toEqual([
      "/daemon/linear/get-issue",
      "/daemon/linear/get-issue",
      "/daemon/linear/comment",
      "/daemon/linear/get-issue",
    ]);
    expect(wire.calls[2]?.body).toEqual({ body: "hi", agentSessionId: 7 });
  });

  test("a turn's end empties its cache", async () => {
    const wire = transport();
    const broker = new McpBroker(wire);
    const { t } = turn();
    const first = broker.register(t);
    await broker.call({
      agentSessionId: 7,
      nonce: first,
      tool: "linear_get_issue",
    });
    broker.end(first);
    const second = broker.register(t);
    await broker.call({
      agentSessionId: 7,
      nonce: second,
      tool: "linear_get_issue",
    });
    expect(wire.calls).toHaveLength(2);
  });

  test("a question: the turn stops writing, its events land, then the question goes", async () => {
    const order: string[] = [];
    const wire = transport((route) => {
      order.push(route);
      return {};
    });
    const broker = new McpBroker(wire);
    const { t, events } = turn({
      askingUser: (a) => order.push(`asking:${a}`),
      settle: async () => {
        order.push("settled");
      },
    });
    const nonce = broker.register(t);
    await broker.call({
      agentSessionId: 7,
      nonce,
      tool: "linear_ask_user",
      input: { question: "Which?" },
    });
    expect(order).toEqual([
      "asking:true",
      "settled",
      "/daemon/linear/ask-user",
    ]);
    expect(events).toEqual([]);
  });

  test("a question the server refuses lets the turn write again", async () => {
    const wire = transport(
      () => new ApiError("not permitted for this session", 403),
    );
    const broker = new McpBroker(wire);
    const { t, events } = turn();
    const nonce = broker.register(t);
    const answer = await broker.call({
      agentSessionId: 7,
      nonce,
      tool: "linear_ask_user",
      input: { question: "Which?" },
    });
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain("its turn may have ended");
    expect(events).toEqual(["asking:true", "settled", "asking:false"]);
  });

  test("a linked pull request is told to the turn", async () => {
    const broker = new McpBroker(transport(() => ({ linked: true })));
    const { t, events } = turn();
    const nonce = broker.register(t);
    await broker.call({
      agentSessionId: 7,
      nonce,
      tool: "linear_report_pr",
      input: { url: "https://github.com/acme/web/pull/1" },
    });
    expect(events).toEqual([
      "settled",
      "pr:https://github.com/acme/web/pull/1",
    ]);
  });
});
