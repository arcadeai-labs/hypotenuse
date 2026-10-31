import { loadFromEnvIfSet } from "keryx";

/**
 * Code mode: the limits every `run_code` program runs under. They are policy,
 * not input — a program cannot raise them, and a bot may only lower the three
 * a person can tune on its page (`bots.codeLimits`). Read at use, so a suite
 * may change one for a test and put it back.
 */
export const configCode = {
  /** Wall-clock ceiling for one invocation, host calls included. */
  timeoutMs: await loadFromEnvIfSet("CODE_TIMEOUT_MS", 30_000),
  /** Time the guest itself may compute in one invocation. */
  cpuTimeoutMs: await loadFromEnvIfSet("CODE_CPU_TIMEOUT_MS", 10_000),
  /** QuickJS heap. */
  memoryBytes: await loadFromEnvIfSet("CODE_MEMORY_BYTES", 96 * 1024 * 1024),
  /** QuickJS stack. */
  stackBytes: await loadFromEnvIfSet("CODE_STACK_BYTES", 2 * 1024 * 1024),
  /** The program's source. */
  sourceBytes: await loadFromEnvIfSet("CODE_SOURCE_BYTES", 256 * 1024),
  /** The value a program returns, serialized. */
  resultBytes: await loadFromEnvIfSet("CODE_RESULT_BYTES", 1024 * 1024),
  /** What `console.log` keeps; the rest is cut. */
  consoleBytes: await loadFromEnvIfSet("CODE_CONSOLE_BYTES", 64 * 1024),
  /** One host call's arguments, serialized. */
  hostArgumentBytes: await loadFromEnvIfSet(
    "CODE_HOST_ARGUMENT_BYTES",
    22 * 1024 * 1024,
  ),
  /** One host call's answer, serialized. */
  hostOutputBytes: await loadFromEnvIfSet(
    "CODE_HOST_OUTPUT_BYTES",
    22 * 1024 * 1024,
  ),
  /** Host calls one program may make, across every resume. */
  bridgeRequests: await loadFromEnvIfSet("CODE_BRIDGE_REQUESTS", 256),
  /** Host calls in flight at once. */
  concurrentBridgeRequests: await loadFromEnvIfSet(
    "CODE_CONCURRENT_BRIDGE_REQUESTS",
    32,
  ),
  /** A stored continuation. */
  continuationBytes: await loadFromEnvIfSet(
    "CODE_CONTINUATION_BYTES",
    32 * 1024 * 1024,
  ),
  /** Programs one worker process runs at once; more wait their turn. */
  runsPerWorker: await loadFromEnvIfSet("CODE_RUNS_PER_WORKER", 4),
};

declare module "keryx" {
  interface KeryxConfig {
    code: typeof configCode;
  }
}
