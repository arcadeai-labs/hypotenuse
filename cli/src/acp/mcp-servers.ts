/**
 * The MCP servers a turn's agent gets in `session/new` (and `load` and
 * `resume`): the built-in `hypotenuse` server first, then the role's
 * `extra_mcp_servers` from the config.
 *
 * - `$VAR` and `${VAR}` in an extra server's `env` and `headers` are read
 *   from the daemon's environment at turn start. An unset variable fails the
 *   turn with an error naming the variable — never a value.
 * - A stdio server's command is resolved to an absolute path, as ACP
 *   requires.
 * - An `url` server is passed as `{ type: "http" }` only when the agent
 *   advertises `mcpCapabilities.http`; otherwise it is skipped, and the turn
 *   says so in a thought.
 * - The name `hypotenuse` is the built-in server's (`config validate`
 *   refuses it in the config).
 */
import { isAbsolute } from "node:path";
import type { RoleConfig } from "../config/schema";
import type { HypotenuseMcpLaunch } from "../daemon/executor";
import type { AgentCapabilities, McpServer } from "./connection";

/** The built-in server's name. */
export const HYPOTENUSE_SERVER_NAME = "hypotenuse";

/** A `$VAR` or `${VAR}` reference. */
const VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g;

/** An extra server's values named a variable the daemon does not have. */
export class UnsetVariableError extends Error {
  /**
   * @param server - The server's name.
   * @param variable - The variable.
   */
  constructor(
    readonly server: string,
    readonly variable: string,
  ) {
    super(
      `The MCP server "${server}" needs $${variable}, which is not set in the daemon's environment.`,
    );
    this.name = "UnsetVariableError";
  }
}

/** The servers for a turn, and what was left out. */
export interface TurnMcpServers {
  servers: McpServer[];
  /** HTTP servers skipped because the agent cannot speak HTTP MCP. */
  skipped: string[];
}

/**
 * Expand the variables in one value.
 * @param server - The server's name, for the error.
 * @param value - The value.
 * @param env - The daemon's environment.
 * @returns The value with every variable replaced.
 * @throws {UnsetVariableError} For the first variable that is unset.
 */
export function expandVariables(
  server: string,
  value: string,
  env: Record<string, string | undefined>,
): string {
  return value.replace(VARIABLE, (_, braced?: string, bare?: string) => {
    const name = (braced ?? bare) as string;
    const found = env[name];
    if (found === undefined) throw new UnsetVariableError(server, name);
    return found;
  });
}

/**
 * Name/value pairs from a table, variables expanded.
 * @param server - The server's name.
 * @param table - The table.
 * @param env - The daemon's environment.
 * @returns The pairs.
 */
function pairs(
  server: string,
  table: Record<string, string> | undefined,
  env: Record<string, string | undefined>,
): { name: string; value: string }[] {
  return Object.entries(table ?? {}).map(([name, value]) => ({
    name,
    value: expandVariables(server, value, env),
  }));
}

/**
 * Every MCP server for a turn.
 * @param role - The role's config.
 * @param caps - The agent's capabilities.
 * @param env - The daemon's environment.
 * @param hypotenuse - The built-in server's launch, if the daemon serves one.
 * @returns The servers, and the HTTP ones skipped.
 * @throws {UnsetVariableError} When an extra server names an unset variable.
 */
export function turnMcpServers(
  role: RoleConfig | undefined,
  caps: AgentCapabilities,
  env: Record<string, string | undefined>,
  hypotenuse: HypotenuseMcpLaunch | null | undefined,
): TurnMcpServers {
  const servers: McpServer[] = [];
  const skipped: string[] = [];
  if (hypotenuse) {
    servers.push({
      name: HYPOTENUSE_SERVER_NAME,
      command: hypotenuse.command,
      args: hypotenuse.args,
      env: Object.entries(hypotenuse.env).map(([name, value]) => ({
        name,
        value,
      })),
    });
  }
  for (const s of role?.extra_mcp_servers ?? []) {
    if (s.name === HYPOTENUSE_SERVER_NAME) continue;
    if (s.command?.length) {
      const [command, ...args] = s.command as [string, ...string[]];
      servers.push({
        name: s.name,
        command: isAbsolute(command)
          ? command
          : (Bun.which(command, { PATH: env.PATH ?? "" }) ?? command),
        args,
        env: pairs(s.name, s.env, env),
      });
    } else if (s.url) {
      if (!caps.mcpCapabilities?.http) {
        skipped.push(s.name);
        continue;
      }
      servers.push({
        type: "http" as const,
        name: s.name,
        url: s.url,
        headers: pairs(s.name, s.headers, env),
      });
    }
  }
  return { servers, skipped };
}
