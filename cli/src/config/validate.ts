/**
 * `config validate`'s passes 2 and 3, and the `--online` checks.
 *
 * - **Pass 1** is the schema (`loader.ts`): shape, types, unknown keys.
 * - **Pass 2** needs the whole document: references between tables, unique
 *   names, the ordering of timeouts.
 * - **Pass 3** needs this machine, but never the network unless asked: git
 *   clones and their origins, prompt files and docs, agent commands on `PATH`.
 * - **Online** needs the server: its status, the runner token, the project,
 *   and the subscription keys.
 *
 * Every check reports a TOML-style path and an exact message, so the same
 * text appears in a terminal, in `--json`, and in the docs' examples.
 */

import { isAbsolute, relative } from "node:path";
import {
  normalizeRemote,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
} from "../../../protocol/src/index";
import { decide } from "../acp/permissions";
import { ApiClient, ApiError } from "../api/client";
import { formatDuration } from "./durations";
import type { ConfigIssue } from "./loader";
import {
  type MachineEnv,
  MIN_GIT_VERSION,
  originHead,
  originOf,
  parseGitVersion,
} from "./machine";
import { isRemoteSource, tildify } from "./paths";
import { isPreset, PRESET_NAMES } from "./presets";
import { repositoryName, resolveAgents } from "./resolve";
import { type Config, LINEAR_STALE_MS, type RoleConfig } from "./schema";
import { didYouMean } from "./suggest";

/** The variables a prompt template may use. `docs/CONFIG.md` lists the same. */
export const PROMPT_VARIABLES = [
  "issue.identifier",
  "issue.title",
  "issue.url",
  "issue.description",
  "issue.team.key",
  "issue.team.name",
  "session.url",
  "session.id",
  "role",
  "creator.name",
  "creator.email",
  "repository.name",
  "repository.remote",
  "repository.base_branch",
  "worktree.path",
  "worktree.branch",
  "runner.name",
  "dispatch.parent_identifier",
] as const;

/** Errors and warnings from one or more passes. */
export interface Findings {
  errors: ConfigIssue[];
  warnings: ConfigIssue[];
}

/**
 * An empty set of findings.
 * @returns No errors, no warnings.
 */
export function noFindings(): Findings {
  return { errors: [], warnings: [] };
}

/**
 * Concatenate findings.
 * @param all - Findings to merge.
 * @returns One set.
 */
export function mergeFindings(...all: Findings[]): Findings {
  return {
    errors: all.flatMap((f) => f.errors),
    warnings: all.flatMap((f) => f.warnings),
  };
}

/**
 * Every `{{variable}}` in a template.
 * @param template - The template text.
 * @returns The variable names, in order, with duplicates.
 */
export function templateVariables(template: string): string[] {
  return [...template.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)].map(
    (m) => m[1] as string,
  );
}

/**
 * Check one template's variables.
 * @param path - The key the template came from.
 * @param template - Its text.
 * @param errors - Where to report.
 */
function checkTemplate(
  path: string,
  template: string,
  errors: ConfigIssue[],
): void {
  const known = new Set<string>(PROMPT_VARIABLES);
  for (const name of new Set(templateVariables(template))) {
    if (!known.has(name)) {
      errors.push({
        path,
        message: `unknown variable {{${name}}}${didYouMean(name, PROMPT_VARIABLES).replace(/"([^"]+)"/, "{{$1}}")}`,
      });
    }
  }
}

/**
 * Pass 2: the checks that need the whole document.
 * @param config - A config that passed the schema.
 * @returns Errors and warnings.
 */
