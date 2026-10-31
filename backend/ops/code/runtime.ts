import { config } from "keryx";
import {
  createRunner,
  getHostFunctionContext,
  type HostFunctions,
  RunError,
  setMaxWorkers,
} from "run";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/code";
import type { BotCodeLimits } from "../../schema/bots";

/**
 * **The code-mode runtime**: the only module that imports `run` (Vercel's Run
 * SDK, pinned exactly). Run executes a program in a fresh, hardened QuickJS
 * context inside a worker thread, with no Node or Bun globals, modules,
 * timers, filesystem, or network; it reaches the host only through the host
 * functions passed in. It also returns a signed continuation when a host
 * function interrupts, and replays the same program from it later.
 *
 * Errors are mapped from Run's stable codes, never from message text — with
 * one exception QuickJS leaves no choice about: running out of heap is a
 * catchable `InternalError` whose only distinguishing mark is its message.
 *
 * | Run's code | `error_type` |
 * |---|---|
 * | `RUN_USER_SOURCE_ERROR` (escapes the shim: a syntax error) | `invalid_source` |
 * | `RUN_TIMEOUT`, `RUN_CPU_TIMEOUT` | `sandbox_timeout` |
 * | `RUN_BRIDGE_LIMIT`, `RUN_SOURCE_TOO_LARGE`, `RUN_SERIALIZATION_ERROR`, `RUN_DETACHED_BRIDGE_REQUEST` | `sandbox_limit` |
 * | `RUN_PROTOCOL_ERROR` | `continuation_invalid` |
 * | `RUN_HOST_FUNCTION_ERROR` | `host_error` |
 * | `RUN_ABORTED` | rethrown: the tick stopped |
 * | anything else | `internal_error` |
 *
 * A guest exception never escapes as a Run error: the shim catches it and
 * returns it as data, so the program's own throw is `program_error`, a host
 * call's refusal keeps its type (`approval_denied`, `mcp_error`, `host_error`),
 * and an out-of-heap `InternalError` is `sandbox_memory`.
 */

/** Every `error_type` a failed program reports. */
export const CODE_ERROR_TYPES = [
  "invalid_source",
  "program_error",
  "sandbox_timeout",
  "sandbox_memory",
  "sandbox_limit",
  "host_error",
  "mcp_error",
  "approval_denied",
  "continuation_invalid",
  "internal_error",
] as const;

/** One of {@link CODE_ERROR_TYPES}. */
export type CodeErrorType = (typeof CODE_ERROR_TYPES)[number];

/** The limits one program runs under. */
export interface CodeLimits {
  timeoutMs: number;
  cpuTimeoutMs: number;
  memoryBytes: number;
  stackBytes: number;
  sourceBytes: number;
  resultBytes: number;
  consoleBytes: number;
  hostArgumentBytes: number;
  hostOutputBytes: number;
  bridgeRequests: number;
  concurrentBridgeRequests: number;
  continuationBytes: number;
}

/**
 * The limits for a bot: the deployment's, lowered by the bot's own.
 * @param botLimits - The bot's `codeLimits`.
 * @returns The effective limits.
 */
export function limitsFor(botLimits: BotCodeLimits = {}): CodeLimits {
  const c = config.code;
  const lower = (own: number | undefined, deployment: number) =>
    own === undefined ? deployment : Math.min(own, deployment);
  const timeoutMs = lower(botLimits.timeoutMs, c.timeoutMs);
  return {
    timeoutMs,
    cpuTimeoutMs: Math.min(c.cpuTimeoutMs, timeoutMs),
    memoryBytes: lower(botLimits.memoryBytes, c.memoryBytes),
    stackBytes: c.stackBytes,
    sourceBytes: c.sourceBytes,
    resultBytes: c.resultBytes,
    consoleBytes: c.consoleBytes,
    hostArgumentBytes: c.hostArgumentBytes,
    hostOutputBytes: c.hostOutputBytes,
    bridgeRequests: lower(botLimits.bridgeRequests, c.bridgeRequests),
    concurrentBridgeRequests: c.concurrentBridgeRequests,
    continuationBytes: c.continuationBytes,
  };
}

/**
 * The name of the one host function group the shim calls. A program could
 * call it directly; that changes nothing, since every function enforces the
 * same policy either way.
 */
export const HOST_GROUP = "__hyp";

/** What a host function answers across the boundary: a value, or a refusal as data. */
export type HostAnswer =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error: { type: string; message: string; hint: string };
    };

