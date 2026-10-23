/**
 * The secret values the daemon redacts from everything a turn's telemetry
 * holds before it leaves the machine (the worker redacts again, by name and
 * pattern, before export): the runner token, the CLI token, the turn's MCP
 * and receiver nonces, and every value the daemon resolved from a `$VAR` in
 * the config — an agent's `env`, and `extra_mcp_servers`' `env` and
 * `headers`. Common secret shapes are caught by pattern
 * (`SECRET_PATTERNS`), best effort.
 */
import { expandVariables } from "../acp/presets";
import type { Config } from "../config/schema";

/**
 * Every value in the config that came from the environment.
 * @param config - The config.
 * @param env - The daemon's environment.
 * @returns The resolved values.
 */
export function resolvedConfigSecrets(
  config: Config,
  env: Record<string, string | undefined>,
): string[] {
  const out: string[] = [];
  const take = (table: Record<string, string> | undefined) => {
    for (const value of Object.values(table ?? {})) {
      if (!value.includes("$")) continue;
      const resolved = expandVariables(value, env);
      if (resolved) out.push(resolved);
    }
  };
  for (const agent of Object.values(config.agents)) take(agent.env);
  for (const role of [config.roles.manager, config.roles.worker]) {
    for (const server of role?.extra_mcp_servers ?? []) {
      take(server.env);
      take(server.headers);
    }
  }
  return out;
}

/**
 * The daemon-wide secrets plus a turn's own.
 * @param base - The runner token, the CLI token, the config's resolved values.
 * @param turn - The turn's nonces.
 * @returns The values to redact.
 */
export function turnSecrets(
  base: readonly string[],
  turn: readonly (string | null | undefined)[],
): string[] {
  return [...base, ...turn.filter((v): v is string => Boolean(v))];
}
