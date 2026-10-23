import { afterAll, beforeAll, expect } from "bun:test";
import { api } from "keryx";
import { DaemonHome, type DaemonHomeOptions, until } from "../daemon/helpers";
import { useFinear } from "../linear/finear";
import { appToken, integrationRow } from "../linear/helpers";
import {
  createIssue,
  delegate,
  type FinearActivity,
  finearSession,
  sessionRow,
  settle,
} from "../linear/sessions";
import { withoutRunnerRateLimits } from "../routing/helpers";
import { runnerRow } from "../runners/helpers";
import {
  buildTestUniverse,
  HOOK_TIMEOUT,
  runAction,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * The end-to-end harness: every process the product has, run as itself —
 * finear standing in for Linear, the real backend, one or more real
 * `hypotenuse daemon --foreground` children in their own homes, and the
 * scripted fake ACP agent each daemon starts per turn, in a real git worktree
 * of a clone whose origin is a local bare repository.
 *
 * Only the server's background work runs in this process rather than on a
 * Resque worker: a **pump** runs processing, routing, and the activity outbox
 * ({@link settle}) every 100 ms, as the deployed worker's queues and clocks
 * would, and the telemetry relay's export clock. Tests never call `settle()` themselves; they wait on what crossed a
 * process — finear's record of the session, which is what a person sees.
 * The lease and queue clocks (`work:reap`) do not pump: a test that needs
 * one writes the column and runs it, so no assertion waits out a timer.
 *
 * Teardown stops every daemon and fails the file if any process a daemon
 * started (an agent, its MCP server) outlives it.
 */

/** What a test file gets from {@link useE2E}. */
export interface E2E {
  /** The seeded server, its people, and its project. */
  readonly universe: TestUniverse;
  /** finear, with its control routes. */
  readonly linear: ReturnType<typeof useFinear>;
  /** The app user sessions are delegated to. */
  readonly appUserId: string;
  /** The app's access token, to read sessions as Linear holds them. */
  readonly token: string;
  /**
   * Register a runner as a person, lay out its home, start its daemon, and
   * wait until the server sees it online.
   * @param user - The runner's owner.
   * @param name - The runner's name.
   * @param options - Scenario, roles, and config for its home.
   * @returns The running home.
   */
  daemon(
    user: TestUser,
    name: string,
    options?: DaemonHomeOptions,
  ): Promise<DaemonHome>;
  /**
   * Restart a home's daemon (same runner, state, and worktrees), optionally
   * with its agent playing another scenario.
   * @param home - The home.
   * @param scenario - The new scenario, if it changes.
   * @returns The new home handle.
   */
  restart(home: DaemonHome, scenario?: string): Promise<DaemonHome>;
  /**
   * Create an issue and delegate it to the app as finear's Human 1, then wait
   * for the server to mirror the session. Nothing else is waited for.
   * @param title - The issue's title.
   * @returns The issue, Linear's session id, and the mirror row's id.
   */
  delegate(title: string): Promise<{
    issue: { id: string; identifier: string };
    externalSessionId: string;
    agentSessionId: number;
  }>;
  /**
   * A person types in the session (or presses Stop) in finear.
   * @param externalSessionId - Linear's session id.
   * @param body - What they type.
   * @param signal - `stop` to press Stop.
   */
  say(externalSessionId: string, body: string, signal?: "stop"): Promise<void>;
  /**
   * Wait until finear's record of a session satisfies a check.
   * @param externalSessionId - Linear's session id.
   * @param check - Over the session's status and persisted activities.
   * @param timeoutMs - How long.
   * @returns The session as finear holds it.
   */
  linearSession(
    externalSessionId: string,
    check: (s: LinearView) => boolean,
    timeoutMs?: number,
  ): Promise<LinearView>;
  /** Hold the pump (for a test that must order the server's work itself). */
  pause(): Promise<void>;
  /** Resume the pump. */
  resume(): void;
}

/** A session as the person sees it in Linear. */
export interface LinearView {
  status: string;
  activities: FinearActivity[];
}

/**
 * Boot the whole system for one test file. Call at the top level of the file.
 * @returns The handle; its fields are ready inside tests.
 */
export function useE2E(): E2E {
  let universe!: TestUniverse;
  beforeAll(async () => {
    universe = await buildTestUniverse();
  }, HOOK_TIMEOUT);
  const linear = useFinear();
  withoutRunnerRateLimits();

  let appUserId = "";
  let token = "";
  let pumping = false;
  let paused = false;
  let idle: Promise<void> = Promise.resolve();
  const homes = new Set<DaemonHome>();

  beforeAll(async () => {
    await linear.install(universe.projectId, universe.peach.sessionId);
    appUserId = (await integrationRow(universe.projectId)).externalAppUserId;
    token = await appToken(universe.projectId);
    pumping = true;
    idle = (async () => {
      while (pumping) {
        if (!paused) {
          await settle(3);
          // The relay's clock: what a project's collectors receive.
          await runAction("telemetry:export");
        }
        await Bun.sleep(100);
      }
    })();
  }, HOOK_TIMEOUT);

  afterAll(async () => {
    const survivors: number[] = [];
    for (const home of homes) {
      const pid = home.proc?.pid;
      const children = pid ? descendants(pid) : [];
      await home.kill();
      for (const child of children) {
        // Give a child a moment to notice its parent's pipes closing.
        const gone = await until(async () => !alive(child), 5_000).catch(
          () => false,
        );
        if (!gone) {
          survivors.push(child);
          process.kill(child, "SIGKILL");
        }
      }
    }
    pumping = false;
    await idle;
    await api.stop();
    expect(survivors, "processes that outlived their daemon").toEqual([]);
  }, HOOK_TIMEOUT);

  /**
   * Wait until the server sees a runner online — a session delegated before
   * a new daemon's first heartbeat would find no runner — from a heartbeat
   * after `since`, so a restart is not satisfied by the row its previous
   * daemon left behind.
   * @param home - The home.
   * @param since - The heartbeat must be later than this.
   */
  async function online(home: DaemonHome, since = 0): Promise<void> {
    await until(async () => {
      const row = await runnerRow(home.runner.id);
      return row.status === "online" &&
        (row.lastHeartbeatAt?.getTime() ?? 0) > since
        ? row
        : null;
    });
  }

  return {
    get universe() {
      return universe;
    },
    linear,
    get appUserId() {
      return appUserId;
    },
    get token() {
      return token;
    },
    async daemon(user, name, options = {}) {
      const home = await DaemonHome.create(
        universe.url,
        user,
        universe.projectId,
        name,
        options,
      );
      homes.add(home);
      await home.startForeground();
      await online(home);
      return home;
    },
    async restart(home, scenario) {
      await home.kill();
      homes.delete(home);
      const next = new DaemonHome(
        home.root,
        home.url,
        home.runner,
        home.machine,
        home.turnMs,
        scenario ?? home.scenario,
        home.extraEnv,
      );
      homes.add(next);
      const since = Date.now();
      await next.startForeground();
      await online(next, since);
      return next;
    },
    async delegate(title) {
      const issue = await createIssue(linear, title);
      const externalSessionId = await delegate(linear, issue.id, appUserId);
      const row = await until(() => sessionRow(externalSessionId));
      return { issue, externalSessionId, agentSessionId: row.id };
    },
    async say(externalSessionId, body, signal) {
      await linear.control(
        signal === "stop" ? "/__test/agents/stop" : "/__test/agents/prompt",
        { sessionId: externalSessionId, body },
      );
    },
    async linearSession(externalSessionId, check, timeoutMs = 30_000) {
      return until(async () => {
        const view = await finearSession(linear, token, externalSessionId);
        return check(view) ? view : null;
      }, timeoutMs);
    },
    async pause() {
      paused = true;
      // Let a pass already under way finish.
      await Bun.sleep(300);
    },
    resume() {
      paused = false;
    },
  };
}

/**
 * Whether a process is alive.
 * @param pid - The process.
 * @returns True while it runs.
 */
export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every process below a pid, by walking `ps`'s parent links.
 * @param root - The ancestor.
 * @returns The descendants' pids.
 */
export function descendants(root: number): number[] {
  const ps = Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid="]);
  const children = new Map<number, number[]>();
  for (const line of ps.stdout.toString().trim().split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid)?.push(pid);
  }
  const out: number[] = [];
  const queue = [root];
  while (queue.length) {
    for (const child of children.get(queue.shift() as number) ?? []) {
      out.push(child);
      queue.push(child);
    }
  }
  return out;
}

/**
 * The bodies of a session's activities of one kind, oldest first.
 * @param view - The session as finear holds it.
 * @param typename - `AgentActivityThoughtContent`, `…ResponseContent`, ….
 * @returns The bodies.
 */
export function bodies(view: LinearView, typename: string): string[] {
  return view.activities
    .filter((a) => a.content.__typename === typename)
    .map((a) => a.content.body ?? "");
}
