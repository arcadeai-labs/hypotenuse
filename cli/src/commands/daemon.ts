/**
 * `hypotenuse daemon` — run this machine as a runner.
 *
 * ```
 * daemon start              # background: spawn itself detached, wait for "ready", exit 0
 * daemon start --foreground # what launchd/systemd run; logs to stderr and the log file
 * daemon stop               # drain over the control socket, then SIGTERM, then SIGKILL
 * daemon stop --force       # no socket needed: signal the pidfile's process, clear the lock
 * daemon restart            # stop (drain) + start
 * daemon status             # exit 3 when not running
 * daemon logs [-f] [-n 200] [--session <id>]
 * daemon reload             # re-read the config; SIGHUP does the same
 * ```
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from "node:fs";
import { type Command, Option } from "commander";
import { parseDuration } from "../config/durations";
import { loadConfig } from "../config/loader";
import { daemonPaths, defaultStateDir, tildify } from "../config/paths";
import { type CliContext, emit, runCommand, when } from "../context";
import {
  callDaemon,
  DaemonNotRunning,
  EXIT_NOT_RUNNING,
  NOT_RUNNING_MESSAGE,
} from "../daemon/control-client";
import { runDaemon } from "../daemon/main";
import {
  inspectLock,
  lockMessage,
  readLock,
  realProbe,
} from "../daemon/pidfile";
import { childArgs, selfCommand } from "../daemon/self";
import type { ReloadResult } from "../daemon/supervisor";
import { logger } from "../output/logger";
import { glyph } from "../output/theme";
import { ExitError } from "../shutdown";

/** How long a background start waits for the child to say it is ready. */
export const READY_TIMEOUT_MS = 15_000;

/** The control socket's `status` answer. */
export interface DaemonStatus {
  pid: number;
  version: string;
  uptimeMs: number;
  configPath: string;
  runner: { id: number; name: string; projectId: number };
  server: {
    url: string;
    connected: boolean;
    lastHeartbeatAt: number | null;
    socket: string;
    lastError: string | null;
    clockSkewMs: number | null;
  };
  slots: { total: number; busy: number };
  pendingEvents: number;
  draining: boolean;
}

/** Where the daemon's files are, as the CLI finds them. */
export interface DaemonLocation {
  pidfile: string;
  socket: string;
  log: string;
  stopGraceMs: number;
}

/**
 * Find the running daemon's files: the machine lock is at a fixed path and
 * records the daemon's own control socket; the log follows the config.
 * @param ctx - The command context.
 * @returns The paths.
 */
export function locateDaemon(ctx: CliContext): DaemonLocation {
  const loaded = loadConfig(ctx.configPath, ctx.env);
  const paths = daemonPaths(
    ctx.configPath,
    ctx.options.stateDir,
    loaded.config?.log.file,
    ctx.env,
  );
  const record = readLock(paths.pidfile);
  return {
    pidfile: paths.pidfile,
    socket: record?.socketPath ?? paths.socket,
    log: paths.log,
    stopGraceMs: loaded.config?.sessions.stop_grace ?? 10_000,
  };
}

/**
 * A duration flag.
 * @param value - The flag's value.
 * @param flag - Its name, for the message.
 * @returns Milliseconds.
 */
function durationFlag(value: string, flag: string): number {
  try {
    return parseDuration(value);
  } catch {
    throw new Error(`${flag}: "${value}" is not a duration (e.g. 30s, 10m)`);
  }
}

/**
 * Format an uptime.
 * @param ms - Milliseconds.
 * @returns E.g. `2h 3m`.
 */