/**
 * The guest-side shim, prepended to every program on one line, so the
 * program's line N is the source's line N + 1. It defines `memory`, `mcp`,
 * `largeResult`, and a bounded `console` in front of the host group; turns a
 * refusal answered as data into a thrown `HostError` the program may catch
 * (`e.code` is its type); and catches whatever the program throws, so it
 * comes back as data with the console output so far.
 * @param consoleBytes - How much console output to keep.
 * @returns The shim's text, ending in an opened function body.
 */
function shimHead(consoleBytes: number): string {
  const h = HOST_GROUP;
  return [
    `const __logs = []; let __logBytes = 0; let __logCut = false;`,
    `const __fmt = (v) => { if (typeof v === "string") return v; try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch { return String(v); } };`,
    `const __log = (...a) => { if (__logCut) return; const line = a.map(__fmt).join(" "); if (__logBytes + line.length > ${consoleBytes}) { __logCut = true; __logs.push("[console output cut at ${consoleBytes} bytes]"); return; } __logBytes += line.length + 1; __logs.push(line); };`,
    `const console = { log: __log, info: __log, warn: __log, error: __log, debug: __log };`,
    `class HostError extends Error { constructor(e) { super(e.message); this.name = "HostError"; this.code = e.type; this.hint = e.hint; } }`,
    `const __call = async (p) => { const r = await p; if (r && r.ok === false) throw new HostError(r.error); return r.value; };`,
    `const memory = { search: (q, o) => __call(${h}.memory_search(q, o)), list: (o) => __call(${h}.memory_list(o)), read: (p, o) => __call(${h}.memory_read(p, o)), write: (p, v, o) => __call(${h}.memory_write(p, v, o)) };`,
    `const mcp = { listTools: (s) => __call(${h}.mcp_list_tools(s)), search: (q) => __call(${h}.mcp_search(q)), info: (s, t) => __call(${h}.mcp_info(s, t)), exec: (s, t, a) => __call(${h}.mcp_exec(s, t, a)), capture: (s, t, a, p) => __call(${h}.mcp_capture(s, t, a, p)) };`,
    `const largeResult = { read: (id, o) => __call(${h}.large_result_read(id, o)) };`,
    `try { const value = await (async () => {`,
  ].join(" ");
}

/** The shim's tail, closing what {@link shimHead} opened. */
const SHIM_TAIL = `\n})(); return { ok: true, value, logs: __logs }; } catch (e) { return { ok: false, logs: __logs, thrown: { name: String(e?.name ?? "Error"), message: String(e?.message ?? e), code: e instanceof HostError ? e.code : null } }; }`;

/**
 * The program as Run sees it: the shim around the model's source. Pure, so a
 * replay verifies the same text.
 * @param source - The model's source.
 * @param consoleBytes - The console limit.
 * @returns The wrapped source.
 */
export function wrapSource(source: string, consoleBytes: number): string {
  return `${shimHead(consoleBytes)}\n${source}${SHIM_TAIL}`;
}

/**
 * A value as JSON can hold it, for the transcript: a `BigInt` becomes its
 * decimal text, a `Map` an object (or its entries, with non-string keys), a
 * `Set` an array, a `Date` its ISO text, an `Error` its name and message, and
 * a typed array its numbers. Cycles become `"[circular]"`.
 * @param value - What the program returned.
 * @param seen - The objects on the current path.
 * @returns The JSON-safe value.
 */
export function jsonSafe(value: unknown, seen = new Set<object>()): unknown {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && !Number.isFinite(value))
    return String(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[circular]";
  seen.add(value);
  try {
    if (value instanceof Date) return value.toISOString();
    if (value instanceof Error)
      return { name: value.name, message: value.message };
    if (value instanceof Map) {
      const entries = [...value.entries()];
      return entries.every(([k]) => typeof k === "string")
        ? Object.fromEntries(entries.map(([k, v]) => [k, jsonSafe(v, seen)]))
        : entries.map(([k, v]) => [jsonSafe(k, seen), jsonSafe(v, seen)]);
    }
    if (value instanceof Set) return [...value].map((v) => jsonSafe(v, seen));
    if (ArrayBuffer.isView(value)) {
      return Array.from(value as unknown as ArrayLike<number>);
    }
    if (Array.isArray(value)) return value.map((v) => jsonSafe(v, seen));
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, jsonSafe(v, seen)]),
    );
  } finally {
    seen.delete(value);
  }
}

/** One gated host call that stopped the program. */
export interface Interruption {
  id: string;
  hostFunctionName: string;
  payload: unknown;
}

/** How one invocation ended. */
export type RunOutcome =
  | { status: "completed"; value: unknown; logs: string[] }
  | {
      status: "failed";
      errorType: CodeErrorType;
      message: string;
      /** The host refusal's own type, when a host call's refusal escaped the program. */
      hostErrorType?: string;
      logs: string[];
    }
  | {
      status: "interrupted";
      interruptions: Interruption[];
      /** The signed continuation, a bearer token: seal it before storing. */
      token: string;
    };