export function validateReferences(config: Config): Findings {
  const { errors, warnings } = noFindings();
  const agentIds = Object.keys(config.agents);
  const machineCap = config.runner.max_parallel_jobs;

  for (const [id, agent] of Object.entries(config.agents)) {
    if (agent.preset && agent.command) {
      errors.push({
        path: `agents.${id}`,
        message: "set preset or command, not both",
      });
    } else if (!agent.preset && !agent.command) {
      errors.push({
        path: `agents.${id}`,
        message: "set preset or command",
        hint: `presets: ${PRESET_NAMES.join(", ")}`,
      });
    }
    if (agent.max_parallel !== undefined && agent.max_parallel >= machineCap) {
      warnings.push({
        path: `agents.${id}.max_parallel`,
        message: `${agent.max_parallel} is not below runner.max_parallel_jobs (${machineCap}); it has no effect`,
      });
    }
  }

  config.runner.roles.forEach((role, index) => {
    if (!config.roles[role]) {
      errors.push({
        path: `runner.roles[${index}]`,
        message: `"${role}" has no [roles.${role}] table`,
      });
    }
  });

  for (const role of ["manager", "worker"] as const) {
    const table = config.roles[role];
    if (!table) continue;
    const at = `roles.${role}`;
    if (!config.agents[table.agent] && !isPreset(table.agent)) {
      errors.push({
        path: `${at}.agent`,
        message: `unknown agent "${table.agent}"${didYouMean(table.agent, [...agentIds, ...PRESET_NAMES])}`,
      });
    }
    if (table.prompt !== undefined && table.prompt_file !== undefined) {
      errors.push({ path: at, message: "set prompt or prompt_file, not both" });
    }
    if (table.prompt !== undefined)
      checkTemplate(`${at}.prompt`, table.prompt, errors);
    if (table.max_parallel !== undefined && table.max_parallel >= machineCap) {
      warnings.push({
        path: `${at}.max_parallel`,
        message: `${table.max_parallel} is not below runner.max_parallel_jobs (${machineCap}); it has no effect`,
      });
    }
    if (
      table.turn_timeout !== undefined &&
      table.turn_timeout < config.sessions.idle_timeout
    ) {
      errors.push({
        path: `${at}.turn_timeout`,
        message: `${formatDuration(table.turn_timeout)} is shorter than sessions.idle_timeout (${formatDuration(config.sessions.idle_timeout)})`,
      });
    }
    checkMcpServers(at, table, errors, warnings);
  }

  const manager = config.roles.manager;
  if (
    manager &&
    (decide(manager.permission_policy, "edit") !== "deny" ||
      decide(manager.permission_policy, "execute") !== "deny")
  ) {
    warnings.push({
      path: "roles.manager.permission_policy",
      message:
        "a manager with write permission can change code; this is allowed but unusual",
      hint: 'the default denies edit, delete, move, and execute: { default = "allow", edit = "deny", delete = "deny", move = "deny", execute = "deny" }',
    });
  }

  const names = new Map<string, number>();
  const remotes = new Map<string, number>();
  config.repositories.forEach((repo, index) => {
    const name = repositoryName(repo);
    if (!repo.name && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) {
      errors.push({
        path: `repositories[${index}]`,
        message: `"${name}" is not a usable repository name (letters, digits, \`.\`, \`_\`, \`-\`); set name`,
      });
    }
    const firstName = names.get(name);
    if (firstName !== undefined) {
      errors.push({
        path: `repositories[${index}].name`,
        message: `"${name}" is already repositories[${firstName}]`,
      });
    } else names.set(name, index);
    if (repo.remote) {
      const remote = normalizeRemote(repo.remote);
      const first = remotes.get(remote);
      if (first !== undefined) {
        errors.push({
          path: `repositories[${index}].remote`,
          message: `${remote} is already repositories[${first}]`,
        });
      } else remotes.set(remote, index);
    }
    if (repo.cleanup === "ttl" && config.sessions.cleanup_ttl === undefined) {
      errors.push({
        path: `repositories[${index}].cleanup`,
        message: 'cleanup = "ttl" needs sessions.cleanup_ttl',
      });
    }
    if ((repo.worktrees ?? config.sessions.worktrees) === "never") {
      warnings.push({
        path: `repositories[${index}].worktrees`,
        message:
          '"never" runs the agent in the clone itself: one session at a time, on a clean tree only',
      });
    }
  });

  const s = config.sessions;
  if (s.keepalive_interval >= LINEAR_STALE_MS) {
    errors.push({
      path: "sessions.keepalive_interval",
      message: `${formatDuration(s.keepalive_interval)} is longer than Linear's 30m stale window`,
    });
  }
  if (s.idle_timeout < s.keepalive_interval) {
    errors.push({
      path: "sessions.idle_timeout",
      message: `${formatDuration(s.idle_timeout)} is shorter than keepalive_interval (${formatDuration(s.keepalive_interval)})`,
    });
  }
  if (s.turn_timeout < s.idle_timeout) {
    errors.push({
      path: "sessions.turn_timeout",
      message: `${formatDuration(s.turn_timeout)} is shorter than idle_timeout (${formatDuration(s.idle_timeout)})`,
    });
  }
  if (s.cleanup === "ttl" && s.cleanup_ttl === undefined) {
    errors.push({
      path: "sessions.cleanup_ttl",
      message: 'required when cleanup = "ttl"',
    });
  }
  return { errors, warnings };
}