export function uptime(ms: number): string {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/**
 * The human rendering of `status`.
 * @param status - The daemon's answer.
 * @param ctx - The context (for `~`).
 * @returns Lines for stdout.
 */
export function describeStatus(status: DaemonStatus, ctx: CliContext): string {
  const presence = status.draining
    ? "draining"
    : status.server.connected
      ? "online"
      : "offline";
  return [
    `${glyph(presence)} ${status.draining ? "draining" : "running"}  pid ${status.pid}  v${status.version}  up ${uptime(status.uptimeMs)}`,
    `config     ${tildify(status.configPath, ctx.env)}`,
    `runner     ${status.runner.name} (#${status.runner.id}) in project ${status.runner.projectId}`,
    `server     ${status.server.url}  ${status.server.connected ? "connected" : `unreachable${status.server.lastError ? ` (${status.server.lastError})` : ""}`} · socket ${status.server.socket} · heartbeat ${when(status.server.lastHeartbeatAt)}`,
    `slots      ${status.slots.busy}/${status.slots.total} busy`,
    `queued     ${status.pendingEvents} event(s) waiting for the server`,
  ].join("\n");
}

/**
 * Turn "not running" into exit 3 (and `{ running: false }` under `--json`).
 * @param ctx - The context.
 * @param error - What the call threw.
 * @throws {ExitError} With code 3 when the daemon is not running; else rethrows.
 */
function notRunning(ctx: CliContext, error: unknown): never {
  if (error instanceof DaemonNotRunning) {
    if (ctx.json) console.log(JSON.stringify({ running: false }));
    throw new ExitError(
      EXIT_NOT_RUNNING,
      ctx.json ? undefined : NOT_RUNNING_MESSAGE,
    );
  }
  throw error;
}

/**
 * Start the daemon in the background: spawn it detached, wait for `ready`.
 * @param ctx - The context.
 * @returns The child's pid.
 */
export async function startBackground(ctx: CliContext): Promise<number> {
  const location = locateDaemon(ctx);
  const lock = await inspectLock(location.pidfile);
  if (
    lock.kind === "running" ||
    lock.kind === "starting" ||
    lock.kind === "hung"
  ) {
    throw new Error(lockMessage(lock));
  }
  const [command, ...prefix] = selfCommand();
  const o = ctx.options;
  const args = childArgs([
    ...(o.config ? ["--config", o.config] : []),
    ...(o.stateDir ? ["--state-dir", o.stateDir] : []),
    ...(o.url ? ["--url", o.url] : []),
    ...(o.project ? ["--project", o.project] : []),
    ...(o.verbose ? ["--verbose"] : []),
    "daemon",
    "start",
  ]);
  const child = spawn(command as string, [...prefix, ...args], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: ctx.env as NodeJS.ProcessEnv,
  });
  const outcome = await new Promise<{
    ready?: boolean;
    fatal?: string;
    pid?: number;
    exited?: number | null;
  }>((resolve) => {
    const timer = setTimeout(() => resolve({}), READY_TIMEOUT_MS);
    child.once("message", (message) => {
      clearTimeout(timer);
      resolve(message as { ready?: boolean; fatal?: string; pid?: number });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ exited: code });
    });
  });
  child.removeAllListeners();
  if (child.connected) child.disconnect();
  child.unref();
  if (outcome.fatal) throw new Error(outcome.fatal);
  if (!outcome.ready) {
    throw new Error(
      outcome.exited !== undefined
        ? `the daemon exited (code ${outcome.exited}) before it was ready; see ${tildify(location.log, ctx.env)}`
        : `the daemon did not report ready within ${READY_TIMEOUT_MS / 1000}s; see ${tildify(location.log, ctx.env)}`,
    );
  }
  return outcome.pid ?? child.pid ?? 0;
}

/**
 * Wait for a process to exit.
 * @param pid - The process.
 * @param timeoutMs - How long.
 * @returns Whether it exited.
 */
async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!realProbe.alive(pid)) return true;
    await Bun.sleep(100);
  }
  return !realProbe.alive(pid);
}

/**
 * Signal a daemon's process group (its own pid when it leads none).
 * @param pid - The daemon.
 * @param signal - The signal.
 */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  }
}

/**
 * Stop the daemon.
 * @param ctx - The context.
 * @param options - Drain timeout, cancel, force.
 * @returns What happened, for printing.
 */
