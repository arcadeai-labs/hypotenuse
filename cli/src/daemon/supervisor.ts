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
 *
 * It also owns the worktrees: a turn's workspace comes from the
 * {@link WorktreeManager}, a finished turn's worktree is offered to cleanup at
 * once, every worktree is swept every 30 minutes, and while the disk guard is
 * tripped the daemon claims nothing and heartbeats `draining`, so routing
 * sends the work elsewhere.
 */
import { hostname } from "node:os";
import { isAbsolute } from "node:path";
import {
  type ActiveItem,
  type HeartbeatRequest,
  type HeartbeatResponse,
  minLevel,
  type Offer,
  PROTOCOL_VERSION,
  type WorkAssignment,
} from "../../../protocol/src/index";
import pkg from "../../package.json";
import { agentForTurn } from "../acp/agent-choice";
import { ApiError } from "../api/client";
import type { MachineEnv, ResolvedRepository } from "../config/machine";
import { isPreset } from "../config/presets";
import type { Config } from "../config/schema";
import { platform } from "../runner/machine";
import { TurnTelemetry } from "../telemetry/collector";
import { TelemetryQueue } from "../telemetry/queue";
import { resolvedConfigSecrets } from "../telemetry/redact";
import {
  type CleanupOptions,
  type CleanupReport,
  SWEEP_INTERVAL_MS,
  WorktreeCleaner,
} from "../worktree/cleanup";
import { formatBytes, type StatFs } from "../worktree/disk";
import { listWorktrees, type WorktreeListing } from "../worktree/list";
import { KeyedMutex } from "../worktree/lock";
import { WorktreeManager } from "../worktree/manager";
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
  TurnReply,
  TurnResult,
} from "./executor";
import { type DaemonLog, preview } from "./log";
import { McpBroker } from "./mcp-broker";
import { selfCommand } from "./self";
import { ServerLink } from "./server-link";
import type { LocalSession, LocalWorktree, StateDb } from "./state";

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
  /** The turn's reader of a person's replies. */
  onReply: ((reply: TurnReply) => boolean | null) | null;
  /** Answer activity ids already handed to the turn. */
  delivered: Set<number>;
  /** Answer activity ids the turn took as answers. */
  consumed: number[];
  /** The type of the last event that answered the session this turn. */
  lastAnswer: string | null;
  /** What `agents kill --reason` said. */
  killNote: string | null;
  /** The turn's MCP nonce, while the broker serves it. */
  nonce: string | null;
  /** The turn's reader of `linear_ask_user` notices. */
  onAskingUser: ((asking: boolean) => void) | null;
  /** The turn's reader of pull requests linked by a tool. */
  onReportedPullRequest: ((url: string) => void) | null;
}