/** What one invocation needs. */
export interface ExecuteInput {
  source: string;
  hostFunctions: Record<string, (...args: never[]) => Promise<HostAnswer>>;
  limits: CodeLimits;
  /** The project's continuation key (32 bytes). */
  secret: Uint8Array;
  /** The audience the continuation is bound to. */
  audience: string;
  /** The authenticated scope, required unchanged on resume. */
  context: Record<string, unknown>;
  signal: AbortSignal;
  /** Resume from this continuation. */
  continuation?: string;
  /** Resolutions for every interruption of the batch, on resume. */
  resolutions?: { interruptionId: string; value: unknown }[];
}

/** Programs running in this process now. */
let active = 0;
/** Programs waiting for a slot, oldest first. */
const waiters: (() => void)[] = [];
/** Whether Run's process-wide worker cap has been set to ours. */
let capSet = false;

/**
 * Take a slot of the per-process semaphore (`CODE_RUNS_PER_WORKER`), waiting
 * for one if every slot is in use.
 * @param signal - Stops the wait.
 * @returns Gives the slot back.
 */
async function acquireSlot(signal: AbortSignal): Promise<() => void> {
  if (!capSet) {
    setMaxWorkers(config.code.runsPerWorker);
    capSet = true;
  }
  while (active >= config.code.runsPerWorker) {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = waiters.indexOf(wake);
        if (i >= 0) waiters.splice(i, 1);
        reject(signal.reason);
      };
      const wake = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      waiters.push(wake);
    });
  }
  active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active -= 1;
    waiters.shift()?.();
  };
}

/**
 * The host function now running: its Run context, for interrupting and for
 * reading a resume's resolution.
 * @returns The context.
 */
export function hostContext() {
  return getHostFunctionContext();
}

/**
 * Map a Run error to a failure. `RUN_ABORTED` is rethrown.
 * @param error - What Run threw.
 * @returns The failure.
 */
function failureOf(error: unknown): Extract<RunOutcome, { status: "failed" }> {
  const code = RunError.isInstance(error) ? error.code : null;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "RUN_ABORTED") throw error;
  const type: CodeErrorType = (() => {
    switch (code) {
      case "RUN_USER_SOURCE_ERROR":
        return "invalid_source";
      case "RUN_TIMEOUT":
      case "RUN_CPU_TIMEOUT":
        return "sandbox_timeout";
      case "RUN_BRIDGE_LIMIT":
      case "RUN_SOURCE_TOO_LARGE":
      case "RUN_SERIALIZATION_ERROR":
      case "RUN_DETACHED_BRIDGE_REQUEST":
        return "sandbox_limit";
      case "RUN_PROTOCOL_ERROR":
        return "continuation_invalid";
      case "RUN_HOST_FUNCTION_ERROR":
        return "host_error";
      default:
        return "internal_error";
    }
  })();
  return { status: "failed", errorType: type, message, logs: [] };
}

/**
 * Map what the shim returned for a program that threw.
 * @param thrown - The shim's record of the exception.
 * @param logs - The console output.
 * @returns The failure.
 */
function failureOfThrown(
  thrown: { name: string; message: string; code: string | null },
  logs: string[],
): Extract<RunOutcome, { status: "failed" }> {
  if (thrown.code) {
    const type: CodeErrorType =
      thrown.code === "approval_denied"
        ? "approval_denied"
        : thrown.code.startsWith("mcp:")
          ? "mcp_error"
          : "host_error";
    return {
      status: "failed",
      errorType: type,
      hostErrorType: thrown.code.replace(/^mcp:/, ""),
      message: thrown.message,
      logs,
    };
  }
  if (thrown.name === "InternalError" && thrown.message === "out of memory") {
    return {
      status: "failed",
      errorType: "sandbox_memory",
      message: "The program ran out of memory.",
      logs,
    };
  }
  return {
    status: "failed",
    errorType: "program_error",
    message: `${thrown.name}: ${thrown.message}`,
    logs,
  };
}

/**
 * **Execute** a program, or resume one from its continuation: take a slot,
 * run it in Run's sandbox under the limits, and say how it ended.
 * @param input - The program, its host functions, limits, and continuation scope.
 * @returns How it ended.
 * @throws When the tick's signal aborts it (the tick stopped).
 */
