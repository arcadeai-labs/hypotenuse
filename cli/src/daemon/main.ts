/**
 * The daemon process: `hypotenuse daemon start --foreground`, which is what a
 * background start spawns and what launchd and systemd run.
 *
 * Startup order:
 *
 * 1. load and validate the config (passes 1–3, offline) — fatal on error;
 * 2. find this server's runner in `credentials.json` (refusing a file other
 *    users can read);
 * 3. open `state.db` and migrate it;
 * 4. take the machine lock and bind the control socket;
 * 5. recover: a turn a previous process left `claimed` or `running` is marked
 *    `interrupted` — its agent died with that process — and the server's lease
 *    logic re-offers it;
 * 6. start ServerLink and flush the queued events;
 * 7. signal `ready` (over the IPC channel to a background start's parent).
 *
 * Exit codes: 0 after a stop, 130/143 on SIGINT/SIGTERM, 75 to ask a service
 * manager for a restart after an upgrade, and 78 for what a restart will not
 * fix (an invalid config, no runner, a revoked runner, another runner on this
 * machine), which systemd's unit is told not to restart.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AcpSessionExecutor } from "../acp/host";
import {
  type Credentials,
  loadCredentials,
  originOf,
  type RunnerCredential,
} from "../api/credentials";
import { checkConfig, formatIssue } from "../config/check";
import { applyOverrides, type ConfigOverrides } from "../config/loader";
import { realMachine } from "../config/machine";
import {
  type DaemonPaths,
  daemonPaths,
  type Env,
  resolveConfigPath,
} from "../config/paths";
import type { Config } from "../config/schema";
import { credentialsPath } from "../paths";
import { machineId } from "../runner/machine";
import { onSignal, register, setHardTimeout } from "../shutdown";
import {
  ControlServer,
  INVALID_PARAMS,
  METHOD_NOT_FOUND,
  RpcError,
} from "./control-socket";
import { DaemonApi } from "./daemon-api";
import { DaemonLog } from "./log";
import { acquireLock, LockHeld, releaseLock } from "./pidfile";
import { childArgs, selfCommand } from "./self";
import { StateDb } from "./state";
import {
  EXIT_CONFIG,
  EXIT_RESTART,
  type ExitRequest,
  Supervisor,
} from "./supervisor";

/** How the daemon was started. */
export interface DaemonOptions extends ConfigOverrides {
  /** `-c/--config`. */
  config?: string;
  /** `--state-dir`. */
  stateDir?: string;
  /** Spawned by a background start: log to the file only, report over IPC. */
  detachedChild?: boolean;
  /** Environment variables. */
  env?: Env;
}

/** A failure before the daemon is ready, with the exit code it means. */
export class DaemonStartError extends Error {
  /**
   * @param message - What to tell the person.
   * @param code - The exit code.
   */
  constructor(
    message: string,
    readonly code = EXIT_CONFIG,
  ) {
    super(message);
    this.name = "DaemonStartError";
  }
}

/**
 * The server a daemon serves: `--url` / `HYPOTENUSE_URL` / `[server] url`
 * (already folded into the config), else the only server in the credentials
 * file that has a runner.
 * @param config - The config, overrides applied.
 * @param credentials - The credentials file.
 * @param file - Its path, for messages.
 * @returns The origin and its runner.
 * @throws {DaemonStartError} When there is no runner, or several servers to choose from.
 */
export function resolveDaemonRunner(
  config: Config,
  credentials: Credentials,
  file: string,
): { origin: string; runner: RunnerCredential } {
  let origin: string;
  if (config.server.url) {
    origin = originOf(config.server.url);
  } else {
    const withRunner = Object.entries(credentials.servers).filter(
      ([, entry]) => entry.runner,
    );
    if (withRunner.length !== 1) {
      throw new DaemonStartError(
        withRunner.length === 0
          ? `${file} has no runner; run \`hypotenuse runner register\``
          : `${file} has runners on ${withRunner.length} servers; set [server] url in the config to choose one`,
      );
    }
    origin = (withRunner[0] as [string, unknown])[0];
  }
  const runner = credentials.servers[origin]?.runner;
  if (!runner) {
    throw new DaemonStartError(
      `${file} has no runner for ${origin}; run \`hypotenuse runner register\``,
    );
  }
  const project = config.server.project;
  if (
    project &&
    /^\d+$/.test(project) &&
    Number(project) !== runner.projectId
  ) {
    throw new DaemonStartError(
      `server.project is ${project}, but this machine's runner belongs to project ${runner.projectId}`,
    );
  }
  return { origin, runner };
}