/**
 * A role's extra MCP servers: one transport each, unique names, the reserved
 * name, and a warning for Linear's own server.
 * @param at - The role's path.
 * @param table - The role.
 * @param errors - Where errors go.
 * @param warnings - Where warnings go.
 */
function checkMcpServers(
  at: string,
  table: RoleConfig,
  errors: ConfigIssue[],
  warnings: ConfigIssue[],
): void {
  const seen = new Set<string>();
  table.extra_mcp_servers.forEach((server, index) => {
    const path = `${at}.extra_mcp_servers[${index}]`;
    if (Boolean(server.command) === Boolean(server.url)) {
      errors.push({ path, message: "set command or url, not both or neither" });
    }
    if (server.name === "hypotenuse") {
      errors.push({
        path: `${path}.name`,
        message: '"hypotenuse" is reserved for the built-in server',
      });
    } else if (seen.has(server.name)) {
      errors.push({
        path: `${path}.name`,
        message: `"${server.name}" is already used in this role`,
      });
    }
    seen.add(server.name);
    if (
      server.url &&
      /(^|\.)mcp\.linear\.app$/i.test(new URL(server.url).hostname)
    ) {
      warnings.push({
        path: `${path}.url`,
        message:
          "Linear's own MCP server acts as you, outside the session's scope; the built-in hypotenuse tools are scoped to the session",
      });
    }
  });
}

/** Options for the machine pass. */
export interface MachineCheckOptions {
  /** Skip the checks that reach a git remote. */
  offline?: boolean;
}

/**
 * `$VAR` references in a table of strings that the environment does not set.
 * @param values - The table.
 * @param env - Environment variables.
 * @returns `[key, variable]` pairs.
 */
function unsetVariables(
  values: Record<string, string> | undefined,
  env: Record<string, string | undefined>,
) {
  const out: [string, string][] = [];
  for (const [key, value] of Object.entries(values ?? {})) {
    for (const m of value.matchAll(
      /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    )) {
      const name = (m[1] ?? m[2]) as string;
      if (env[name] === undefined) out.push([key, name]);
    }
  }
  return out;
}

/**
 * Pass 3: the checks that need this machine.
 * @param config - A config that passed passes 1 and 2.
 * @param machine - The machine.
 * @param options - `offline` skips `git ls-remote`.
 * @returns Errors and warnings.
 */
