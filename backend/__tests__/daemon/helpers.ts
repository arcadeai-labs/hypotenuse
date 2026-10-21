import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { agentActivities } from "../../schema/agent_activities";
import { registerRunner, type TestRunner } from "../runners/helpers";
import type { TestUser } from "../setup";

/**
 * The real `hypotenuse daemon`, spawned from source against the booted
 * server: a temporary home with its own config, credentials, state, and a git
 * clone whose origin is `github.com/acme/web`. Nothing is scripted on the
 * daemon's side — it heartbeats, subscribes, claims, posts events, and
 * completes on its own, with the null executor in its slots.
 */

/** The CLI's entry point, run from source. */
export const CLI = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "cli",
  "src",
  "cli.ts",
);

/** Options for one daemon home. */
export interface DaemonHomeOptions {
  /** How long the null executor holds each turn open. */
  turnMs?: number;
  /** Extra config TOML appended to the file. */
  extraConfig?: string;
  /** The server origin the daemon talks to (a proxy, say). */
  serverUrl?: string;
}

/** A registered runner with a home directory its daemon runs in. */
export class DaemonHome {
  /** The running daemon, when started in the foreground. */
  proc: ReturnType<typeof Bun.spawn> | null = null;
  private output = "";

  /**
   * @param root - The temporary home directory.
   * @param url - The server the daemon talks to.
   * @param runner - The registered runner.
   * @param machine - The raw machine id this home reports.
   * @param turnMs - How long the null executor holds a turn.
   */
  constructor(
    readonly root: string,
    readonly url: string,
    readonly runner: TestRunner,
    readonly machine: string,
    readonly turnMs: number,
  ) {}

