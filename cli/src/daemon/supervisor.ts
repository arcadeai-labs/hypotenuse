/**
 * The supervisor: the daemon's slots and everything that moves work in and
 * out of them.
 *
 * It owns `runner.max_parallel_jobs` slots, counted again per role and per
 * agent with a `max_parallel`. An offer (from a heartbeat, which a socket
 * frame only hastens) is claimed when the machine, its role, and its agent all
 * have room and its session has no turn here already; the claim's assignment
 * runs in a slot under an `AbortSignal` that fires on a cancel, `agents kill`,
 * a drain, or shutdown. A finished turn queues its completion behind its
 * events and frees its slot at once — a session waiting for a person holds
 * nothing. The server does the counting that routing depends on; the checks
 * here are the guard for a race (an offer that arrived just before a reload
 * lowered a limit), not the routing decision.
 */
import { hostname } from "node:os";
import {
  type ActiveItem,
  type Cancel,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type Offer,
  PROTOCOL_VERSION,
  type WorkAssignment,
} from "../../../protocol/src/index";
import pkg from "../../package.json";
import { ApiError } from "../api/client";
import type { MachineEnv, ResolvedRepository } from "../config/machine";
import type { Config } from "../config/schema";
import { platform } from "../runner/machine";
import {
  buildCapabilities,
  buildLimits,
  daemonRepositories,
} from "./capabilities";
import type { DaemonApi } from "./daemon-api";
import { EventSink } from "./event-sink";
import type {
  SessionExecutor,
  StopReason,
  TurnContext,
  TurnResult,
} from "./executor";
import type { DaemonLog } from "./log";
import { ServerLink } from "./server-link";
import type { LocalSession, StateDb } from "./state";

/** A turn running in a slot. */
export interface Slot {
  workItemId: number;
  agentSessionId: number;
  role: "manager" | "worker";
  agentId: string;
  issueIdentifier: string | null;
  state: ActiveItem["state"];
  controller: AbortController;
  reason: StopReason | null;
  /** Set when the server no longer considers the turn ours: write nothing more. */
  silent: boolean;
  startedAt: number;
  done: Promise<void>;
}

/** The outcome of a config reload. */
export interface ReloadResult {
  applied: string[];
  requiresRestart: string[];
  error?: string;
}

/** Why the daemon is exiting, and with what code. */
export interface ExitRequest {
  code: number;
  message: string;
}

/** Exit codes the daemon uses for conditions a restart will not fix. */
export const EXIT_CONFIG = 78;

/** The exit code that asks a service manager to restart the daemon (after an upgrade). */
export const EXIT_RESTART = 75;

/** Everything the supervisor needs. */
export interface SupervisorOptions {
  config: Config;
  configPath: string;
  state: StateDb;
  log: DaemonLog;
  api: DaemonApi;
  machine: MachineEnv;
  machineId: string;
  runner: { runnerId: number; projectId: number; name: string };
  executor: SessionExecutor;
  /** Re-read and validate the config file; null on failure (already logged). */
  readConfig: () => { config: Config | null; error?: string };
  /** Ask the process to exit. */
  requestExit: (exit: ExitRequest) => void;
  /** Open the wake-up socket (off in a few unit tests). */
  useSocket?: boolean;
}

/** The daemon's slots and the loop around them. */
export class Supervisor {
  config: Config;
  readonly sink: EventSink;
  readonly link: ServerLink;
  private readonly slots = new Map<number, Slot>();
  private readonly claiming = new Set<number>();
  /** Claims whose answer was lost: the server may hold them for us. */
  private readonly lostClaims = new Map<number, Offer>();
  private repositories: ResolvedRepository[] = [];
  private capabilities: HeartbeatRequest["capabilities"];
  private draining = false;
  private claimsHalted = false;
  private readonly startedAt = Date.now();

  /**
   * @param options - The daemon's parts.
   */
  constructor(private readonly options: SupervisorOptions) {
    this.config = options.config;
    this.repositories = daemonRepositories(this.config, options.machine);
    this.capabilities = buildCapabilities(
      this.config,
      options.machine,
      this.repositories,
    );
    this.sink = new EventSink(options.state, options.api, options.log, {
      onCancelRequested: (id) => this.stop(id, "stop"),
      onNotYours: (id) => this.silence(id),
      onUnauthorized: () => this.revoked(),
      onCompleted: () => this.link.beatNow(),
      onUnreachable: () => {},
    });
    this.link = new ServerLink(
      options.api,
      options.machineId,
      () => this.heartbeatBody(),
      options.log,
      {
        onBeat: (answer) => this.onBeat(answer),
        onRevoked: () => this.revoked(),
        onFatal: (message) => this.fatal(message),
        onProtocolUnsupported: (message) => this.protocolUnsupported(message),
        onHealthy: () => this.sink.kick(true),
      },
      options.useSocket ?? true,
    );
  }

