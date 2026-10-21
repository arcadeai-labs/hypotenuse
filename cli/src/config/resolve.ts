/**
 * What a parsed config means once its shorthand is filled in: every agent a
 * role can use (a role naming a preset with no `[agents.*]` table gets the
 * preset with defaults), each repository's name, and the roles this runner
 * actually plays.
 */
import { basename } from "node:path";
import { normalizeRemote } from "../../../protocol/src/index";
import { AGENT_PRESETS, isPreset, type PresetName } from "./presets";
import type { Config, RepositoryConfig, RoleConfig } from "./schema";

/** One agent, ready to launch. */
export interface ResolvedAgent {
  /** Its id: the `[agents.<id>]` key, or the preset name. */
  id: string;
  /** The preset it is built on, if any. */
  preset: PresetName | null;
  /** The launch command, arguments included. */
  command: string[];
  /** Extra environment. */
  env: Record<string, string>;
  /** Its own concurrency limit. */
  maxParallel: number | undefined;
  /** The roles that use it. */
  roles: ("manager" | "worker")[];
}

/**
 * The agent a role uses, by id, if the config defines it or it is a preset.
 * @param config - The config.
 * @param id - The role's `agent`.
 * @returns The resolved agent, or undefined.
 */
function agentById(
  config: Config,
  id: string,
): Omit<ResolvedAgent, "roles"> | undefined {
  const table = config.agents[id];
  if (table) {
    const base = table.preset
      ? [...AGENT_PRESETS[table.preset].command]
      : (table.command ?? []);
    return {
      id,
      preset: table.preset ?? null,
      command: [...base, ...table.args],
      env: table.env,
      maxParallel: table.max_parallel,
    };
  }
  if (isPreset(id)) {
    return {
      id,
      preset: id,
      command: [...AGENT_PRESETS[id].command],
      env: {},
      maxParallel: undefined,
    };
  }
  return undefined;
}

/**
 * The roles this runner plays that have a `[roles.*]` table, with the table.
 * @param config - The config.
 * @returns `[role, table]` pairs.
 */
export function playedRoles(
  config: Config,
): ["manager" | "worker", RoleConfig][] {
  return config.runner.roles.flatMap((role) => {
    const table = config.roles[role];
    return table ? [[role, table] as ["manager" | "worker", RoleConfig]] : [];
  });
}

/**
 * Every agent a played role uses, plus every other defined agent (with no
 * roles), in a stable order: defined tables first, then preset shorthands.
 * @param config - The config.
 * @returns The agents.
 */
export function resolveAgents(config: Config): ResolvedAgent[] {
  const byId = new Map<string, ResolvedAgent>();
  for (const id of Object.keys(config.agents)) {
    const agent = agentById(config, id);
    if (agent) byId.set(id, { ...agent, roles: [] });
  }
  for (const [role, table] of playedRoles(config)) {
    const known = byId.get(table.agent);
    if (known) {
      if (!known.roles.includes(role)) known.roles.push(role);
      continue;
    }
    const agent = agentById(config, table.agent);
    if (agent) byId.set(table.agent, { ...agent, roles: [role] });
  }
  return [...byId.values()];
}

/**
 * A repository's name: its own, else the last segment of its remote, else of
 * its path.
 * @param repo - The entry.
 * @returns The name.
 */
export function repositoryName(repo: RepositoryConfig): string {
  if (repo.name) return repo.name;
  const source = repo.remote ? normalizeRemote(repo.remote) : repo.path;
  return basename(source.replace(/\/+$/, "")) || "repository";
}