/** The file a revoked runner leaves in the state directory. */
export function revokedMarker(stateDir: string): string {
  return join(stateDir, "revoked.json");
}

/**
 * A token's fingerprint, so the marker never holds the token itself.
 * @param token - The runner token.
 * @returns Its sha256.
 */
function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Whether this token was revoked the last time the daemon ran with it. A
 * revoked daemon under a service manager would otherwise be restarted into
 * the same 401 forever.
 * @param stateDir - The state directory.
 * @param token - The runner token.
 * @returns True when the marker names this token.
 */
export function wasRevoked(stateDir: string, token: string): boolean {
  const file = revokedMarker(stateDir);
  if (!existsSync(file)) return false;
  try {
    return (
      (JSON.parse(readFileSync(file, "utf8")) as { token?: string }).token ===
      fingerprint(token)
    );
  } catch {
    return false;
  }
}

/**
 * Validate the config, overrides applied.
 * @param options - How the daemon was started.
 * @param env - Environment variables.
 * @returns The config and its path, or the errors as one message.
 */
function readDaemonConfig(
  options: DaemonOptions,
  env: Env,
): { config: Config | null; error?: string; path: string } {
  const path = resolveConfigPath(options.config, env);
  const checked = checkConfig(path, { env, offline: true });
  if (!checked.config) {
    const lines = checked.findings.errors.map((issue) =>
      formatIssue(issue, path),
    );
    return {
      config: null,
      path,
      error: `${path} is not valid:\n  ${lines.join("\n  ")}`,
    };
  }
  return { config: applyOverrides(checked.config, options, env), path };
}

/**
 * Run the daemon until it is stopped.
 * @param options - How it was started.
 * @returns Never; the process exits through the shutdown path.
 */
