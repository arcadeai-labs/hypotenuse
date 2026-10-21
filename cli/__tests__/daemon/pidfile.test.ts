import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireLock,
  inspectLock,
  LockHeld,
  type LockRecord,
  looksLikeDaemon,
  type ProcessProbe,
  STARTING_WINDOW_MS,
} from "../../src/daemon/pidfile";

/**
 * The machine lock. Every row of its table, with a stated process probe; then
 * real daemons: a second start with another config finds the first through
 * the socket the first recorded, and a wedged daemon is refused as hung until
 * `stop --force` clears it.
 */

const CLI = join(import.meta.dir, "..", "..", "src", "cli.ts");

/**
 * A pidfile path in a fresh directory.
 * @returns The path.
 */
function lockPath(): string {
  return join(mkdtempSync(join(tmpdir(), "hypl-")), "daemon.pid");
}

/**
 * A stated probe.
 * @param spec - Which pids live, which are daemons, which sockets answer.
 * @returns The probe.
 */
function probe(spec: {
  alive?: number[];
  daemon?: number[];
  answers?: string[];
}): ProcessProbe {
  return {
    alive: (pid) => (spec.alive ?? []).includes(pid),
    isDaemon: (pid) => (spec.daemon ?? []).includes(pid),
    answers: async (path) => (spec.answers ?? []).includes(path),
  };
}

/**
 * Write a pidfile.
 * @param path - Where.
 * @param record - What.
 */
function writeLock(path: string, record: LockRecord): void {
  writeFileSync(path, JSON.stringify(record));
}

describe("the lock table", () => {
  const now = 1_000_000;
  const record = (startedAt = now - 60_000): LockRecord => ({
    pid: 42,
    socketPath: "/s/other.sock",
    startedAt,
  });

  test("no pidfile is free", async () => {
    expect((await inspectLock(lockPath(), probe({}))).kind).toBe("free");
  });

  test("a dead pid is stale", async () => {
    const path = lockPath();
    writeLock(path, record());
    expect((await inspectLock(path, probe({}), () => now)).kind).toBe("stale");
  });

  test("a live pid that is not a hypotenuse daemon is stale (the pid was reused)", async () => {
    const path = lockPath();
    writeLock(path, record());
    expect(
      (await inspectLock(path, probe({ alive: [42] }), () => now)).kind,
    ).toBe("stale");
  });

  test("a daemon whose recorded socket answers is running", async () => {
    const path = lockPath();
    writeLock(path, record());
    const p = probe({ alive: [42], daemon: [42], answers: ["/s/other.sock"] });
    expect((await inspectLock(path, p, () => now)).kind).toBe("running");
  });

  test("a silent daemon younger than 30 s is starting; older is hung", async () => {
    const path = lockPath();
    const p = probe({ alive: [42], daemon: [42] });
    writeLock(path, record(now - STARTING_WINDOW_MS + 1));
    expect((await inspectLock(path, p, () => now)).kind).toBe("starting");
    writeLock(path, record(now - STARTING_WINDOW_MS));
    expect((await inspectLock(path, p, () => now)).kind).toBe("hung");
  });

  test("acquire retakes a stale lock and refuses a live one with its message", async () => {
    const path = lockPath();
    writeLock(path, record());
    await acquireLock(
      path,
      { pid: 7, socketPath: "/s/mine.sock", startedAt: Date.now() },
      probe({}),
    );
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(7);

    const p = probe({ alive: [7], daemon: [7] });
    const refused = await acquireLock(
      path,
      { pid: 8, socketPath: "/s/x.sock", startedAt: Date.now() },
      p,
    ).catch((e: LockHeld) => e);
    expect(refused).toBeInstanceOf(LockHeld);
    expect((refused as LockHeld).message).toBe(
      "another daemon is starting (pid 7)",
    );
  });

  test("a command line is a daemon when the program is followed by `daemon`", () => {
    expect(
      looksLikeDaemon([
        "/usr/local/bin/hypotenuse",
        "daemon",
        "start",
        "--foreground",
      ]),
    ).toBe(true);
    expect(
      looksLikeDaemon([
        "bun",
        "/x/dist/hypotenuse.js",
        "-c",
        "a.toml",
        "daemon",
        "start",
      ]),
    ).toBe(true);
    expect(
      looksLikeDaemon(["bun", "run", "/src/cli/src/cli.ts", "daemon", "start"]),
    ).toBe(true);
    expect(looksLikeDaemon(["/usr/bin/vim", "daemon"])).toBe(false);
    expect(looksLikeDaemon(["hypotenuse", "runner", "list"])).toBe(false);
  });
});

/** A home with a config whose server never answers: the daemon starts anyway. */
class Home {
  readonly root = mkdtempSync(join(tmpdir(), "hyph-"));
  procs: ReturnType<typeof Bun.spawn>[] = [];

  constructor() {
    mkdirSync(join(this.root, "config", "hypotenuse"), {
      recursive: true,
      mode: 0o700,
    });
    writeFileSync(
      join(this.root, "config", "hypotenuse", "credentials.json"),
      JSON.stringify({
        version: 1,
        current: null,
        servers: {
          "http://127.0.0.1:9": {
            login: null,
            project: 1,
            runner: { runnerId: 1, projectId: 1, name: "r", token: "hyp_rt_x" },
          },
        },
      }),
      { mode: 0o600 },
    );
    for (const name of ["config.toml", "other.toml"]) {
      writeFileSync(
        join(this.root, "config", "hypotenuse", name),
        'config_version = 1\n[server]\nurl = "http://127.0.0.1:9"\n[agents.fake]\ncommand = ["bun"]\n[roles.worker]\nagent = "fake"\n[sessions]\nworktree_root = "~/trees"\nstop_grace = "1s"\n',
      );
    }
  }

