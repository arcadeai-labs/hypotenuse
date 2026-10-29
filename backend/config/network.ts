import { loadFromEnvIfSet } from "keryx";

/**
 * Outbound requests to URLs a person typed: a model provider's base URL today,
 * an MCP server's and an exporter's later.
 */
export const configNetwork = {
  /**
   * Lift the SSRF guard (`ops/NetworkGuardOps.ts`): allow `http`, loopback,
   * and private addresses. True only under test by default, so the scripted
   * model server on loopback is reachable; never set it in a deployment.
   */
  allowPrivateHosts: await loadFromEnvIfSet(
    "NETWORK_ALLOW_PRIVATE_HOSTS",
    Bun.env.NODE_ENV === "test",
  ),
  /** How long one outbound request may take, in milliseconds. */
  requestTimeoutMs: await loadFromEnvIfSet(
    "NETWORK_REQUEST_TIMEOUT_MS",
    30_000,
  ),
};

declare module "keryx" {
  interface KeryxConfig {
    network: typeof configNetwork;
  }
}
