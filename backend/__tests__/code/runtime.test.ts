import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { api, config } from "keryx";
import {
  execute,
  type HostAnswer,
  jsonSafe,
  limitsFor,
  type RunOutcome,
} from "../../ops/code/runtime";
import { buildTestUniverse, HOOK_TIMEOUT } from "../setup";

/**
 * The runtime module over Run's QuickJS sandbox: a program runs, TypeScript
 * is stripped, nothing ambient exists, each limit trips with its own error
 * type, and a bot's own limits only ever lower the deployment's.
 */

beforeAll(async () => {
  await buildTestUniverse();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Run a program with one trivial host function, `__hyp.ping`.
 * @param source - The program.
 * @param limits - Limits to override.
 * @returns How it ended.
 */
function runProgram(
  source: string,
  limits: Partial<ReturnType<typeof limitsFor>> = {},
): Promise<RunOutcome> {
  return execute({
    source,
    hostFunctions: {
      ping: async (): Promise<HostAnswer> => ({ ok: true, value: "pong" }),
    },
    limits: { ...limitsFor(), ...limits },
    secret: randomBytes(32),
    audience: "test",
    context: {},
    signal: new AbortController().signal,
  });
}

describe("a program runs", () => {
  test("hello world", async () => {
    expect(await runProgram("return 'hello, world'")).toEqual({
      status: "completed",
      value: "hello, world",
      logs: [],
    });
  });

  test("TypeScript is stripped, top-level await works, console is captured", async () => {
    const outcome = await runProgram(`
      interface Row { day: string; n: number }
      const rows: Row[] = [{ day: "mon", n: 2 }, { day: "tue", n: 3 }];
      const total: number = rows.reduce((s, r) => s + r.n, 0);
      console.log("total", total, { ok: true });
      return await Promise.resolve(total);
    `);
    expect(outcome).toEqual({
      status: "completed",
      value: 5,
      logs: ['total 5 {"ok":true}'],
    });
  });

  test("a value JSON cannot hold comes back as JSON", async () => {
    const outcome = await runProgram(
      "return { big: 2n ** 70n, m: new Map([['a', 1]]), s: new Set([1, 2]), d: new Date(0) }",
    );
    expect(outcome).toMatchObject({
      status: "completed",
      value: {
        big: "1180591620717411303424",
        m: { a: 1 },
        s: [1, 2],
        d: "1970-01-01T00:00:00.000Z",
      },
    });
    expect(jsonSafe(Number.NaN)).toBe("NaN");
  });

  test("fetch, Bun, process, and timers are undefined, and require throws", async () => {
    const outcome = await runProgram(`
      let req = "absent";
      try { require("fs"); req = "loaded"; } catch { req = "threw"; }
      return [typeof fetch, typeof Bun, typeof process, typeof setTimeout, typeof globalThis.require, req];
    `);
    expect(outcome).toMatchObject({
      status: "completed",
      value: [
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "undefined",
        "threw",
      ],
    });
  });
});

describe("failures carry a stable error type", () => {
  test("a syntax error is invalid_source", async () => {
    expect(await runProgram("return (")).toMatchObject({
      status: "failed",
      errorType: "invalid_source",
    });
  });

  test("a throw is program_error, with the console output up to it", async () => {
    expect(
      await runProgram("console.log('before'); throw new TypeError('bad')"),
    ).toMatchObject({
      status: "failed",
      errorType: "program_error",
      message: "TypeError: bad",
      logs: ["before"],
    });
  });

  test("an infinite loop is sandbox_timeout", async () => {
    expect(
      await runProgram("while (true) {}", {
        timeoutMs: 3_000,
        cpuTimeoutMs: 1_000,
      }),
    ).toMatchObject({ status: "failed", errorType: "sandbox_timeout" });
  });

  test("a huge array is sandbox_memory", async () => {
    expect(
      await runProgram(
        "const a = []; for (;;) a.push(new Array(1e6).fill(1));",
        { memoryBytes: 16 * 1024 * 1024 },
      ),
    ).toMatchObject({ status: "failed", errorType: "sandbox_memory" });
  });

  test("300 host calls trip the bridge limit, sandbox_limit", async () => {
    expect(
      await runProgram(
        "for (let i = 0; i < 300; i++) await __hyp.ping(); return 1",
      ),
    ).toMatchObject({ status: "failed", errorType: "sandbox_limit" });
  });

  test("a result over the limit, or one that cannot cross, is sandbox_limit", async () => {
    expect(
      await runProgram("return 'x'.repeat(5000)", { resultBytes: 1000 }),
    ).toMatchObject({ status: "failed", errorType: "sandbox_limit" });
    expect(await runProgram("return () => 1")).toMatchObject({
      status: "failed",
      errorType: "sandbox_limit",
    });
  });

  test("a source over the limit is sandbox_limit, before anything runs", async () => {
    expect(
      await runProgram(`return 1; // ${"x".repeat(2_000)}`, {
        sourceBytes: 1_000,
      }),
    ).toMatchObject({ status: "failed", errorType: "sandbox_limit" });
  });

  test("a guest cannot raise a limit: the console is cut at the policy's size", async () => {
    const outcome = await runProgram(
      "for (let i = 0; i < 100; i++) console.log('x'.repeat(100)); return 1",
      { consoleBytes: 1_000 },
    );
    expect(outcome.status).toBe("completed");
    const logs = (outcome as { logs: string[] }).logs;
    expect(logs.length).toBeLessThan(12);
    expect(logs.at(-1)).toContain("cut at 1000 bytes");
  });
});

describe("limits are policy", () => {
  test("a bot's own limits only lower the deployment's", () => {
    const c = config.code;
    expect(limitsFor({}).timeoutMs).toBe(c.timeoutMs);
    expect(limitsFor({ timeoutMs: 5_000 }).timeoutMs).toBe(5_000);
    expect(limitsFor({ timeoutMs: c.timeoutMs * 10 }).timeoutMs).toBe(
      c.timeoutMs,
    );
    expect(limitsFor({ bridgeRequests: 10 }).bridgeRequests).toBe(10);
    expect(limitsFor({ memoryBytes: 2 ** 40 }).memoryBytes).toBe(c.memoryBytes);
    expect(limitsFor({ timeoutMs: 2_000 }).cpuTimeoutMs).toBe(2_000);
  });

  test("the plan's limits are the deployment's defaults", () => {
    const c = config.code;
    expect(c.timeoutMs).toBe(30_000);
    expect(c.memoryBytes).toBe(96 * 1024 * 1024);
    expect(c.stackBytes).toBe(2 * 1024 * 1024);
    expect(c.sourceBytes).toBe(256 * 1024);
    expect(c.resultBytes).toBe(1024 * 1024);
    expect(c.consoleBytes).toBe(64 * 1024);
    expect(c.hostArgumentBytes).toBe(22 * 1024 * 1024);
    expect(c.hostOutputBytes).toBe(22 * 1024 * 1024);
    expect(c.bridgeRequests).toBe(256);
    expect(c.concurrentBridgeRequests).toBe(32);
    expect(c.continuationBytes).toBe(32 * 1024 * 1024);
    expect(c.runsPerWorker).toBe(4);
  });
});