  /** Start: report what a previous process left behind, then connect. */
  start(): LocalSession[] {
    const interrupted = this.options.state.interruptLive();
    for (const s of interrupted) {
      this.options.log.warn(
        "a turn was interrupted by the daemon stopping; the server re-offers it once its lease lapses",
        {
          session: s.agentSessionId,
          workItem: s.workItemId,
        },
      );
    }
    this.link.start();
    this.sink.kick(true);
    return interrupted;
  }

  /** The heartbeat this daemon would send now. */
  heartbeatBody(): HeartbeatRequest {
    return {
      protocolVersion: PROTOCOL_VERSION,
      daemonVersion: pkg.version,
      platform: platform(),
      hostname: hostname().trim().slice(0, 256) || "unknown",
      draining: this.draining || this.claimsHalted,
      machineId: this.options.machineId,
      limits: buildLimits(this.config),
      active: this.active(),
      capabilities: this.capabilities,
    };
  }

  /** The work items this daemon holds, as heartbeats report them. */
  active(): ActiveItem[] {
    const items: ActiveItem[] = [...this.slots.values()]
      .filter((slot) => !slot.silent)
      .map((slot) => ({
        workItemId: slot.workItemId,
        agentSessionId: slot.agentSessionId,
        role: slot.role,
        agentId: slot.agentId,
        state: slot.state,
      }));
    for (const waiting of this.sink.awaitingCompletion()) {
      if (!this.slots.has(waiting.workItemId)) items.push(waiting);
    }
    return items;
  }

  /** Whether the daemon is draining. */
  get isDraining(): boolean {
    return this.draining;
  }

  /** The turns running now. */
  running(): Slot[] {
    return [...this.slots.values()];
  }

  /**
   * Act on a heartbeat's answer: forget what is no longer ours, stop what was
   * cancelled, and claim what was offered while there is room.
   * @param answer - The heartbeat response.
   */
  private async onBeat(answer: HeartbeatResponse): Promise<void> {
    for (const id of answer.unknownActive) this.silence(id);
    for (const cancel of answer.cancels)
      this.stop(cancel.workItemId, cancel.reason as Cancel["reason"]);
    if (this.draining || this.claimsHalted) return;
    // A claim repeated for an item this runner already holds answers the same
    // assignment, so a claim whose answer was lost is retried, offered or not.
    const retries = [...this.lostClaims.values()];
    this.lostClaims.clear();
    for (const offer of [...retries, ...answer.offers]) {
      if (!this.canTake(offer)) continue;
      await this.claim(offer);
    }
  }

  /**
   * The agent this daemon runs a role with.
   * @param role - The role.
   * @returns The agent id, or null when this runner does not play it.
   */
  private agentFor(role: "manager" | "worker"): string | null {
    if (!this.config.runner.roles.includes(role)) return null;
    return this.config.roles[role]?.agent ?? null;
  }

  /**
   * Whether an offer fits: the machine, its role, and its agent have room,
   * and its session has no turn here.
   * @param offer - The offer.
   * @returns True to claim it.
   */
  canTake(
    offer: Pick<Offer, "workItemId" | "agentSessionId" | "role">,
  ): boolean {
    if (this.slots.has(offer.workItemId) || this.claiming.has(offer.workItemId))
      return false;
    const agent = this.agentFor(offer.role);
    if (!agent) return false;
    const busy = [...this.slots.values()];
    if (busy.some((slot) => slot.agentSessionId === offer.agentSessionId))
      return false;
    if (
      busy.length + this.claiming.size >=
      this.config.runner.max_parallel_jobs
    )
      return false;
    const roleCap = this.config.roles[offer.role]?.max_parallel;
    if (
      roleCap !== undefined &&
      busy.filter((s) => s.role === offer.role).length >= roleCap
    )
      return false;
    const agentCap = this.config.agents[agent]?.max_parallel;
    if (
      agentCap !== undefined &&
      busy.filter((s) => s.agentId === agent).length >= agentCap
    )
      return false;
    return true;
  }