export function validateMachine(
  config: Config,
  machine: MachineEnv,
  options: MachineCheckOptions = {},
): Findings {
  const { errors, warnings } = noFindings();
  const home = (p: string) => tildify(p, machine.env);

  const version = parseGitVersion(machine.git(["--version"]).stdout);
  if (!version) {
    errors.push({ path: "git", message: "git was not found on PATH" });
  } else if (
    version[0] < MIN_GIT_VERSION[0] ||
    (version[0] === MIN_GIT_VERSION[0] && version[1] < MIN_GIT_VERSION[1])
  ) {
    errors.push({
      path: "git",
      message: `git ${version.join(".")} is older than ${MIN_GIT_VERSION.join(".")}`,
    });
  }

  config.repositories.forEach((repo, index) => {
    const at = `repositories[${index}]`;
    if (!machine.isDirectory(repo.path)) {
      errors.push({
        path: `${at}.path`,
        message: `${home(repo.path)} does not exist`,
      });
      return;
    }
    const gitDir = machine.git(["rev-parse", "--git-dir"], repo.path);
    if (gitDir.code !== 0) {
      errors.push({
        path: `${at}.path`,
        message: `${home(repo.path)} is not a git repository`,
      });
      return;
    }
    const common = machine.git(["rev-parse", "--git-common-dir"], repo.path);
    if (common.code === 0 && common.stdout.trim() !== gitDir.stdout.trim()) {
      errors.push({
        path: `${at}.path`,
        message: `${home(repo.path)} is a worktree; point at the clone it belongs to`,
      });
      return;
    }
    const origin = originOf(machine, repo.path);
    const configured = repo.remote ? normalizeRemote(repo.remote) : null;
    if (!origin) {
      errors.push({
        path: `${at}.remote`,
        message: `${home(repo.path)} has no origin remote`,
      });
      return;
    }
    if (configured && origin !== configured) {
      errors.push({
        path: `${at}.remote`,
        message: `origin is ${origin}, config says ${configured}`,
      });
      return;
    }
    const base = repo.base_branch ?? originHead(machine, repo.path) ?? "main";
    if (!options.offline) {
      const heads = machine.git(
        ["ls-remote", "--heads", "origin", base],
        repo.path,
      );
      if (heads.code !== 0) {
        warnings.push({
          path: `${at}.base_branch`,
          message: `could not reach origin (${origin}) to check "${base}"`,
        });
      } else if (!heads.stdout.trim()) {
        warnings.push({
          path: `${at}.base_branch`,
          message: `"${base}" not found on origin (${origin})`,
        });
      }
    }
  });

  for (const [role, table] of [
    ["manager", config.roles.manager],
    ["worker", config.roles.worker],
  ] as const) {
    if (!table) continue;
    if (table.prompt_file !== undefined && !isRemoteSource(table.prompt_file)) {
      const text = machine.readFile(table.prompt_file);
      if (text === null) {
        errors.push({
          path: `roles.${role}.prompt_file`,
          message: `${home(table.prompt_file)} cannot be read`,
        });
      } else {
        checkTemplate(`roles.${role}.prompt_file`, text, errors);
      }
    }
    table.docs.forEach((doc, index) => {
      if (isRemoteSource(doc) || machine.readFile(doc) !== null) return;
      errors.push({
        path: `roles.${role}.docs[${index}]`,
        message: `${home(doc)} cannot be read`,
      });
    });
    table.extra_mcp_servers.forEach((server, index) => {
      const at = `roles.${role}.extra_mcp_servers[${index}]`;
      for (const [key, name] of [
        ...unsetVariables(server.env, machine.env).map(([k, n]) => [
          `env.${k}`,
          n,
        ]),
        ...unsetVariables(server.headers, machine.env).map(([k, n]) => [
          `headers.${k}`,
          n,
        ]),
      ]) {
        warnings.push({
          path: `${at}.${key}`,
          message: `$${name} is not set in this environment`,
        });
      }
    });
  }

  for (const agent of resolveAgents(config)) {
    if (agent.roles.length === 0) continue;
    const binary = agent.command[0];
    if (!binary) continue;
    if (!machine.which(binary)) {
      const tabled = config.agents[agent.id];
      errors.push(
        tabled?.command
          ? {
              path: `agents.${agent.id}.command`,
              message: `"${binary}" not found on PATH`,
            }
          : {
              path: tabled
                ? `agents.${agent.id}.preset`
                : `roles.${agent.roles[0]}.agent`,
              message: `"${binary}" not found on PATH (the ${agent.preset} preset runs it)`,
            },
      );
    }
    for (const [key, name] of unsetVariables(agent.env, machine.env)) {
      warnings.push({
        path: `agents.${agent.id}.env.${key}`,
        message: `$${name} is not set in this environment`,
      });
    }
  }

  const root = config.sessions.worktree_root;
  if (!machine.isWritable(root)) {
    errors.push({
      path: "sessions.worktree_root",
      message: `${home(root)} is not writable`,
    });
  }
  config.repositories.forEach((repo, index) => {
    const rel = relative(repo.path, root);
    if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
      errors.push({
        path: "sessions.worktree_root",
        message: `${home(root)} is inside repositories[${index}] (${home(repo.path)})`,
      });
    }
  });
  return { errors, warnings };
}