export async function stopDaemon(
  ctx: CliContext,
  options: { timeoutMs: number; cancel: boolean; force: boolean },
): Promise<string> {
  const location = locateDaemon(ctx);
  const lock = await inspectLock(location.pidfile);
  if (lock.kind === "free") throw new DaemonNotRunning(location.socket);
  if (lock.kind === "stale") {
    rmSync(location.pidfile, { force: true });
    if (lock.record?.socketPath)
      rmSync(lock.record.socketPath, { force: true });
    throw new DaemonNotRunning(location.socket);
  }
  const { pid, socketPath } = lock.record;

  if (options.force) {
    signalGroup(pid, "SIGTERM");
    if (!(await waitForExit(pid, location.stopGraceMs))) {
      signalGroup(pid, "SIGKILL");
      await waitForExit(pid, 5_000);
    }
    rmSync(location.pidfile, { force: true });
    rmSync(socketPath, { force: true });
    return `Stopped the daemon (pid ${pid}) by force; its turns' leases lapse and the server re-offers them.`;
  }
  if (lock.kind !== "running") throw new Error(lockMessage(lock));

  const spinner = logger.spinner(
    options.cancel
      ? "Stopping running turns"
      : "Waiting for running turns to finish",
  );
  let drained: { drained: boolean; cancelled: number };
  try {
    drained = await callDaemon(
      socketPath,
      "drain",
      { timeoutMs: options.timeoutMs, cancel: options.cancel },
      options.timeoutMs + location.stopGraceMs + 30_000,
    );
  } finally {
    spinner.stop();
  }
  signalGroup(pid, "SIGTERM");
  if (!(await waitForExit(pid, 30_000))) {
    signalGroup(pid, "SIGKILL");
    await waitForExit(pid, 5_000);
    rmSync(location.pidfile, { force: true });
    rmSync(socketPath, { force: true });
  }
  return `Stopped the daemon (pid ${pid})${drained.cancelled ? `; ${drained.cancelled} running turn(s) were stopped` : ""}.`;
}

/**
 * Print the last lines of the log, optionally following it.
 * @param file - The log.
 * @param options - Lines, follow, and a session filter.
 */
async function tailLog(
  file: string,
  options: { lines: number; follow: boolean; session?: string },
): Promise<void> {
  const keep = (line: string) =>
    !options.session || line.includes(` session=${options.session}`);
  if (!existsSync(file)) {
    if (!options.follow) throw new Error(`${file} does not exist yet`);
  } else {
    const all = readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .filter(keep);
    for (const line of all.slice(-options.lines)) console.log(line);
  }
  if (!options.follow) return;
  let offset = existsSync(file) ? statSync(file).size : 0;
  let partial = "";
  for (;;) {
    await Bun.sleep(500);
    if (!existsSync(file)) continue;
    const size = statSync(file).size;
    if (size < offset) offset = 0; // rotated
    if (size === offset) continue;
    const fd = openSync(file, "r");
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    closeSync(fd);
    offset = size;
    const text = partial + buffer.toString("utf8");
    const lines = text.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) if (line && keep(line)) console.log(line);
  }
}

/**
 * Register `daemon start|stop|restart|status|logs|reload`.
 * @param program - The root program.
 */