  /**
   * Register a runner as a person and lay out a home for its daemon.
   * @param url - The server (where the runner is registered).
   * @param user - The runner's owner.
   * @param projectId - The project.
   * @param name - The runner's name.
   * @param options - Turn length, extra config, and the daemon's server URL.
   * @returns The home.
   */
  static async create(
    url: string,
    user: TestUser,
    projectId: number,
    name: string,
    options: DaemonHomeOptions = {},
  ): Promise<DaemonHome> {
    const runner = await registerRunner(url, user, projectId, name);
    // Short paths: a Unix socket path is limited to about 100 bytes.
    const root = mkdtempSync(join(tmpdir(), "hypd-"));
    const daemonUrl = options.serverUrl ?? url;
    const repo = join(root, "web");
    mkdirSync(repo);
    for (const args of [
      ["init", "-q"],
      ["remote", "add", "origin", "git@github.com:acme/web.git"],
    ]) {
      const git = Bun.spawnSync(["git", ...args], { cwd: repo });
      if (git.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed`);
    }
    mkdirSync(join(root, "config", "hypotenuse"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      join(root, "config", "hypotenuse", "credentials.json"),
      JSON.stringify({
        version: 1,
        current: daemonUrl,
        servers: {
          [daemonUrl]: {
            login: null,
            project: projectId,
            runner: {
              runnerId: runner.id,
              projectId,
              name: runner.name,
              token: runner.token,
            },
          },
        },
      }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(root, "config", "hypotenuse", "config.toml"),
      [
        "config_version = 1",
        "[server]",
        `url = "${daemonUrl}"`,
        "[runner]",
        `name = "${name}"`,
        "max_parallel_jobs = 2",
        'roles = ["worker"]',
        "[agents.claude]",
        'command = ["bun"]',
        "[roles.worker]",
        'agent = "claude"',
        "[[repositories]]",
        'path = "~/web"',
        'base_branch = "main"',
        "[sessions]",
        'worktree_root = "~/worktrees"',
        'stop_grace = "2s"',
        "[log]",
        'level = "debug"',
        options.extraConfig ?? "",
      ].join("\n"),
    );
    return new DaemonHome(
      root,
      daemonUrl,
      runner,
      `test-machine-${runner.id}`,
      options.turnMs ?? 0,
    );
  }

  /** The config file. */
  get configPath(): string {
    return join(this.root, "config", "hypotenuse", "config.toml");
  }

  /** The default state directory. */
  get stateDir(): string {
    return join(this.root, "state", "hypotenuse");
  }

  /** The environment every command in this home runs with. */
  env(): Record<string, string | undefined> {
    return {
      ...process.env,
      HOME: this.root,
      XDG_CONFIG_HOME: join(this.root, "config"),
      XDG_STATE_HOME: join(this.root, "state"),
      HYPOTENUSE_MACHINE_ID: this.machine,
      HYPOTENUSE_NULL_TURN_MS: String(this.turnMs),
      HYPOTENUSE_NO_UPDATE_CHECK: "1",
      HYPOTENUSE_URL: undefined,
      HYPOTENUSE_CONFIG: undefined,
      HYPOTENUSE_PROJECT: undefined,
      NO_COLOR: "1",
      FORCE_COLOR: undefined,
    };
  }

  /**
   * Run a CLI command to completion.
   * @param args - Arguments after `hypotenuse`.
   * @returns Its exit code and output.
   */
  async run(
    args: string[],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const proc = Bun.spawn(["bun", "run", CLI, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      env: this.env(),
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  }

  /**
   * Start `daemon start --foreground` and wait until it says it is ready.
   * @returns The daemon process.
   */
  async startForeground(): Promise<ReturnType<typeof Bun.spawn>> {
    this.output = "";
    const proc = Bun.spawn(
      ["bun", "run", CLI, "daemon", "start", "--foreground"],
      {
        stdout: "ignore",
        stderr: "pipe",
        stdin: "ignore",
        env: this.env(),
      },
    );
    this.proc = proc;
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
        this.output += decoder.decode(chunk);
      }
    })();
    await this.waitForLog(/daemon ready/, 20_000);
    return proc;
  }

  /** What the foreground daemon wrote to stderr. */
  get stderr(): string {
    return this.output;
  }

  /** The daemon's log file. */
  log(): string {
    try {
      return readFileSync(join(this.stateDir, "daemon.log"), "utf8");
    } catch {
      return "";
    }
  }

  /**
   * Wait for a line in the log.
   * @param pattern - What to wait for.
   * @param timeoutMs - How long.
   */
  async waitForLog(pattern: RegExp, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pattern.test(this.log()) || pattern.test(this.output)) return;
      if (this.proc && this.proc.exitCode !== null) {
        throw new Error(
          `the daemon exited (${this.proc.exitCode}) before ${pattern}:\n${this.output}${this.log()}`,
        );
      }
      await Bun.sleep(50);
    }
    throw new Error(
      `timed out waiting for ${pattern} in the daemon log:\n${this.log()}`,
    );
  }

  /** Stop a foreground daemon however it is, and wait for it. */
  async kill(signal: NodeJS.Signals = "SIGTERM"): Promise<number | null> {
    if (!this.proc) return null;
    if (this.proc.exitCode === null) this.proc.kill(signal);
    const code = await this.proc.exited;
    this.proc = null;
    return code;
  }
}

/**
 * Wait until a check passes, bounded — for what crosses a process boundary.
 * @param check - Returns a value when done.
 * @param timeoutMs - How long.
 * @returns The value.
 */
export async function until<T>(
  check: () => Promise<T | undefined | null | false>,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(50);
  }
}

/**
 * A session's outbound activity rows, in `seq` order.
 * @param agentSessionId - The session.
 * @returns The rows.
 */
export async function outbound(agentSessionId: number) {
  const rows = await api.db.db
    .select()
    .from(agentActivities)
    .where(eq(agentActivities.agentSessionId, agentSessionId));
  return rows
    .filter((r) => r.direction === "outbound")
    .sort((a, b) => a.seq - b.seq);
}