  /**
   * Claim one offer and start its turn.
   * @param offer - The offer.
   */
  private async claim(offer: Offer): Promise<void> {
    this.claiming.add(offer.workItemId);
    let assignment: WorkAssignment | null;
    try {
      assignment = await this.options.api.claim([offer.workItemId]);
    } catch (error) {
      this.claiming.delete(offer.workItemId);
      if (error instanceof ApiError && error.status === 401)
        return this.revoked();
      if (
        !(error instanceof ApiError) ||
        error.status === 0 ||
        error.status >= 500
      ) {
        this.lostClaims.set(offer.workItemId, offer);
      }
      this.options.log.warn(
        `claiming work item ${offer.workItemId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    this.claiming.delete(offer.workItemId);
    if (!assignment) {
      this.options.log.debug("the offer was gone by the time it was claimed", {
        workItem: offer.workItemId,
      });
      return;
    }
    this.startTurn(assignment);
  }

  /**
   * Run a claimed turn in a slot.
   * @param assignment - What the server assigned.
   */
  private startTurn(assignment: WorkAssignment): void {
    const { state, log } = this.options;
    const agentId =
      assignment.agentId ?? this.agentFor(assignment.role) ?? "unknown";
    state.claimSession({
      agentSessionId: assignment.agentSessionId,
      linearSessionId: assignment.externalSessionId,
      issueIdentifier: assignment.issue.identifier,
      role: assignment.role,
      repository: assignment.repository?.remote ?? null,
      workItemId: assignment.workItemId,
      acpAgentId: agentId,
    });
    const slot: Slot = {
      workItemId: assignment.workItemId,
      agentSessionId: assignment.agentSessionId,
      role: assignment.role,
      agentId,
      issueIdentifier: assignment.issue.identifier,
      state: "starting",
      controller: new AbortController(),
      reason: null,
      silent: false,
      startedAt: Date.now(),
      done: Promise.resolve(),
    };
    this.slots.set(assignment.workItemId, slot);
    log.info(
      `claimed ${assignment.kind} for ${assignment.issue.identifier ?? "an issue"}`,
      {
        session: assignment.agentSessionId,
        workItem: assignment.workItemId,
        role: assignment.role,
        agent: agentId,
      },
    );
    const ctx: TurnContext = {
      assignment,
      config: this.config,
      runnerName: this.config.runner.name,
      signal: slot.controller.signal,
      stopReason: () => slot.reason,
      emit: (event) => {
        if (slot.silent) return;
        this.options.state.setSessionState(slot.agentSessionId, "running");
        if (slot.state === "starting") slot.state = "running";
        this.sink.emit(
          { agentSessionId: slot.agentSessionId, workItemId: slot.workItemId },
          event,
        );
      },
      log,
    };
    slot.done = this.runTurn(slot, ctx);
  }

  /**
   * Run the executor, then queue the completion and free the slot.
   * @param slot - The slot.
   * @param ctx - The turn.
   */
  private async runTurn(slot: Slot, ctx: TurnContext): Promise<void> {
    let result: TurnResult;
    try {
      result = await this.options.executor.run(ctx);
    } catch (error) {
      result = {
        outcome: "failed",
        error: error instanceof Error ? error.message : String(error),
      };
      this.options.log.error(`the turn failed: ${result.error}`, {
        session: slot.agentSessionId,
      });
    }
    this.slots.delete(slot.workItemId);
    if (slot.silent) {
      this.options.state.setSessionState(slot.agentSessionId, "interrupted", {
        pid: null,
      });
    } else {
      this.sink.complete({
        request: {
          workItemId: slot.workItemId,
          outcome: result.outcome,
          error: result.error ?? null,
          acpSessionId: result.acpSessionId ?? null,
          branch: result.branch ?? null,
        },
        active: {
          workItemId: slot.workItemId,
          agentSessionId: slot.agentSessionId,
          role: slot.role,
          agentId: slot.agentId,
          state: result.outcome === "cancelled" ? "cancelling" : "running",
        },
      });
      this.options.state.setSessionState(
        slot.agentSessionId,
        result.outcome === "completed"
          ? "idle"
          : result.outcome === "cancelled"
            ? "cancelled"
            : "failed",
        { pid: null, acpSessionId: result.acpSessionId ?? null },
      );
    }
    this.options.log.info(
      `turn ended: ${slot.silent ? "taken away" : result.outcome}`,
      {
        session: slot.agentSessionId,
        workItem: slot.workItemId,
      },
    );
    this.link.beatNow();
  }

  /**
   * Stop a running turn; it emits what a stopped turn owes and completes
   * `cancelled`.
   * @param workItemId - The work item.
   * @param reason - Why.
   * @returns Whether a turn was running.
   */
  stop(workItemId: number, reason: StopReason): boolean {
    const slot = this.slots.get(workItemId);
    if (!slot) return false;
    if (!slot.reason) {
      slot.reason = reason;
      slot.state = "cancelling";
      this.options.log.info(`stopping the turn (${reason})`, {
        session: slot.agentSessionId,
        workItem: workItemId,
      });
      slot.controller.abort(reason);
    }
    return true;
  }

  /**
   * Stop a turn the server no longer considers ours, writing nothing more for
   * it — someone else may own the session now.
   * @param workItemId - The work item.
   */
  silence(workItemId: number): void {
    this.options.state.dropWorkItem(workItemId);
    const slot = this.slots.get(workItemId);
    if (!slot) return;
    slot.silent = true;
    this.stop(workItemId, "superseded");
  }

  /**
   * `agents.kill`: stop the turns for a session id or issue identifier.
   * @param target - A session id, or an identifier like `ENG-123`.
   * @param reason - Logged with the stop.
   * @returns The work items stopped.
   */
  kill(target: string | number, reason?: string): number[] {
    const killed: number[] = [];
    for (const slot of this.slots.values()) {
      const matches =
        String(slot.agentSessionId) === String(target) ||
        (slot.issueIdentifier !== null &&
          slot.issueIdentifier.toLowerCase() === String(target).toLowerCase());
      if (matches && this.stop(slot.workItemId, "kill"))
        killed.push(slot.workItemId);
    }
    if (killed.length)
      this.options.log.info(`killed ${killed.length} turn(s)`, {
        target,
        reason,
      });
    return killed;
  }

  /**
   * Stop claiming, let running turns finish (or stop them), and flush.
   * @param options - How long to wait, and whether to stop turns at once.
   * @returns How many turns were stopped rather than finished.
   */
  async drain(options: {
    timeoutMs: number;
    cancel: boolean;
  }): Promise<{ drained: boolean; cancelled: number }> {
    this.draining = true;
    this.link.beatNow();
    let cancelled = 0;
    const stopAll = () => {
      // Count each turn once: a second pass finds it already stopping.
      for (const slot of this.slots.values())
        if (!slot.reason && this.stop(slot.workItemId, "drain")) cancelled++;
    };
    if (options.cancel) stopAll();
    if (!(await this.waitIdle(options.timeoutMs))) {
      stopAll();
      await this.waitIdle(this.config.sessions.stop_grace + 5_000);
    }
    const flushed = await this.sink.drain(5_000);
    this.link.beatNow();
    return { drained: this.slots.size === 0 && flushed, cancelled };
  }

  /**
   * Wait until no turn is running, bounded.
   * @param timeoutMs - The most to wait.
   * @returns Whether the slots emptied.
   */
  private async waitIdle(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.slots.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await Promise.race([
        Promise.all([...this.slots.values()].map((s) => s.done)),
        Bun.sleep(remaining),
      ]);
    }
    return true;
  }

  /**
   * Re-read the config and apply what is safe to apply now.
   * @returns What was applied, and what needs a restart.
   */
  reload(): ReloadResult {
    const { config: next, error } = this.options.readConfig();
    if (!next) {
      this.options.log.error(
        `reload refused; the running config stays: ${error ?? "invalid config"}`,
      );
      return {
        applied: [],
        requiresRestart: [],
        error: error ?? "invalid config",
      };
    }
    const previous = this.config;
    const applied: string[] = [];
    const requiresRestart: string[] = [];
    const merged: Config = structuredClone(next);

    for (const key of ["url", "project"] as const) {
      if (next.server[key] !== previous.server[key])
        requiresRestart.push(`server.${key}`);
    }
    merged.server = previous.server;

    const oldPaths = new Map(this.repositories.map((r) => [r.name, r.path]));
    merged.repositories = next.repositories.map((repo, index) => {
      const name = daemonRepositories(
        { ...next, repositories: [repo] },
        this.options.machine,
      )[0]?.name;
      const oldPath = name ? oldPaths.get(name) : undefined;
      if (oldPath && oldPath !== repo.path) {
        requiresRestart.push(`repositories[${index}].path`);
        return { ...repo, path: oldPath };
      }
      return repo;
    });

    const inUse = new Set(this.running().map((s) => s.agentId));
    for (const [id, agent] of Object.entries(next.agents)) {
      const before = previous.agents[id];
      if (
        before &&
        inUse.has(id) &&
        (JSON.stringify(before.command) !== JSON.stringify(agent.command) ||
          before.preset !== agent.preset)
      ) {
        requiresRestart.push(`agents.${id}.command`);
        merged.agents[id] = before;
      }
    }

    for (const key of changedKeys(previous, merged)) applied.push(key);
    this.config = merged;
    this.options.log.level = merged.log.level;
    this.repositories = daemonRepositories(merged, this.options.machine);
    this.capabilities = buildCapabilities(
      merged,
      this.options.machine,
      this.repositories,
    );
    this.options.log.info("config reloaded", {
      applied: applied.join(",") || "nothing",
      requiresRestart: requiresRestart.join(",") || undefined,
    });
    this.link.beatNow();
    return { applied, requiresRestart };
  }

  /** The runner was revoked: stop everything without writing, and exit. */
  private revoked(): void {
    if (this.claimsHalted) return;
    this.claimsHalted = true;
    this.link.stop();
    this.sink.close();
    for (const slot of this.slots.values()) {
      slot.silent = true;
      this.stop(slot.workItemId, "revoked");
    }
    this.options.requestExit({
      code: EXIT_CONFIG,
      message:
        'runner revoked on the server; run "hypotenuse runner register" to re-register',
    });
  }

  /**
   * Something a retry will not fix.
   * @param message - What.
   */
  private fatal(message: string): void {
    this.claimsHalted = true;
    this.options.requestExit({ code: EXIT_CONFIG, message });
  }

  /**
   * The server needs a newer daemon: finish what is held, claim nothing more.
   * @param message - The server's refusal.
   */
  private protocolUnsupported(message: string): void {
    if (!this.claimsHalted) {
      this.options.log.error(`${message}; run "hypotenuse upgrade"`);
    }
    this.claimsHalted = true;
  }

  /**
   * The control socket's `status`.
   * @param extra - The process facts the supervisor does not hold.
   * @returns The status object.
   */
  status(extra: { pid: number; configPath: string }) {
    const link = this.link.status();
    return {
      pid: extra.pid,
      version: pkg.version,
      uptimeMs: Date.now() - this.startedAt,
      configPath: extra.configPath,
      runner: {
        id: this.options.runner.runnerId,
        name: this.options.runner.name,
        projectId: this.options.runner.projectId,
      },
      server: {
        url: link.url,
        connected: link.connected,
        lastHeartbeatAt: link.lastHeartbeatAt,
        socket: link.socket,
        lastError: link.lastError,
        clockSkewMs: link.clockSkewMs,
      },
      slots: {
        total: this.config.runner.max_parallel_jobs,
        busy: this.slots.size,
      },
      pendingEvents: this.options.state.allPendingEvents().length,
      draining: this.draining,
    };
  }

  /**
   * The control socket's `agents.list`.
   * @param all - Include finished sessions.
   * @returns One row per session.
   */
  agents(all: boolean) {
    const rows = all
      ? this.options.state.sessions()
      : this.options.state.sessions([
          "claimed",
          "running",
          "idle",
          "interrupted",
        ]);
    return rows.map((s) => {
      const slot = [...this.slots.values()].find(
        (x) => x.agentSessionId === s.agentSessionId,
      );
      return {
        agentSessionId: s.agentSessionId,
        issueIdentifier: s.issueIdentifier,
        role: s.role,
        agent: s.acpAgentId,
        state: s.state,
        pid: s.pid,
        startedAt: slot?.startedAt ?? s.updatedAt,
        lastEventAt: s.lastEventAt,
        worktree: null as string | null,
      };
    });
  }

  /** Stop the link and the sink (the last steps of shutdown). */
  close(): void {
    this.link.stop();
    this.sink.close();
  }
}

/**
 * The dotted keys whose values differ between two configs.
 * @param a - One config.
 * @param b - The other.
 * @returns The changed leaf keys.
 */
export function changedKeys(a: unknown, b: unknown, prefix = ""): string[] {
  const isObject = (v: unknown) =>
    v !== null && typeof v === "object" && !Array.isArray(v);
  if (isObject(a) && isObject(b)) {
    const keys = new Set([
      ...Object.keys(a as object),
      ...Object.keys(b as object),
    ]);
    return [...keys].flatMap((key) =>
      changedKeys(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        prefix ? `${prefix}.${key}` : key,
      ),
    );
  }
  return JSON.stringify(a) === JSON.stringify(b) ? [] : [prefix];
}
