import { loadFromEnvIfSet } from "keryx";

/**
 * Shared MCP servers: the client pool's limits, the catalog's refresh, the
 * approval gate's clock, and large results. Read at use, so a suite may change
 * one for a test and put it back.
 */
export const configMcp = {
  /** How long one tool call may take, unless its server overrides it. */
  callTimeoutMs: await loadFromEnvIfSet("MCP_CALL_TIMEOUT_MS", 60_000),
  /** How long connecting and listing tools may take. */
  connectTimeoutMs: await loadFromEnvIfSet("MCP_CONNECT_TIMEOUT_MS", 15_000),
  /** A pooled client unused this long is closed. */
  idleMs: await loadFromEnvIfSet("MCP_CLIENT_IDLE_MS", 5 * 60 * 1000),
  /** The most clients one process keeps open; the least recently used goes first. */
  maxClients: await loadFromEnvIfSet("MCP_MAX_CLIENTS", 200),
  /** How often `mcp-servers:refresh` re-lists every server's tools. */
  refreshFrequencyMs: await loadFromEnvIfSet(
    "MCP_REFRESH_FREQUENCY_MS",
    60 * 60 * 1000,
  ),
  /** How often `approvals:expire` looks for approvals nobody decided. */
  expireFrequencyMs: await loadFromEnvIfSet(
    "MCP_APPROVALS_EXPIRE_FREQUENCY_MS",
    60 * 1000,
  ),
  /** A tool result longer than this (as JSON text) is stored and previewed. */
  maxInlineChars: await loadFromEnvIfSet("MCP_MAX_INLINE_CHARS", 10_000),
  /** How much of a large result the model sees inline. */
  previewChars: await loadFromEnvIfSet("MCP_PREVIEW_CHARS", 2_000),
  /** How long after its conversation ends a large result is kept. */
  largeResultRetentionDays: await loadFromEnvIfSet(
    "MCP_LARGE_RESULT_RETENTION_DAYS",
    30,
  ),
  /** How often `large-results:sweep` runs. */
  largeResultSweepFrequencyMs: await loadFromEnvIfSet(
    "MCP_LARGE_RESULT_SWEEP_FREQUENCY_MS",
    24 * 60 * 60 * 1000,
  ),
  /**
   * Generate each bot's capabilities summary with its `fast` model. Off, the
   * summary is a plain list of its servers and how many tools each has — what
   * the browser suite uses, so a scripted answer meant for a conversation is
   * not taken by it.
   */
  generateCapabilities: await loadFromEnvIfSet(
    "MCP_GENERATE_CAPABILITIES",
    true,
  ),
};

declare module "keryx" {
  interface KeryxConfig {
    mcp: typeof configMcp;
  }
}