export async function runDaemon(options: DaemonOptions): Promise<void> {
  const env = options.env ?? process.env;
  const report = (message: {
    ready?: boolean;
    fatal?: string;
    pid?: number;
  }) => {
    if (options.detachedChild && process.send) {
      process.send(message);
      if (message.ready || message.fatal) process.disconnect?.();
    }
  };

  let paths: DaemonPaths;
  let log: DaemonLog;
  let config: Config;
  let state: StateDb;
  let origin: string;
  let runner: RunnerCredential;
  try {
    const read = readDaemonConfig(options, env);
    if (!read.config)
      throw new DaemonStartError(read.error ?? "invalid config");
    config = read.config;
    paths = daemonPaths(read.path, options.stateDir, config.log.file, env);
    log = new DaemonLog(paths.log, config.log.level, !options.detachedChild);
    const credentialsFile = credentialsPath(env);
    let credentials: Credentials;
    try {
      credentials = loadCredentials(credentialsFile);
    } catch (error) {
      throw new DaemonStartError(
        error instanceof Error ? error.message : String(error),
      );
    }
    ({ origin, runner } = resolveDaemonRunner(
      config,
      credentials,
      credentialsFile,
    ));
    if (wasRevoked(paths.stateDir, runner.token)) {
      throw new DaemonStartError(
        `runner "${runner.name}" was revoked on the server; run "hypotenuse runner register" to re-register`,
      );
    }
    state = new StateDb(paths.stateDb);
    try {
      await acquireLock(paths.pidfile, {
        pid: process.pid,
        socketPath: paths.socket,
        startedAt: Date.now(),
        configPath: read.path,
      });
    } catch (error) {
      state.close();
      throw new DaemonStartError(
        error instanceof LockHeld ? error.message : String(error),
        1,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof DaemonStartError ? error.code : 1;
    report({ fatal: message });
    if (!options.detachedChild)
      process.stderr.write(`hypotenuse daemon: ${message}\n`);
    process.exit(code);
  }

  const machine = realMachine(env);
  const api = new DaemonApi(origin, runner.token, (line) => log.debug(line));
  let exiting = false;
  let supervisor: Supervisor;
  let control: ControlServer;

  /**
   * Close everything, in order, without exiting.
   * @param drain - Let running turns finish (10 s grace) before stopping them.
   */
  const teardown = async (drain: boolean) => {
    if (drain) {
      await supervisor.drain({ timeoutMs: 10_000, cancel: false });
    } else {
      await supervisor.sink.drain(2_000);
    }
    supervisor.close();
    control.close();
    releaseLock(paths.pidfile);
    state.close();
  };

  const requestExit = (exit: ExitRequest) => {
    if (exiting) return;
    exiting = true;
    log.error(exit.message);
    if (exit.code === EXIT_CONFIG && /revoked/.test(exit.message)) {
      writeFileSync(
        revokedMarker(paths.stateDir),
        JSON.stringify({ token: fingerprint(runner.token), at: Date.now() }),
        {
          mode: 0o600,
        },
      );
    }
    void teardown(false).finally(() => process.exit(exit.code));
  };

  supervisor = new Supervisor({
    config,
    configPath: paths.config,
    state,
    log,
    api,
    machine,
    machineId: machineId(),
    runner: {
      runnerId: runner.runnerId,
      projectId: runner.projectId,
      name: runner.name,
    },
    executor: new AcpSessionExecutor(),
    stateDir: paths.stateDir,
    env,
    readConfig: () => readDaemonConfig(options, env),
    requestExit,
  });

  control = new ControlServer(
    paths.socket,
    {
      status: () =>
        supervisor.status({ pid: process.pid, configPath: paths.config }),
      "agents.list": (params) => supervisor.agents(Boolean(params.all)),
      "agents.kill": (params) => {
        const target = params.target;
        if (typeof target !== "string" && typeof target !== "number") {
          throw new RpcError(
            INVALID_PARAMS,
            "target is a session id or an issue identifier",
          );
        }
        return {
          killed: supervisor.kill(
            target,
            typeof params.reason === "string" ? params.reason : undefined,
          ),
        };
      },
      "worktrees.list": () =>
        state.worktrees().map((w) => ({
          path: w.path,
          repository: w.repository,
          branch: w.branch,
          state: w.state,
          agentSessionId: w.agentSessionId,
          lastUsedAt: w.lastUsedAt,
        })),
      "worktrees.cleanup": () => ({
        removed: [],
        kept: state.worktrees().map((w) => ({
          path: w.path,
          reason: "this daemon does not remove worktrees yet",
        })),
      }),
      drain: (params) =>
        supervisor.drain({
          timeoutMs:
            typeof params.timeoutMs === "number" ? params.timeoutMs : 600_000,
          cancel: params.cancel === true,
        }),
      reload: () => supervisor.reload(),
      restart: () => {
        const service = env.HYPOTENUSE_SERVICE === "1";
        setTimeout(() => {
          exiting = true;
          log.info(
            service
              ? "exiting for the service manager to restart"
              : "re-executing",
          );
          void teardown(false).then(() => {
            if (service) process.exit(EXIT_RESTART);
            const [command, ...prefix] = selfCommand();
            const child = spawn(
              command as string,
              [...prefix, ...childArgs(process.argv.slice(2))],
              {
                detached: true,
                stdio: "ignore",
                env: env as NodeJS.ProcessEnv,
              },
            );
            child.unref();
            process.exit(0);
          });
        }, 50);
        return { restarting: true, mode: service ? "service" : "re-exec" };
      },
      "mcp.call": () => {
        throw new RpcError(
          METHOD_NOT_FOUND,
          "mcp.call is reserved for the hypotenuse MCP server, which is not built yet",
        );
      },
    },
    (method, error) =>
      log.error(
        `control method ${method} failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
  );
  try {
    control.listen();
  } catch (error) {
    releaseLock(paths.pidfile);
    const message = `cannot bind ${paths.socket}: ${error instanceof Error ? error.message : String(error)}`;
    report({ fatal: message });
    log.error(message);
    process.exit(1);
  }

  // Drain grace, stop grace, a turn's wind-down, the final flush, and margin.
  setHardTimeout(10_000 + config.sessions.stop_grace + 5_000 + 5_000 + 5_000);
  register({
    close: async () => {
      if (exiting) return;
      exiting = true;
      log.info("shutting down");
      await teardown(true);
    },
  });
  onSignal("SIGHUP", () => {
    supervisor.reload();
  });

  const interrupted = supervisor.start();
  log.info(`daemon ready (pid ${process.pid})`, {
    runner: runner.name,
    server: origin,
    config: paths.config,
    interrupted: interrupted.length || undefined,
  });
  report({ ready: true, pid: process.pid });
  rmSync(revokedMarker(paths.stateDir), { force: true });
}
