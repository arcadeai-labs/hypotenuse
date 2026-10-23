/**
 * Path handling for the config file and the daemon's files.
 *
 * A path in the config file expands `~` and `$VAR` / `${VAR}`, and a relative
 * one resolves against the **config file's directory**, so a repo-local config
 * can say `prompt_file = "prompts/worker.md"`.
 *
 * The daemon's state directory follows `$XDG_STATE_HOME` (else
 * `~/.local/state/hypotenuse`); a config file anywhere but the default path
 * keeps its state beside it, in `<config dir>/.hypotenuse-state/`, so two
 * daemons with two configs never share a socket by accident. The machine lock
 * is the exception: it is always in the default state directory, whatever
 * `--state-dir` or `-c` say, because it is how a second daemon finds the first.
 */
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { defaultConfigPath } from "../paths";

/** Environment variables, injected so tests state them. */
export type Env = Record<string, string | undefined>;

/**
 * The home directory for an environment.
 * @param env - Environment variables.
 * @returns `$HOME`, else the OS's idea of it.
 */
export function homeOf(env: Env = process.env): string {
  return env.HOME || homedir();
}

/**
 * Expand `~` and environment variables in a path, and make it absolute.
 * An unset variable expands to nothing, as a shell would.
 * @param raw - The path as written.
 * @param baseDir - What a relative path resolves against.
 * @param env - Environment variables.
 * @returns The absolute path.
 */
export function expandPath(
  raw: string,
  baseDir: string,
  env: Env = process.env,
): string {
  let value = raw.trim();
  if (value === "~") value = homeOf(env);
  else if (value.startsWith("~/")) value = join(homeOf(env), value.slice(2));
  value = value.replace(
    /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (_, braced: string | undefined, bare: string | undefined) =>
      env[(braced ?? bare) as string] ?? "",
  );
  return isAbsolute(value) ? resolve(value) : resolve(baseDir, value);
}

/**
 * Whether a prompt source (`prompt_file`, a `docs` entry) is a URL. The
 * daemon never fetches one: the agent reads it with its own tools.
 * @param source - The source, as written or as the schema left it.
 * @returns True for an `http://` or `https://` URL.
 */
export function isRemoteSource(source: string): boolean {
  return /^https?:\/\//i.test(source.trim());
}

/**
 * Show a path the way a person wrote it: under the home directory as `~/…`.
 * @param path - An absolute path.
 * @param env - Environment variables.
 * @returns The path, shortened.
 */
export function tildify(path: string, env: Env = process.env): string {
  const home = homeOf(env);
  return path === home
    ? "~"
    : path.startsWith(`${home}/`)
      ? `~/${path.slice(home.length + 1)}`
      : path;
}

/**
 * The default state directory.
 * @param env - Environment variables.
 * @returns `$XDG_STATE_HOME/hypotenuse`, or `~/.local/state/hypotenuse`.
 */
export function defaultStateDir(env: Env = process.env): string {
  const base = env.XDG_STATE_HOME || join(homeOf(env), ".local", "state");
  return join(base, "hypotenuse");
}

/**
 * The config path a command reads: `-c/--config`, then `HYPOTENUSE_CONFIG`,
 * then the default.
 * @param flag - The `-c` value, if given.
 * @param env - Environment variables.
 * @returns The absolute path.
 */
export function resolveConfigPath(
  flag: string | undefined,
  env: Env = process.env,
): string {
  const chosen = flag ?? env.HYPOTENUSE_CONFIG;
  return chosen
    ? expandPath(chosen, process.cwd(), env)
    : defaultConfigPath(env);
}

/**
 * The state directory for a config: `--state-dir`, else beside a config that
 * is not at the default path, else the default.
 * @param configPath - The resolved config path.
 * @param flag - `--state-dir`, if given.
 * @param env - Environment variables.
 * @returns The absolute path.
 */
export function resolveStateDir(
  configPath: string,
  flag: string | undefined,
  env: Env = process.env,
): string {
  if (flag) return expandPath(flag, process.cwd(), env);
  if (resolve(configPath) !== resolve(defaultConfigPath(env))) {
    return join(dirname(resolve(configPath)), ".hypotenuse-state");
  }
  return defaultStateDir(env);
}

/** Every file the daemon keeps, for one state directory. */
export interface DaemonPaths {
  /** The config file. */
  config: string;
  /** The state directory. */
  stateDir: string;
  /** `state.db`. */
  stateDb: string;
  /** The control socket. */
  socket: string;
  /** The machine lock, always in the default state directory. */
  pidfile: string;
  /** The daemon log. */
  log: string;
  /** Per-session agent logs. */
  sessionLogs: string;
}

/**
 * Lay out the daemon's files.
 * @param configPath - The resolved config path.
 * @param stateDirFlag - `--state-dir`, if given.
 * @param logFile - `[log] file`, if set (already absolute).
 * @param env - Environment variables.
 * @returns The paths.
 */
export function daemonPaths(
  configPath: string,
  stateDirFlag: string | undefined,
  logFile: string | undefined,
  env: Env = process.env,
): DaemonPaths {
  const stateDir = resolveStateDir(configPath, stateDirFlag, env);
  return {
    config: configPath,
    stateDir,
    stateDb: join(stateDir, "state.db"),
    socket: join(stateDir, "daemon.sock"),
    pidfile: join(defaultStateDir(env), "daemon.pid"),
    log: logFile ?? join(stateDir, "daemon.log"),
    sessionLogs: join(stateDir, "sessions"),
  };
}