/** What the online checks need. */
export interface OnlineCheckInput {
  /** The server origin. */
  server: string;
  /** This server's runner credential, if any. */
  runner: { runnerId: number; projectId: number; token: string } | null;
  /** The credentials file, for messages. */
  credentialsPath: string;
  /** The daemon's machine id. */
  machineId: string;
  /** A dry-run heartbeat body (capabilities from this config). */
  heartbeat: Record<string, unknown>;
}

/** What a dry-run heartbeat answers beyond a normal one. */
export interface DryRunAnswer {
  serverTime: number;
  runner?: { id: number; name: string; projectId: number; projectSlug: string };
  unknownSubscriptions?: { teams: string[] } | null;
}

/**
 * The `--online` checks: the server is up, the runner token is accepted, the
 * project matches, and the subscribed team keys exist.
 * @param config - The config.
 * @param input - The server, the credential, and a heartbeat body.
 * @returns Errors and warnings, and the dry-run answer when there was one.
 */
export async function validateOnline(
  config: Config,
  input: OnlineCheckInput,
): Promise<Findings & { answer: DryRunAnswer | null }> {
  const { errors, warnings } = noFindings();
  const anonymous = new ApiClient(input.server);
  try {
    const status = await anonymous.request<{ healthy?: boolean }>(
      "GET",
      "/status",
    );
    if (status.healthy === false) {
      errors.push({
        path: "server.url",
        message: `${input.server} answers but is not healthy`,
      });
    }
  } catch (error) {
    errors.push({
      path: "server.url",
      message: `${input.server} is not reachable: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { errors, warnings, answer: null };
  }
  if (!input.runner) {
    errors.push({
      path: "server.url",
      message: `${input.credentialsPath} has no runner for ${input.server}`,
      hint: "run `hypotenuse runner register`",
    });
    return { errors, warnings, answer: null };
  }
  let answer: DryRunAnswer;
  try {
    answer = await new ApiClient(
      input.server,
      input.runner.token,
    ).request<DryRunAnswer>("POST", "/daemon/heartbeat", {
      body: { ...input.heartbeat, dryRun: true },
      headers: { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push({
      path: "server.url",
      message:
        error instanceof ApiError && error.status === 401
          ? `the runner token in ${input.credentialsPath} is not accepted (revoked or deleted)`
          : `the dry-run heartbeat failed: ${message}`,
      hint:
        error instanceof ApiError && error.status === 401
          ? "run `hypotenuse runner register`"
          : undefined,
    });
    return { errors, warnings, answer: null };
  }
  const project = config.server.project;
  if (project && answer.runner) {
    const matches = /^\d+$/.test(project)
      ? Number(project) === answer.runner.projectId
      : project === answer.runner.projectSlug;
    if (!matches) {
      errors.push({
        path: "server.project",
        message: `the runner belongs to project "${answer.runner.projectSlug}" (#${answer.runner.projectId}), not "${project}"`,
      });
    }
  }
  if (answer.unknownSubscriptions === null) {
    warnings.push({
      path: "subscriptions.teams",
      message:
        "could not check team keys: the project's Linear connection did not answer",
    });
  }
  for (const team of answer.unknownSubscriptions?.teams ?? []) {
    const index = config.subscriptions.teams.indexOf(team);
    errors.push({
      path: `subscriptions.teams[${index}]`,
      message: `"${team}" is not a team the Linear connection can see`,
    });
  }
  return { errors, warnings, answer };
}