  /** The environment. */
  env(): Record<string, string | undefined> {
    return {
      ...process.env,
      HOME: this.root,
      XDG_CONFIG_HOME: join(this.root, "config"),
      XDG_STATE_HOME: join(this.root, "state"),
      HYPOTENUSE_NO_UPDATE_CHECK: "1",
      HYPOTENUSE_URL: undefined,
      HYPOTENUSE_CONFIG: undefined,
      NO_COLOR: "1",
    };
  }

  /**
   * Run the CLI to completion.
   * @param args - Its arguments.
   * @returns Code and output.
   */
  async run(args: string[]) {
    const proc = Bun.spawn(["bun", "run", CLI, ...args], {
      stdout: "pipe",
      stderr: "pipe",
      env: this.env(),
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code: await proc.exited, stdout, stderr };
  }

  /** The machine lock. */
  get pidfile(): string {
    return join(this.root, "state", "hypotenuse", "daemon.pid");
  }

  /** Stop anything left. */
  cleanup(): void {
    for (const proc of this.procs) proc.kill("SIGKILL");
    try {
      const { pid } = JSON.parse(readFileSync(this.pidfile, "utf8"));
      process.kill(pid, "SIGCONT");
      process.kill(pid, "SIGKILL");
    } catch {
      // Nothing running.
    }
  }
}

describe("real daemons on one machine", () => {
  let home: Home | null = null;
  afterEach(() => home?.cleanup());

  test("a second start with another config finds the first; a wedged one is hung until stop --force", async () => {
    home = new Home();
    const first = await home.run(["daemon", "start"]);
    expect(first.code).toBe(0);
    expect(first.stdout).toMatch(/Started the daemon \(pid \d+\)/);
    const record = JSON.parse(readFileSync(home.pidfile, "utf8")) as LockRecord;

    // Another config keeps its state elsewhere, but the lock is shared.
    const other = join(home.root, "config", "hypotenuse", "other.toml");
    const second = await home.run(["-c", other, "daemon", "start"]);
    expect(second.code).toBe(1);
    expect(second.stderr).toContain(
      `a daemon is already running (pid ${record.pid}`,
    );

    // Wedge it: alive, a daemon, silent — and old enough not to be "starting".
    process.kill(record.pid, "SIGSTOP");
    writeFileSync(
      home.pidfile,
      JSON.stringify({ ...record, startedAt: Date.now() - 60_000 }),
    );
    const hung = await home.run(["daemon", "start"]);
    expect(hung.code).toBe(1);
    expect(hung.stderr).toContain(
      `daemon pid ${record.pid} is not responding; run \`hypotenuse daemon stop --force\``,
    );
    const stop = await home.run(["daemon", "stop"]);
    expect(stop.code).toBe(1);
    expect(stop.stderr).toContain("hypotenuse daemon stop --force");

    const forced = await home.run(["daemon", "stop", "--force"]);
    expect(forced.code).toBe(0);
    expect(existsSync(home.pidfile)).toBe(false);

    const again = await home.run(["daemon", "start"]);
    expect(again.code).toBe(0);
    const stopped = await home.run(["daemon", "stop", "--timeout", "1s"]);
    expect(stopped.code).toBe(0);
    expect((await home.run(["daemon", "status"])).code).toBe(3);
  }, 60_000);

  test("a background start that cannot start reports why and exits non-zero", async () => {
    home = new Home();
    writeFileSync(
      join(home.root, "config", "hypotenuse", "config.toml"),
      'config_version = 1\n[runner]\nroles = ["manager"]\n',
    );
    const result = await home.run(["daemon", "start"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'runner.roles[0]: "manager" has no [roles.manager] table',
    );
  }, 30_000);
});

describe("restart after an upgrade", () => {
  let home: Home | null = null;
  afterEach(() => home?.cleanup());

  test("`restart` over the control socket re-executes the daemon as a new process", async () => {
    home = new Home();
    expect((await home.run(["daemon", "start"])).code).toBe(0);
    const before = JSON.parse(readFileSync(home.pidfile, "utf8")) as LockRecord;
    const { callDaemon } = await import("../../src/daemon/control-client");
    expect(await callDaemon(before.socketPath, "restart")).toEqual({
      restarting: true,
      mode: "re-exec",
    });
    const deadline = Date.now() + 15_000;
    let after: LockRecord | null = null;
    while (Date.now() < deadline) {
      try {
        const record = JSON.parse(
          readFileSync(home.pidfile, "utf8"),
        ) as LockRecord;
        if (record.pid !== before.pid) {
          const status = await callDaemon<{ pid: number }>(
            record.socketPath,
            "status",
            {},
            1_000,
          );
          if (status.pid === record.pid) {
            after = record;
            break;
          }
        }
      } catch {
        // Between the two processes.
      }
      await Bun.sleep(100);
    }
    expect(after?.pid).toBeDefined();
    expect(after?.pid).not.toBe(before.pid);
    expect((await home.run(["daemon", "stop", "--timeout", "1s"])).code).toBe(
      0,
    );
  }, 30_000);
});