export async function execute(input: ExecuteInput): Promise<RunOutcome> {
  if (Buffer.byteLength(input.source, "utf8") > input.limits.sourceBytes) {
    return {
      status: "failed",
      errorType: "sandbox_limit",
      message: `The program is longer than ${input.limits.sourceBytes} bytes.`,
      logs: [],
    };
  }
  const wrapped = wrapSource(input.source, input.limits.consoleBytes);
  const l = input.limits;
  const runner = createRunner({
    continuationSecret: input.secret,
    continuationAudience: input.audience,
    limits: {
      timeoutMs: l.timeoutMs,
      cpuTimeoutMs: l.cpuTimeoutMs,
      memoryLimitBytes: l.memoryBytes,
      maxStackSizeBytes: l.stackBytes,
      // The shim and the console ride along with the program and its value.
      maxSourceBytes: l.sourceBytes + 8 * 1024,
      maxResultBytes: l.resultBytes + l.consoleBytes + 1024,
      maxConsoleOutputBytes: 1024,
      maxHostFunctionArgumentsBytes: l.hostArgumentBytes,
      maxHostFunctionOutputBytes: l.hostOutputBytes,
      maxBridgeRequests: l.bridgeRequests,
      maxInFlightBridgeRequests: l.concurrentBridgeRequests,
      maxContinuationBytes: l.continuationBytes,
    },
  });
  const release = await acquireSlot(input.signal);
  try {
    const result = await runner.run({
      source: wrapped,
      hostFunctions: {
        [HOST_GROUP]: input.hostFunctions,
      } as unknown as HostFunctions,
      abortSignal: input.signal,
      continuationContext: input.context,
      ...(input.continuation === undefined
        ? {}
        : {
            continuation: input.continuation,
            resolutions: input.resolutions ?? [],
          }),
    });
    if (result.status === "interrupted") {
      return {
        status: "interrupted",
        token: result.continuation,
        interruptions: result.interruptions.map((i) => ({
          id: i.id,
          hostFunctionName: i.hostFunctionName,
          payload: i.payload,
        })),
      };
    }
    const value = result.value as
      | { ok: true; value: unknown; logs: string[] }
      | {
          ok: false;
          logs: string[];
          thrown: { name: string; message: string; code: string | null };
        };
    if (!value.ok) return failureOfThrown(value.thrown, value.logs);
    const json = jsonSafe(value.value);
    if (
      json !== undefined &&
      Buffer.byteLength(JSON.stringify(json), "utf8") > l.resultBytes
    ) {
      return {
        status: "failed",
        errorType: "sandbox_limit",
        message: `The program's result is larger than ${l.resultBytes} bytes.`,
        logs: value.logs,
      };
    }
    return { status: "completed", value: json, logs: value.logs };
  } catch (error) {
    if (input.signal.aborted) throw input.signal.reason ?? error;
    return failureOf(error);
  } finally {
    release();
  }
}

/**
 * **The self-test**: prove this process can run a program — start Run's worker
 * thread, load its QuickJS WebAssembly, strip TypeScript, call a host function,
 * interrupt, and resume from the continuation. It reads no configuration and
 * touches no database, so a container build can run it.
 * @returns What each check saw.
 * @throws {Error} When a check fails.
 */
export async function selfTest(): Promise<Record<string, unknown>> {
  const secret = new Uint8Array(32).fill(7);
  const runner = createRunner({
    continuationSecret: secret,
    continuationAudience: "hypotenuse-run-v1:self-test",
  });
  const hostFunctions = {
    [HOST_GROUP]: {
      add: async (a: number, b: number) => a + b,
      gated: async (x: number) => {
        const ctx = getHostFunctionContext();
        if (!ctx.resume) ctx.interrupt({ x });
        return x * 2;
      },
    },
  } as unknown as HostFunctions;
  const typed = await runner.run({
    source: `const n: number = await ${HOST_GROUP}.add(2, 3); return n;`,
    hostFunctions,
  });
  if (typed.status !== "completed" || typed.value !== 5) {
    throw new Error(
      `a typed program did not return 5: ${JSON.stringify(typed)}`,
    );
  }
  const source = `return (await ${HOST_GROUP}.add(1, 1)) + (await ${HOST_GROUP}.gated(20));`;
  const paused = await runner.run({ source, hostFunctions });
  if (paused.status !== "interrupted") {
    throw new Error("a gated call did not interrupt");
  }
  const resumed = await runner.run({
    source,
    hostFunctions,
    continuation: paused.continuation,
    resolutions: paused.interruptions.map((i) => ({
      interruptionId: i.id,
      value: true,
    })),
  });
  if (resumed.status !== "completed" || resumed.value !== 42) {
    throw new Error(
      `the resumed program did not return 42: ${JSON.stringify(resumed)}`,
    );
  }
  return {
    typed: typed.value,
    interruptions: paused.interruptions.length,
    resumed: resumed.value,
  };
}