export function registerDaemonCommands(program: Command): void {
  const daemon = program
    .command("daemon")
    .description("Run this machine as a runner");

  daemon
    .command("start")
    .description("Start the daemon (in the background unless --foreground)")
    .option("--foreground", "run in this process; what a service manager runs")
    .addOption(new Option("--detached-child").hideHelp())
    .action(async function (this: Command) {
      const opts = this.opts() as {
        foreground?: boolean;
        detachedChild?: boolean;
      };
      if (opts.foreground) {
        const globals = this.optsWithGlobals() as {
          config?: string;
          stateDir?: string;
          url?: string;
          project?: string;
          verbose?: boolean;
        };
        await runDaemon({
          config: globals.config,
          stateDir: globals.stateDir,
          url: globals.url,
          project: globals.project,
          verbose: globals.verbose,
          detachedChild: Boolean(opts.detachedChild),
        });
        return;
      }
      await runCommand(this, async (ctx) => {
        const pid = await startBackground(ctx);
        const { log } = locateDaemon(ctx);
        emit(
          ctx,
          { started: true, pid },
          () =>
            `Started the daemon (pid ${pid}). Logs: ${tildify(log, ctx.env)}`,
        );
      });
    });

  daemon
    .command("stop")
    .description("Stop the daemon, letting running turns finish first")
    .option(
      "--timeout <duration>",
      "how long running turns may take before they are stopped",
      "10m",
    )
    .option("--cancel", "stop running turns at once")
    .option(
      "--force",
      "signal the daemon without its control socket and clear its lock",
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as {
          timeout: string;
          cancel?: boolean;
          force?: boolean;
        };
        try {
          const message = await stopDaemon(ctx, {
            timeoutMs: durationFlag(opts.timeout, "--timeout"),
            cancel: Boolean(opts.cancel),
            force: Boolean(opts.force),
          });
          emit(ctx, { stopped: true }, () => message);
        } catch (error) {
          notRunning(ctx, error);
        }
      });
    });

  daemon
    .command("restart")
    .description("Stop the daemon (draining) and start it again")
    .option(
      "--timeout <duration>",
      "how long running turns may take before they are stopped",
      "10m",
    )
    .option("--cancel", "stop running turns at once")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as { timeout: string; cancel?: boolean };
        try {
          await stopDaemon(ctx, {
            timeoutMs: durationFlag(opts.timeout, "--timeout"),
            cancel: Boolean(opts.cancel),
            force: false,
          });
        } catch (error) {
          if (!(error instanceof DaemonNotRunning)) throw error;
        }
        const pid = await startBackground(ctx);
        emit(
          ctx,
          { restarted: true, pid },
          () => `Restarted the daemon (pid ${pid}).`,
        );
      });
    });

  daemon
    .command("status")
    .description(
      "Show the running daemon's state (exit 3 when it is not running)",
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const { socket } = locateDaemon(ctx);
        try {
          const status = await callDaemon<DaemonStatus>(socket, "status");
          emit(ctx, { running: true, ...status }, () =>
            describeStatus(status, ctx),
          );
        } catch (error) {
          notRunning(ctx, error);
        }
      });
    });

  daemon
    .command("logs")
    .description("Print the daemon's log")
    .option("-f, --follow", "keep printing new lines")
    .option("-n, --lines <n>", "how many lines to print", "200")
    .option("--session <id>", "only lines about one agent session")
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const opts = this.opts() as {
          follow?: boolean;
          lines: string;
          session?: string;
        };
        await tailLog(locateDaemon(ctx).log, {
          lines: Number(opts.lines) || 200,
          follow: Boolean(opts.follow),
          session: opts.session,
        });
      });
    });

  daemon
    .command("reload")
    .description(
      "Re-read the config file and apply what is safe to apply now (SIGHUP does the same)",
    )
    .action(async function (this: Command) {
      await runCommand(this, async (ctx) => {
        const { socket } = locateDaemon(ctx);
        let result: ReloadResult;
        try {
          result = await callDaemon<ReloadResult>(socket, "reload", {}, 30_000);
        } catch (error) {
          notRunning(ctx, error);
        }
        if (result.error) {
          emit(ctx, result, () => "");
          throw new Error(
            `the daemon kept its running config: ${result.error}`,
          );
        }
        emit(ctx, result, () =>
          [
            result.applied.length
              ? `Applied: ${result.applied.join(", ")}`
              : "Nothing changed.",
            result.requiresRestart.length
              ? `Needs \`hypotenuse daemon restart\`: ${result.requiresRestart.join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
      });
    });
}

/** The default machine lock path, for `doctor`. */
export function defaultPidfile(
  env: Record<string, string | undefined> = process.env,
): string {
  return `${defaultStateDir(env)}/daemon.pid`;
}
