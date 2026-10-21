/**
 * How an agent is launched: its command line (a preset's, or the config's own
 * `command`, plus `args`), and its environment — the daemon's own, without
 * the `HYPOTENUSE_*` variables that point at its credentials and state, plus
 * the preset's defaults, the agent's `env` (with `$VAR` expanded), and the
 * per-session variables. The preset table itself is `config/presets.ts`, which
 * `config validate` and `docs/CONFIG.md` read too.
 */
import type { WorkAssignment } from "../../../protocol/src/index";
import { AGENT_PRESETS } from "../config/presets";
import { type ResolvedAgent, resolveAgents } from "../config/resolve";
import type { Config } from "../config/schema";

export { AGENT_PRESETS, PRESET_NAMES } from "../config/presets";

/** Everything needed to start one agent. */
export interface AgentLaunch {
  /** The agent's id. */
  id: string;
  /** Its preset, if any. */
  preset: string | null;
  /** The command line. */
  command: string[];
  /** The whole environment. */
  env: Record<string, string>;
  /** Time allowed to answer `initialize`. */
  startupTimeoutMs: number;
  /** The `authMethods` id the config chose. */
  authMethod: string | null;
}

/** `HYPOTENUSE_*` variables an agent still gets: the per-session ones. */
const SESSION_VARIABLES = new Set([
  "HYPOTENUSE_SESSION_ID",
  "HYPOTENUSE_LINEAR_SESSION_ID",
  "HYPOTENUSE_ISSUE",
  "HYPOTENUSE_ISSUE_URL",
  "HYPOTENUSE_BRANCH",
  "HYPOTENUSE_BASE_BRANCH",
  "HYPOTENUSE_ROLE",
  "HYPOTENUSE_SESSION_URL",
]);

/**
 * Expand `$VAR` and `${VAR}` against an environment (unset is empty).
 * @param value - The value as written.
 * @param env - The environment.
 * @returns The expanded value.
 */
export function expandVariables(
  value: string,
  env: Record<string, string | undefined>,
): string {
  return value.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_, braced: string | undefined, bare: string | undefined) =>
      env[(braced ?? bare) as string] ?? "",
  );
}

/**
 * The per-session variables of a turn.
 * @param assignment - The turn.
 * @param branch - The branch it works on.
 * @returns The variables.
 */
export function sessionVariables(
  assignment: WorkAssignment,
  branch: string | null,
): Record<string, string> {
  return {
    HYPOTENUSE_SESSION_ID: String(assignment.agentSessionId),
    HYPOTENUSE_LINEAR_SESSION_ID: assignment.externalSessionId,
    HYPOTENUSE_ISSUE: assignment.issue.identifier ?? "",
    HYPOTENUSE_ISSUE_URL: assignment.issue.url ?? "",
    HYPOTENUSE_BRANCH: branch ?? "",
    HYPOTENUSE_BASE_BRANCH: assignment.repository?.baseBranch ?? "",
    HYPOTENUSE_ROLE: assignment.role,
    HYPOTENUSE_SESSION_URL: assignment.externalSessionUrl ?? "",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * The launch of one configured agent.
 * @param config - The config.
 * @param agentId - The agent's id (a table, or a preset name).
 * @param daemonEnv - The daemon's environment.
 * @param extra - Per-session variables.
 * @returns The launch, or null for an agent the config does not define.
 */
export function resolveAgentLaunch(
  config: Config,
  agentId: string,
  daemonEnv: Record<string, string | undefined>,
  extra: Record<string, string> = {},
): AgentLaunch | null {
  const agent: ResolvedAgent | undefined = resolveAgents(config).find(
    (a) => a.id === agentId,
  );
  if (!agent || !agent.command.length) return null;
  const table = config.agents[agentId];
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(daemonEnv)) {
    if (value === undefined) continue;
    if (key.startsWith("HYPOTENUSE_") && !SESSION_VARIABLES.has(key)) continue;
    env[key] = value;
  }
  const preset = agent.preset ? AGENT_PRESETS[agent.preset] : null;
  if (preset && "env" in preset && preset.env) Object.assign(env, preset.env);
  if (agent.command[0] === "npx") env.npm_config_yes = "true";
  for (const [key, value] of Object.entries(agent.env))
    env[key] = expandVariables(value, daemonEnv);
  Object.assign(env, extra);
  return {
    id: agent.id,
    preset: agent.preset,
    command: agent.command,
    env,
    startupTimeoutMs: table?.startup_timeout ?? 60_000,
    authMethod: table?.auth_method ?? null,
  };
}
