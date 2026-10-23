/**
 * What the daemon tells the server about itself on every heartbeat, derived
 * from the config and this machine: the roles it plays, its agents and
 * whether each one's command resolves, its repositories, its subscriptions,
 * and its three levels of limits.
 */
import type {
  RunnerCapabilities,
  RunnerLimits,
} from "../../../protocol/src/index";
import {
  type MachineEnv,
  type ResolvedRepository,
  resolveRepository,
} from "../config/machine";
import { playedRoles, resolveAgents } from "../config/resolve";
import type { Config } from "../config/schema";

/**
 * The repositories the daemon can open worktrees of: each entry whose remote
 * is configured or readable from origin.
 * @param config - The config.
 * @param machine - The machine.
 * @returns The repositories.
 */
export function daemonRepositories(
  config: Config,
  machine: MachineEnv,
): ResolvedRepository[] {
  return config.repositories.flatMap((repo) => {
    const resolved = resolveRepository(machine, repo);
    return resolved ? [resolved] : [];
  });
}

/**
 * The capabilities a heartbeat reports.
 * @param config - The config.
 * @param machine - The machine (`PATH` for agent availability).
 * @param repositories - The resolved repositories.
 * @returns The capabilities.
 */
export function buildCapabilities(
  config: Config,
  machine: MachineEnv,
  repositories: ResolvedRepository[],
): RunnerCapabilities {
  const roles = playedRoles(config).map(([role]) => role);
  return {
    roles,
    agents: resolveAgents(config).map((agent) => {
      const binary = agent.command[0];
      const found = binary ? machine.which(binary) : null;
      return {
        id: agent.id,
        preset: agent.preset ?? "custom",
        available: Boolean(found),
        roles: agent.roles,
        ...(found
          ? {}
          : { error: `${binary ?? "(no command)"} not found on PATH` }),
      };
    }),
    repositories: repositories.map((r) => ({
      name: r.name,
      remote: r.remote,
      baseBranch: r.baseBranch,
    })),
    subscriptions: {
      teams: config.subscriptions.teams,
      projects: config.subscriptions.projects,
      labels: config.subscriptions.labels,
    },
    telemetry: {
      enabled: config.telemetry.enabled,
      maxContent: config.telemetry.max_content,
      agentNative: config.telemetry.agent_native,
    },
  };
}

/**
 * The limits a heartbeat reports: the machine, each role with a
 * `max_parallel`, and each agent with one. Draining reports nothing free
 * through `draining: true`, not through these.
 * @param config - The config.
 * @returns The limits.
 */
export function buildLimits(config: Config): RunnerLimits {
  const roles: Partial<Record<"manager" | "worker", number>> = {};
  for (const [role, table] of playedRoles(config)) {
    if (table.max_parallel !== undefined) roles[role] = table.max_parallel;
  }
  const agents: Record<string, number> = {};
  for (const agent of resolveAgents(config)) {
    if (agent.maxParallel !== undefined) agents[agent.id] = agent.maxParallel;
  }
  return {
    maxParallelJobs: config.runner.max_parallel_jobs,
    ...(Object.keys(roles).length ? { roles } : {}),
    ...(Object.keys(agents).length ? { agents } : {}),
  };
}