/** Events that answer a session. */
const ANSWER_TYPES = new Set(["response", "error", "elicitation"]);

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
  /** The state directory (session logs, working directories). */
  stateDir: string;
  /** The daemon's environment, which agents inherit. */
  env: Record<string, string | undefined>;
  /** Re-read and validate the config file; null on failure (already logged). */
  readConfig: () => { config: Config | null; error?: string };
  /** Ask the process to exit. */
  requestExit: (exit: ExitRequest) => void;
  /** Open the wake-up socket (off in a few unit tests). */
  useSocket?: boolean;
  /** `statfs`, for the disk guard (tests run out of disk with it). */
  statfs?: StatFs;
  /** How often every worktree is swept (default 30 minutes). */
  sweepIntervalMs?: number;
  /**
   * Secret values redacted from every turn's telemetry by value: the runner
   * token and any CLI token on this machine.
   */
  secrets?: string[];
  /**
   * The command that runs this program, for a turn's `hypotenuse mcp`
   * (default {@link selfCommand}); null to give turns no Hypotenuse tools.
   */
  mcpCommand?: string[] | null;
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
  /** What turns found out about their agents, over the config's view. */
  private readonly agentHealth = new Map<
    string,
    { available: boolean; error?: string }
  >();
  private readonly startedAt = Date.now();
  /** Creates and reuses where turns work. */
  readonly worktrees: WorktreeManager;
  /** Applies the cleanup policies and safety rules. */
  readonly cleaner: WorktreeCleaner;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private diskWasLow = false;
  /** Serves the turns' `hypotenuse mcp` servers over the control socket. */
  readonly broker: McpBroker;
  /** Every turn's telemetry, waiting for the relay. */
  readonly telemetryQueue: TelemetryQueue;
  /** What every turn's telemetry redacts by value (tokens, `$VAR` values). */
  private secrets: string[] = [];

  /**
   * @param options - The daemon's parts.
   */
  constructor(private readonly options: SupervisorOptions) {
    this.config = options.config;
    this.repositories = daemonRepositories(this.config, options.machine);
    this.capabilities = this.buildCapabilities();
    const mutex = new KeyedMutex();
    this.cleaner = new WorktreeCleaner(options.state, () => this.config, {
      mutex,
      inUse: (wt) => this.worktreeInUse(wt),
      repositories: () => this.repositories,
      log: (line) => options.log.info(line),
    });
    this.worktrees = new WorktreeManager(options.state, {
      mutex,
      statfs: options.statfs,
      env: options.env,
      freeSpace: async () => {
        await this.cleanup({});
      },
    });
    this.broker = new McpBroker(options.api, (line) => options.log.info(line));
    this.telemetryQueue = new TelemetryQueue(
      options.api,
      this.config.telemetry.buffer_mb * 1024 * 1024,
      (line) => options.log.info(line),
    );
    this.secrets = this.baseSecrets();
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
    // A worktree a previous process left `active` has no turn in it now.
    for (const wt of this.options.state.worktrees({ live: true })) {
      if (wt.state === "active")
        this.options.state.updateWorktree(wt.id, { state: "idle" });
    }
    this.link.start();
    this.sink.kick(true);
    this.telemetryQueue.start();
    this.sweepTimer = setInterval(
      () => void this.cleanup({}),
      this.options.sweepIntervalMs ?? SWEEP_INTERVAL_MS,
    );
    this.sweepTimer.unref?.();
    return interrupted;
  }

  /**
   * The values every turn's telemetry redacts: the credentials, and every
   * value the config resolves from the environment.
   * @returns The values.
   */
  private baseSecrets(): string[] {
    return [
      ...(this.options.secrets ?? []),
      ...resolvedConfigSecrets(this.config, this.options.env),
    ];
  }

  /**
   * A turn's telemetry, when the server asked for it and this runner's
   * owner allows it.
   * @param assignment - The turn.
   * @param agentId - Its agent.
   * @param slot - Its slot (for its MCP nonce).
   * @returns The turn's telemetry, or null.
   */
  private turnTelemetry(
    assignment: WorkAssignment,
    agentId: string,
    slot: Slot,
  ): TurnTelemetry | null {
    const claim = assignment.telemetry;
    if (!claim || !this.config.telemetry.enabled) return null;
    const preset =
      this.config.agents[agentId]?.preset ??
      (isPreset(agentId) ? agentId : null);
    const max = this.config.telemetry.max_content;
    const telemetry = new TurnTelemetry({
      // The server lowered the level to the cap it was told; a cap lowered
      // since is applied here too.
      claim: {
        ...claim,
        content: minLevel(claim.content, max),
        agentNative: claim.agentNative && this.config.telemetry.agent_native,
      },
      assignment,
      runner: { name: this.config.runner.name },
      agentId,
      preset,
      queue: this.telemetryQueue,
      secrets: () =>
        slot.nonce ? [...this.secrets, slot.nonce] : this.secrets,
    });
    telemetry.slots({
      capacity: this.config.runner.max_parallel_jobs,
      inUse: this.slots.size,
    });
    return telemetry;
  }

  /**
   * Whether a turn holds a worktree (cleanup's rule 1).
   * @param wt - The worktree.
   * @returns True when it is in use.
   */
  private worktreeInUse(wt: LocalWorktree): boolean {
    if (wt.state === "active") return true;
    return [...this.slots.values()].some(
      (slot) => slot.agentSessionId === wt.agentSessionId,
    );
  }

  /**
   * Run cleanup, logging rather than throwing.
   * @param options - What to clean up.
   * @returns The report, or null when it failed.
   */
  async cleanup(options: CleanupOptions): Promise<CleanupReport | null> {
    try {
      return await this.cleaner.run(options);
    } catch (error) {
      this.options.log.warn(
        `worktree cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  /**
   * The control socket's `worktrees.list`.
   * @returns One row per live worktree.
   */
  worktreesList(): Promise<WorktreeListing[]> {
    return listWorktrees(this.options.state, this.cleaner);
  }

  /**
   * Whether the disk guard is tripped: too little space for a new worktree.
   * Logged when it changes.
   * @returns True while space is short.
   */
  private diskLow(): boolean {
    const { free, enough } = this.worktrees.diskStatus(this.config);
    if (!enough !== this.diskWasLow) {
      this.diskWasLow = !enough;
      if (enough)
        this.options.log.info("disk space recovered; claiming work again");
      else
        this.options.log.warn(
          `only ${formatBytes(free ?? 0)} free under ${this.config.sessions.worktree_root} (sessions.min_free_disk is ${formatBytes(this.config.sessions.min_free_disk)}); claiming nothing until space recovers`,
        );
    }
    return !enough;
  }

  /**
   * The capabilities heartbeats report: the config's, with what turns found
   * out — an agent that would not start or is not logged in is unavailable
   * until a turn starts it again or the config is reloaded.
   * @returns The capabilities.
   */
  private buildCapabilities(): HeartbeatRequest["capabilities"] {
    const base = buildCapabilities(
      this.config,
      this.options.machine,
      this.repositories,
    );
    return {
      ...base,
      agents: base.agents.map((agent) => {
        const health = this.agentHealth.get(agent.id);
        if (!health || !agent.available) return agent;
        const { error: _error, ...rest } = agent;
        return health.available
          ? rest
          : { ...rest, available: false, error: health.error?.slice(0, 1024) };
      }),
    };
  }

  /**
   * Record what a turn found out about its agent.
   * @param agentId - The agent.
   * @param available - Whether it started and opened a session.
   * @param error - Why not.
   */
  private agentAvailability(
    agentId: string,
    available: boolean,
    error?: string,
  ): void {
    const before = this.agentHealth.get(agentId);
    if (before?.available === available && before.error === error) return;
    this.agentHealth.set(agentId, { available, error });
    this.capabilities = this.buildCapabilities();
    if (!available)
      this.options.log.warn(`agent ${agentId} is unavailable: ${error ?? ""}`);
    this.link.beatNow();
  }

  /** The heartbeat this daemon would send now. */
  heartbeatBody(): HeartbeatRequest {
    return {
      protocolVersion: PROTOCOL_VERSION,
      daemonVersion: pkg.version,
      platform: platform(),
      hostname: hostname().trim().slice(0, 256) || "unknown",
      draining: this.draining || this.claimsHalted || this.diskLow(),
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
    for (const cancel of answer.cancels) {
      const slot = this.slots.get(cancel.workItemId);
      // Who stopped it from the dashboard, or what the person typed with a
      // Linear stop, rides as the stop's note.
      const note = cancel.by ?? cancel.said;
      if (slot && !slot.reason && note) slot.killNote = note;
      this.stop(cancel.workItemId, cancel.reason as StopReason);
    }
    for (const reply of answer.answers ?? []) this.deliver(reply);
    if (this.draining || this.claimsHalted || this.diskWasLow) return;
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
   * Hand a person's reply to the turn waiting on it, once.
   * @param reply - The answer, from a heartbeat.
   */
  private deliver(reply: {
    workItemId: number;
    activityId: number;
    body: string;
  }): void {
    const slot = this.slots.get(reply.workItemId);
    if (!slot || slot.silent || slot.delivered.has(reply.activityId)) return;
    slot.delivered.add(reply.activityId);
    const taken = slot.onReply?.({
      activityId: reply.activityId,
      body: reply.body,
    });
    if (taken) slot.consumed.push(reply.activityId);
    const { log } = this.options;
    if (log.enabled("debug")) {
      log.debug(`reply: ${preview(reply.body, log.level)}`, {
        session: slot.agentSessionId,
        workItem: slot.workItemId,
        activity: reply.activityId,
      });
    }
    this.options.log.info(
      taken
        ? "a reply answered the turn's question"
        : "a reply did not answer the turn's question; it becomes the next prompt",
      { session: slot.agentSessionId, workItem: slot.workItemId },
    );
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
    const agentId = agentForTurn(
      {
        ...assignment,
        agentId: assignment.agentId ?? this.agentFor(assignment.role),
      },
      this.config,
    ).agentId;
    const local = state.session(assignment.agentSessionId);
    const previousAcpSessionId = local?.acpSessionId ?? null;
    const previousAcpCostUsd = local?.acpCostUsd ?? null;
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
      onReply: null,
      delivered: new Set(),
      consumed: [],
      lastAnswer: null,
      killNote: null,
      nonce: null,
      onAskingUser: null,
      onReportedPullRequest: null,
    };
    this.slots.set(assignment.workItemId, slot);
    const mcpCommand =
      this.options.mcpCommand === undefined
        ? selfCommand()
        : this.options.mcpCommand;
    const telemetry = this.turnTelemetry(assignment, agentId, slot);
    if (telemetry)
      this.sink.trace(assignment.workItemId, telemetry.traceparentFor());
    if (mcpCommand) {
      slot.nonce = this.broker.register({
        agentSessionId: assignment.agentSessionId,
        workItemId: assignment.workItemId,
        role: assignment.role,
        issueIdentifier: assignment.issue.identifier,
        askingUser: (asking) => slot.onAskingUser?.(asking),
        settle: async () => {
          await this.sink.settled(slot.workItemId);
        },
        reportedPullRequest: (url) => {
          this.options.state.addPullRequest(slot.agentSessionId, url);
          slot.onReportedPullRequest?.(url);
        },
        trace: telemetry
          ? (tool, input) => {
              const span = telemetry
                .span(
                  "mcp.call",
                  {
                    "gen_ai.operation.name": "execute_tool",
                    "gen_ai.tool.name": tool,
                    "hypotenuse.mcp.server": "hypotenuse",
                  },
                  telemetry.promptSpan,
                  "client",
                )
                .content("mcp.arguments", JSON.stringify(input));
              return {
                traceparent: span.traceparent,
                end: (result) => {
                  if (result.isError) span.fail(result.text.slice(0, 500));
                  span.content("mcp.result", result.text).end({
                    "hypotenuse.mcp.cached": result.cached,
                    "hypotenuse.mcp.result.bytes": Buffer.byteLength(
                      result.text,
                    ),
                  });
                },
              };
            }
          : undefined,
      });
    }
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
        if (ANSWER_TYPES.has(event.type)) slot.lastAnswer = event.type;
        this.options.state.setSessionState(slot.agentSessionId, "running");
        if (slot.state === "starting") slot.state = "running";
        this.sink.emit(
          { agentSessionId: slot.agentSessionId, workItemId: slot.workItemId },
          event,
        );
      },
      log,
      stateDir: this.options.stateDir,
      env: this.options.env,
      previousAcpSessionId,
      previousAcpCostUsd,
      onReply: (handler) => {
        slot.onReply = handler;
      },
      setPid: (pid) =>
        this.options.state.setSessionState(
          slot.agentSessionId,
          this.options.state.session(slot.agentSessionId)?.state ?? "running",
          { pid },
        ),
      agentAvailability: (available, error) =>
        this.agentAvailability(agentId, available, error),
      setState: (next) => {
        if (slot.state !== "cancelling") slot.state = next;
      },
      prepareWorkspace: (io) =>
        this.worktrees.acquire({
          assignment,
          config: ctx.config,
          repositories: this.repositories,
          runnerName: ctx.runnerName,
          env: io.env,
          emit: ctx.emit,
          output: io.output,
          signal: slot.controller.signal,
        }),
      pullRequests:
        this.options.state.session(assignment.agentSessionId)?.pullRequests ??
        [],
      recordPullRequest: (url) =>
        this.options.state.addPullRequest(slot.agentSessionId, url),
      stopNote: () => slot.killNote,
      hypotenuseMcp:
        mcpCommand && slot.nonce
          ? {
              command: resolveCommand(
                mcpCommand[0] as string,
                this.options.env,
              ),
              args: [
                ...mcpCommand.slice(1),
                "mcp",
                "--session",
                String(assignment.agentSessionId),
                "--nonce",
                slot.nonce,
              ],
              env: { HYPOTENUSE_STATE_DIR: this.options.stateDir },
            }
          : null,
      onAskingUser: (handler) => {
        slot.onAskingUser = handler;
      },
      onReportedPullRequest: (handler) => {
        slot.onReportedPullRequest = handler;
      },
      telemetry,
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
    if (slot.nonce) this.broker.end(slot.nonce);
    const acp = acpSessionAfterTurn(
      result,
      slot.silent,
      this.options.state.session(slot.agentSessionId)?.acpSessionId ?? null,
    );
    if (slot.silent) {
      this.options.state.setSessionState(slot.agentSessionId, "interrupted", {
        pid: null,
        ...acp,
      });
    } else {
      this.sink.complete({
        request: {
          workItemId: slot.workItemId,
          outcome: result.outcome,
          error: result.error ?? null,
          acpSessionId: result.acpSessionId ?? null,
          branch: result.branch ?? null,
          ...(result.usage ? { usage: result.usage } : {}),
          ...(slot.consumed.length
            ? { answersConsumed: slot.consumed.slice(0, 100) }
            : {}),
        },
        active: {
          workItemId: slot.workItemId,
          agentSessionId: slot.agentSessionId,
          role: slot.role,
          agentId: slot.agentId,
          state: result.outcome === "cancelled" ? "cancelling" : "running",
        },
      });
      this.options.state.recordTurnEnd(slot.agentSessionId, slot.lastAnswer);
      this.options.state.setSessionState(
        slot.agentSessionId,
        result.outcome === "completed"
          ? "idle"
          : result.outcome === "cancelled"
            ? "cancelled"
            : "failed",
        { pid: null, ...acp },
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
    // The worktree this turn used may be done with (`on-complete` with no
    // grace); the half-hourly sweep catches everything else.
    const worktreeId = this.options.state.session(
      slot.agentSessionId,
    )?.worktreeId;
    const telemetry = ctx.telemetry ?? null;
    if (worktreeId) {
      const span = telemetry?.span("worktree.cleanup", {
        "hypotenuse.worktree.id": worktreeId,
      });
      const report = await this.cleanup({ only: [worktreeId] });
      span?.end({
        "hypotenuse.worktree.removed": (report?.removed.length ?? 0) > 0,
        "hypotenuse.worktree.kept": (report?.kept.length ?? 0) > 0,
      });
    }
    telemetry?.finish(
      slot.silent ? "taken_away" : result.outcome,
      result.error,
    );
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
      if (!matches) continue;
      if (!slot.reason && reason) slot.killNote = reason;
      if (this.stop(slot.workItemId, "kill")) killed.push(slot.workItemId);
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
    await this.telemetryQueue.drain(5_000);
    this.link.beatNow();
    return { drained: this.slots.size === 0 && flushed, cancelled };
  }

  /**
   * Stop claiming new turns, without stopping running ones — what a restart
   * waiting for turns to finish does. {@link resumeClaims} undoes it.
   */
  pauseClaims(): void {
    this.draining = true;
    this.link.beatNow();
  }

  /** Claim again after {@link pauseClaims}: the restart was called off. */
  resumeClaims(): void {
    this.draining = false;
    this.link.beatNow();
  }

  /**
   * Wait until no turn is running, bounded.
   * @param timeoutMs - The most to wait.
   * @returns Whether the slots emptied.
   */
  async waitIdle(timeoutMs: number): Promise<boolean> {
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
    // What turns learned about agents is forgotten: a reload is how a person
    // says "I fixed it" (`agents login` sends one), and an agent marked
    // unavailable is offered no turn that could find out otherwise.
    if (this.agentHealth.size) {
      applied.push("agents.availability");
      this.agentHealth.clear();
    }
    this.config = merged;
    this.options.log.level = merged.log.level;
    this.telemetryQueue.capacityBytes =
      merged.telemetry.buffer_mb * 1024 * 1024;
    this.secrets = this.baseSecrets();
    this.repositories = daemonRepositories(merged, this.options.machine);
    this.capabilities = this.buildCapabilities();
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
    const worktreePath = (id: number | null) => {
      const wt = id ? this.options.state.worktree(id) : null;
      return wt && wt.state !== "removed" ? wt.path : null;
    };
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
        worktree: worktreePath(s.worktreeId),
      };
    });
  }

  /** Stop the link and the sink (the last steps of shutdown). */
  close(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    this.link.stop();
    this.sink.close();
    this.telemetryQueue.stop();
  }
}

/**
 * What a turn's end records about its ACP session, for the next turn to
 * resume and to measure its cost from:
 *
 * | Turn | Recorded |
 * |---|---|
 * | ended, with an ACP session | that session, and its cost so far |
 * | ended, without one | nothing: the last session can still be resumed |
 * | taken away, on the session already recorded | its cost so far, since the server recorded the lost claim's spend and the next resume must not count it again |
 * | taken away, on another session or none | nothing |
 * @param result - How the turn ended.
 * @param silent - Whether it was taken away (a lapsed lease, revocation, `NOT_YOUR_WORK`).
 * @param recordedAcpSessionId - The ACP session already recorded for the session.
 * @returns The columns for `setSessionState`.
 */
export function acpSessionAfterTurn(
  result: TurnResult,
  silent: boolean,
  recordedAcpSessionId: string | null,
): { acpSessionId?: string; acpCostUsd?: number | null } {
  if (!result.acpSessionId) return {};
  if (!silent) {
    return {
      acpSessionId: result.acpSessionId,
      acpCostUsd: result.acpCostUsd ?? null,
    };
  }
  return result.acpSessionId === recordedAcpSessionId
    ? { acpCostUsd: result.acpCostUsd ?? null }
    : {};
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

/**
 * An absolute path for a command, as ACP requires of a stdio MCP server.
 * @param command - The command, absolute already or found on `PATH`.
 * @param env - The daemon's environment.
 * @returns The absolute path, or the command as given when not found.
 */
function resolveCommand(
  command: string,
  env: Record<string, string | undefined>,
): string {
  if (isAbsolute(command)) return command;
  return Bun.which(command, { PATH: env.PATH ?? "" }) ?? command;
}
