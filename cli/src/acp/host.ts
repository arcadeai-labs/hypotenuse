/**
 * The ACP agent host: the `SessionExecutor` the daemon's slots run. One turn
 * is one agent process:
 *
 * 1. **Spawn** the role's agent in its own process group, its stderr and a
 *    JSON-RPC trace going to the session log, after an ephemeral "Starting…"
 *    thought so the session visibly moves however slow the start is.
 * 2. **`initialize`** within the agent's `startup_timeout`.
 * 3. **Choose the session**: `session/resume` (no replay) or `session/load`
 *    (replay discarded) for a follow-up on this runner, else `session/new`.
 *    `auth_required` calls `authenticate` once with an agent-run method; an
 *    agent that only offers terminal logins fails the turn with the command
 *    that fixes it, and is reported unavailable until a handshake succeeds.
 * 4. **Prompt** with `buildPrompt`, mapping every update to events as it
 *    arrives, flushing thoughts on a timer, and keeping the session out of
 *    Linear's stale state with "Still working" thoughts.
 * 5. **Answer** the agent's permission requests and elicitations by policy, or
 *    by asking the person and waiting — the turn timer paused, the idle timer
 *    running.
 * 6. **End** from the stop reason, or on **one cancel path** for every reason a
 *    turn stops early: `session/cancel`, every open question answered
 *    `cancelled`, `stop_grace` for the agent to wind down, then SIGTERM and
 *    SIGKILL to its process group, then the final activity for the reason.
 *
 * Before any of it, the turn's **workspace** is prepared — the session's
 * worktree (fetched, created, and set up, or reused by a follow-up), a
 * person's checkout, or a scratch directory — and handed back at the end.
 * A harness without a worktree manager works in `<state dir>/workspaces/<id>`.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json";
import { isRemoteSource, tildify } from "../config/paths";
import { repositoryName } from "../config/resolve";
import type { RoleConfig } from "../config/schema";
import type { EventInput } from "../daemon/event-sink";
import type {
  SessionExecutor,
  StopReason,
  TurnContext,
  TurnResult,
} from "../daemon/executor";
import { preview } from "../daemon/log";
import { AcpTelemetry } from "../telemetry/acp";
import { dropInheritedOtel, nativeTelemetryLaunch } from "../telemetry/native";
import { NativeReceiver } from "../telemetry/receiver";
import {
  coAuthorEnvironment,
  installCoAuthorHooks,
} from "../worktree/co-author";
import { type Workspace, WorkspaceError } from "../worktree/manager";
import { agentForTurn } from "./agent-choice";
import {
  AcpConnection,
  AcpError,
  type AgentCapabilities,
  type AuthMethod,
  errorMessage,
  type InitializeResponse,
  isAuthRequired,
  type McpServer,
  type NewSessionResponse,
  RESOURCE_REFUSED,
  type SessionConfigOption,
} from "./connection";
import {
  elicitationQuestion,
  permissionQuestion,
  QuestionQueue,
} from "./elicitation";
import { ConfinedFs, OutsideWorktree } from "./fs";
import {
  changedFiles,
  quoteTail,
  SessionLog,
  sessionLogPath,
  stopActivity,
} from "./lifecycle";
import { type MapperOptions, responseSignature, TurnMapper } from "./mapping";
import { turnMcpServers, UnsetVariableError } from "./mcp-servers";
import {
  automaticOption,
  decide,
  isReadOnly,
  READ_ONLY_MESSAGE,
} from "./permissions";
import { PrDetector } from "./pr-detect";
import {
  type AuthNeed,
  type CommandRunner,
  checkRepositoryAuth,
  isGitAuthFailure,
  providerSlug,
  remoteProvider,
} from "./preflight";
import {
  resolveAgentLaunch,
  sessionEnvironment,
  sessionVariables,
} from "./presets";
import { buildPrompt, type RoleDoc } from "./prompt";

/** Consecutive non-ACP stdout lines that fail a turn. */
export const NOISE_LIMIT = 3;

/** How long after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 5_000;

/** How often the turn's timers are checked. */
export const TICK_MS = 1_000;

/** Why a turn ended early, inside the host. */
type EndReason = StopReason | "timeout" | "idle" | "noise";

/** A failure that ends the turn with an `error`. */
class TurnFailure extends Error {
  /**
   * @param body - The error activity's body.
   * @param unavailable - Mark the agent unavailable with this reason.
   */
  constructor(
    readonly body: string,
    readonly unavailable?: string,
  ) {
    super(body);
  }
}

/**
 * A login the turn needs and lacks: the turn ends on an `auth` elicitation
 * naming the provider, and resumes when the person replies.
 */
class AuthRequired extends Error {
  /**
   * @param need - The provider and what the person reads.
   * @param unavailable - Mark the agent unavailable with this reason.
   */
  constructor(
    readonly need: AuthNeed,
    readonly unavailable?: string,
  ) {
    super(need.body);
  }
}

/** What a turn says when it starts again after an `auth` elicitation. */
export const SIGNED_IN_BODY = "Signed in — continuing.";

/** Options for the host (tests shorten its timers). */
export interface HostOptions {
  /** The timer tick. */
  tickMs?: number;
  /** SIGTERM to SIGKILL. */
  killGraceMs?: number;
  /** The clock. */
  now?: () => number;
  /** How preflight checks run commands. */
  run?: CommandRunner;
}

/**
 * Whether a turn starts again after the session's last word was an `auth`
 * elicitation — the person replied, so the login is presumably done.
 * @param assignment - The turn.
 * @returns True when the last outbound activity asked for a login.
 */
export function resumesAfterAuth(assignment: {
  history?: { direction: string; type: string; signal: string | null }[];
}): boolean {
  const last = (assignment.history ?? [])
    .filter((h) => h.direction === "outbound")
    .at(-1);
  return last?.type === "elicitation" && last.signal === "auth";
}

/** The daemon's executor. */
export class AcpSessionExecutor implements SessionExecutor {
  /**
   * @param options - Timer overrides.
   */
  constructor(private readonly options: HostOptions = {}) {}

  /**
   * Run one turn.
   * @param ctx - The turn.
   * @returns How it ended.
   */
  run(ctx: TurnContext): Promise<TurnResult> {
    return new Turn(ctx, this.options).run();
  }
}

/**
 * Resolve when a promise settles or a timer fires, whichever is first.
 * @param promise - The promise.
 * @param ms - The timeout.
 * @param onTimeout - The value on timeout.
 * @returns The result.
 */
async function within<T, U>(
  promise: Promise<T>,
  ms: number,
  onTimeout: U,
): Promise<T | U> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<U>((resolve) => {
        timer = setTimeout(() => resolve(onTimeout), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** One turn, from spawn to final activity. */
class Turn {
  private readonly now: () => number;
  private readonly role: RoleConfig | undefined;
  private readonly agentId: string;
  private cwd: string;
  private branch: string | null = null;
  private workspace: Workspace | null = null;
  private readonly log: SessionLog;
  private readonly mapperOptions: MapperOptions;
  private readonly mapper: TurnMapper;
  private readonly questions: QuestionQueue;
  private conn: AcpConnection | null = null;
  private acpSessionId: string | null = null;
  private agentTitle: string;
  /** The agent's version, as `initialize` reported it. */
  private agentVersion: string | null = null;
  private endReason: EndReason | null = null;
  private ended!: Promise<EndReason>;
  private endNow!: (reason: EndReason) => void;
  private lastTraffic: number;
  private lastEmit: number;
  private waitingSince: number | null = null;
  private pausedMs = 0;
  private promptStartedAt: number | null = null;
  private noiseInARow = 0;
  private noiseFailure: string | null = null;
  private fs: ConfinedFs;
  private where: string;
  private readonly readOnly: boolean;
  private readonly agentNote: string | null;
  /** The turn's ACP telemetry (a no-op without any). */
  private readonly otel: AcpTelemetry;
  /** The loopback receiver of the agent's own telemetry, while it runs. */
  private receiver: NativeReceiver | null = null;

  /**
   * @param ctx - The turn.
   * @param options - Timer overrides.
   */
  constructor(
    private readonly ctx: TurnContext,
    private readonly options: HostOptions,
  ) {
    this.now = options.now ?? Date.now;
    const assignment = ctx.assignment;
    this.role = ctx.config.roles[assignment.role];
    const chosen = agentForTurn(assignment, ctx.config);
    this.agentId = chosen.agentId;
    this.agentNote = chosen.note;
    this.readOnly = isReadOnly(this.role?.permission_policy ?? "allow");
    this.agentTitle = this.agentId;
    this.cwd = join(
      ctx.stateDir,
      "workspaces",
      String(assignment.agentSessionId),
    );
    this.log = new SessionLog(
      sessionLogPath(ctx.stateDir, assignment.agentSessionId),
      ctx.config.log.level === "trace",
    );
    this.mapperOptions = {
      cwd: this.cwd,
      now: this.now,
      onUnknown: (kind) =>
        ctx.log.debug(`ignoring an unknown session update kind: ${kind}`, {
          session: assignment.agentSessionId,
        }),
      onPullRequest: (url) => {
        this.log.note(`pull request ${url}`);
        ctx.recordPullRequest?.(url);
      },
    };
    this.mapper = new TurnMapper(this.mapperOptions);
    this.otel = new AcpTelemetry(ctx.telemetry ?? null, this.cwd);
    this.questions = new QuestionQueue({
      post: (event) => this.emit(event),
      waiting: (waiting) => {
        if (waiting) {
          this.waitingSince = this.now();
          this.emit({ type: "status", state: "waiting_permission" });
        } else {
          if (this.waitingSince !== null)
            this.pausedMs += this.now() - this.waitingSince;
          this.waitingSince = null;
          this.lastTraffic = this.now();
          this.emit({ type: "status", state: "running" });
        }
      },
    });
    this.fs = new ConfinedFs([
      this.cwd,
      ...(this.role?.additional_directories ?? []),
    ]);
    const repo = assignment.repository;
    this.where = repo ? `\`${repo.remote}\`` : "its working directory";
    this.lastTraffic = this.now();
    this.lastEmit = this.now();
    this.ended = new Promise((resolve) => {
      this.endNow = (reason) => {
        if (this.endReason) return;
        this.endReason = reason;
        resolve(reason);
      };
    });
  }

  /**
   * Report an event.
   * @param event - The event.
   */
  private emit(event: EventInput): void {
    this.lastEmit = this.now();
    this.ctx.emit(event);
  }

  /**
   * Report several events.
   * @param events - The events.
   */
  private emitAll(events: EventInput[]): void {
    for (const event of events) this.emit(event);
  }

  /**
   * The whole turn.
   * @returns How it ended.
   */
  async run(): Promise<TurnResult> {
    const { ctx } = this;
    ctx.signal.addEventListener("abort", () =>
      this.endNow(ctx.stopReason() ?? "stop"),
    );
    if (ctx.signal.aborted) this.endNow(ctx.stopReason() ?? "stop");
    ctx.onReply((reply) => {
      this.log.note(`reply ${reply.activityId}`);
      return this.questions.deliver(reply);
    });
    ctx.onAskingUser?.((asking) => {
      // What the agent thought before asking goes first; nothing after the
      // question reaches Linear, which would move the session out of
      // awaitingInput.
      if (asking) this.emitAll(this.mapper.flushThought(true));
      this.mapper.askedUser = asking;
      this.log.note(
        asking ? "asked the person (linear_ask_user)" : "asking failed",
      );
    });
    ctx.onReportedPullRequest?.((url) => {
      this.mapperOptions.pullRequests?.remember(url);
      this.log.note(`pull request ${url} (linear_report_pr)`);
    });

    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      if (this.agentNote)
        this.emit({ type: "thought", body: this.agentNote, ephemeral: false });
      this.emit({
        type: "thought",
        body: `Starting ${this.agentId} in ${this.where}…`,
        ephemeral: true,
      });
      await this.prepare();
      await this.start();
      // Linear's docs: resume after an auth signal with a thought, which also
      // dismisses the login prompt.
      if (resumesAfterAuth(ctx.assignment))
        this.emit({ type: "thought", body: SIGNED_IN_BODY, ephemeral: false });
      timer = setInterval(() => this.tick(), this.options.tickMs ?? TICK_MS);
      return await this.prompt();
    } catch (error) {
      if (error instanceof AuthRequired && !this.endReason) {
        if (error.unavailable) ctx.agentAvailability(false, error.unavailable);
        this.log.note(`needs a login: ${error.need.provider}`);
        this.emitAll(this.mapper.flushThought(false));
        // A question ends the turn; nothing may follow it in Linear.
        this.emit({
          type: "elicitation",
          body: error.need.body,
          signal: "auth",
          signalMetadata: {
            provider: error.need.provider,
            providerName: error.need.providerName.slice(0, 255),
          },
        });
        this.mapper.askedUser = true;
        return this.result("completed");
      }
      if (error instanceof AuthRequired) return await this.stopped();
      if (error instanceof TurnFailure) {
        if (error.unavailable) ctx.agentAvailability(false, error.unavailable);
        this.log.note(`failed: ${error.body}`);
        if (!this.endReason) {
          this.emitAll(this.mapper.flushThought(false));
          // After a question, an error would hide it: the session log has it.
          if (!this.mapper.askedUser)
            this.emit({ type: "error", body: error.body });
          return this.result("failed", error.body);
        }
        // Awaited: `finally` closes the agent, and must not run first.
        return await this.stopped();
      }
      if (this.endReason) return await this.stopped();
      throw error;
    } finally {
      clearInterval(timer);
      this.otel.promptEnded(
        { "hypotenuse.end_reason": this.endReason },
        this.endReason && this.endReason !== "stop" ? this.endReason : null,
      );
      await this.shutdown();
      await this.workspace?.release().catch((error: unknown) =>
        ctx.log.warn(`releasing the workspace failed: ${errorMessage(error)}`, {
          session: ctx.assignment.agentSessionId,
        }),
      );
    }
  }

  /**
   * Prepare where the turn works, and point everything that reads paths at
   * it: the mapper, the file-system confinement, and pull request detection.
   * @throws {TurnFailure} When the workspace cannot be prepared.
   */
  private async prepare(): Promise<void> {
    const { ctx } = this;
    const { assignment } = ctx;
    if (ctx.prepareWorkspace) {
      const prepare = ctx.prepareWorkspace;
      try {
        this.workspace = await this.otel.around(
          "worktree.prepare",
          {
            "hypotenuse.repository": assignment.repository?.remote ?? null,
            "hypotenuse.work_item.fresh": assignment.fresh,
          },
          async (span) => {
            const workspace = await prepare({
              output: (line) => {
                this.log.note(line);
                this.otel.turn?.log({
                  body: line,
                  eventName: "worktree.output",
                  span,
                });
              },
              env: (branch) =>
                sessionEnvironment(
                  ctx.env,
                  sessionVariables(assignment, branch),
                ),
            });
            span?.set({
              "hypotenuse.worktree.mode": workspace.mode,
              "vcs.ref.head.name": workspace.branch,
            });
            return workspace;
          },
        );
      } catch (error) {
        const remote = ctx.assignment.repository?.remote ?? null;
        if (
          error instanceof WorkspaceError &&
          remote &&
          isGitAuthFailure(error.body)
        ) {
          const provider = remoteProvider(remote);
          throw new AuthRequired({
            ...provider,
            body: `Runner ${ctx.runnerName} can't sign in to ${provider.providerName} to fetch \`${remote}\`. Its owner can fix it on that machine — the link says how. Reply here once it's done and I'll carry on.`,
          });
        }
        if (error instanceof WorkspaceError) throw new TurnFailure(error.body);
        throw error;
      }
      this.cwd = this.workspace.cwd;
      this.branch = this.workspace.branch;
    } else {
      mkdirSync(this.cwd, { recursive: true, mode: 0o700 });
    }
    if (this.endReason) throw new TurnFailure("stopped");
    const need = await checkRepositoryAuth(
      {
        remote: this.workspace?.repository?.remote ?? null,
        cwd: this.cwd,
        env: ctx.env,
        runnerName: ctx.runnerName,
        pullRequests: (assignment.role ?? "worker") === "worker",
      },
      this.options.run,
    );
    if (need) throw new AuthRequired(need);
    if (this.endReason) throw new TurnFailure("stopped");
    this.mapperOptions.cwd = this.cwd;
    this.otel.cwd = this.cwd;
    const remote = this.workspace?.repository?.remote ?? null;
    if (remote) {
      this.mapperOptions.pullRequests = new PrDetector(
        remote,
        this.workspace?.repositoryConfig?.pr_url_patterns ?? [],
        ctx.pullRequests ?? [],
      );
    }
    this.fs = new ConfinedFs([
      this.cwd,
      ...(this.role?.additional_directories ?? []),
    ]);
  }

  /**
   * A result.
   * @param outcome - The outcome.
   * @param error - The error text, if failed.
   * @returns The turn result.
   */
  private result(outcome: TurnResult["outcome"], error?: string): TurnResult {
    return {
      outcome,
      error: error ? error.slice(0, 4000) : null,
      acpSessionId: this.acpSessionId,
      branch: this.branch,
    };
  }

  /**
   * Spawn, initialize, and open the ACP session.
   * @throws {TurnFailure} When the agent cannot be started or used.
   */
  private async start(): Promise<void> {
    const { ctx } = this;
    const { assignment } = ctx;
    const launch = resolveAgentLaunch(
      ctx.config,
      this.agentId,
      ctx.env,
      sessionVariables(assignment, this.branch),
    );
    if (!launch) {
      throw new TurnFailure(
        `Runner ${ctx.runnerName} has no agent \`${this.agentId}\` configured for the ${assignment.role} role.`,
      );
    }
    const coAuthor = ctx.config.sessions.co_author.trim();
    if (coAuthor && this.workspace?.repository) {
      Object.assign(
        launch.env,
        coAuthorEnvironment(
          launch.env,
          installCoAuthorHooks(ctx.stateDir),
          coAuthor,
        ),
      );
    }
    this.withTelemetry(launch);
    this.log.note(`spawn ${launch.command.join(" ")} in ${this.cwd}`);
    try {
      this.conn = AcpConnection.spawn({
        command: launch.command,
        cwd: this.cwd,
        env: launch.env,
        stderr: (line) => {
          this.log.stderr(line);
          this.otel.stderr(line);
        },
        noise: (line) => this.noise(line),
        trace: (line, message) => {
          if (line.startsWith("<-")) {
            this.lastTraffic = this.now();
            this.noiseInARow = 0;
          }
          this.log.rpc(line, message);
          this.otel.frame(line, message);
        },
        handlers: {
          update: (n) => {
            if (this.acpSessionId && n.sessionId !== this.acpSessionId) return;
            this.otel.update(n.update);
            this.emitAll(this.mapper.update(n.update));
          },
          requestPermission: (params) => this.permission(params),
          readTextFile: async (params) => {
            const done = this.otel.fs("read", params.path);
            try {
              const content = this.fs.read(
                params.path,
                params.line,
                params.limit,
              );
              done({ bytes: Buffer.byteLength(content) });
              return { content };
            } catch (error) {
              done({ refused: errorMessage(error) });
              throw this.fsError(error);
            }
          },
          writeTextFile: async (params) => {
            const done = this.otel.fs("write", params.path);
            if (this.readOnly) {
              this.log.note(`refused a write (read-only): ${params.path}`);
              done({ refused: "read-only" });
              throw new AcpError(RESOURCE_REFUSED, READ_ONLY_MESSAGE, {
                path: params.path,
              });
            }
            try {
              this.fs.write(params.path, params.content);
              done({ bytes: Buffer.byteLength(params.content) });
            } catch (error) {
              done({ refused: errorMessage(error) });
              throw this.fsError(error);
            }
          },
          createElicitation: (params) =>
            this.otel.around("elicitation.wait", {}, () =>
              this.questions.ask(
                elicitationQuestion(
                  params,
                  this.agentTitle,
                  providerSlug(this.agentId),
                ),
              ),
            ),
          unknown: (method) => this.log.note(`unhandled ${method}`),
        },
      });
    } catch (error) {
      const message = `Could not start ${this.agentId} (\`${launch.command.join(" ")}\`): ${errorMessage(error)}`;
      throw new TurnFailure(message, `could not start: ${errorMessage(error)}`);
    }
    const conn = this.conn;
    ctx.setPid(conn.pid);
    ctx.setState("starting");
    this.otel.spawned(
      {
        "process.pid": conn.pid,
        "hypotenuse.agent.id": this.agentId,
        "hypotenuse.agent.preset": launch.preset ?? "custom",
        "hypotenuse.telemetry.native": this.receiver !== null,
      },
      launch.command.join(" "),
    );

    const init = await this.otel.around(
      "acp.initialize",
      { "rpc.method": "initialize" },
      () =>
        this.guard(
          conn.initialize(pkg.version),
          launch.startupTimeoutMs,
          `${this.agentId} did not answer initialize within ${launch.startupTimeoutMs / 1000}s (\`${launch.command.join(" ")}\`).`,
          true,
        ),
    );
    this.otel.initialized({
      "gen_ai.agent.name": init.agentInfo?.name ?? this.agentId,
      "hypotenuse.agent.version": init.agentInfo?.version ?? null,
      "hypotenuse.acp.protocol_version": init.protocolVersion,
      "hypotenuse.acp.load_session": Boolean(
        init.agentCapabilities?.loadSession,
      ),
      "hypotenuse.acp.auth_methods": (init.authMethods ?? []).length,
    });
    this.agentTitle =
      init.agentInfo?.title ?? init.agentInfo?.name ?? this.agentId;
    this.agentVersion = init.agentInfo?.version ?? null;
    ctx.log.debug(
      `${this.agentId} initialized: ${init.agentInfo?.name ?? "?"} ${init.agentInfo?.version ?? ""}`,
      { session: assignment.agentSessionId },
    );
    await this.openSession(init, launch.authMethod);
    ctx.agentAvailability(true);
    ctx.setState("running");
  }

  /**
   * Await an agent request, failing the turn if the agent exits, the turn is
   * stopped, or (with a timeout) it takes too long.
   * @param request - The request.
   * @param timeoutMs - How long it may take, or 0 for no limit.
   * @param timeoutMessage - The error when it does not answer in time.
   * @param unavailableOnFailure - Mark the agent unavailable if the process dies.
   * @returns The answer.
   */
  private async guard<T>(
    request: Promise<T>,
    timeoutMs: number,
    timeoutMessage: string,
    unavailableOnFailure = false,
  ): Promise<T> {
    const conn = this.conn as AcpConnection;
    const stop = Symbol("stop");
    const exit = conn.exited.then((code) => ({ exit: code }));
    const races: Promise<unknown>[] = [
      request.then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
      exit,
      this.ended.then(() => stop),
    ];
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0)
      races.push(
        new Promise((resolve) => {
          timer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
        }),
      );
    const outcome = (await Promise.race(races).finally(() =>
      clearTimeout(timer),
    )) as
      | { value: T }
      | { error: unknown }
      | { exit: number | null }
      | { timeout: true }
      | typeof stop;
    if (outcome === stop) throw new TurnFailure("stopped");
    if ("value" in outcome) return outcome.value;
    if ("error" in outcome) {
      // A dying agent closes the connection a moment before it exits: say
      // it exited, with its code, rather than that the connection closed.
      const exited = await within(conn.exited, 1_000, "running" as const);
      if (exited === "running") throw outcome.error;
      throw new TurnFailure(
        `${this.agentId} exited unexpectedly (code ${exited ?? "signal"}).${quoteTail(this.log.tail())}`,
        unavailableOnFailure
          ? `exited before initialize (code ${exited ?? "signal"})`
          : undefined,
      );
    }
    if ("timeout" in outcome)
      throw new TurnFailure(
        `${timeoutMessage}${quoteTail(this.log.tail())}`,
        unavailableOnFailure ? "did not answer initialize" : undefined,
      );
    throw new TurnFailure(
      `${this.agentId} exited unexpectedly (code ${outcome.exit ?? "signal"}).${quoteTail(this.log.tail())}`,
      unavailableOnFailure
        ? `exited before initialize (code ${outcome.exit ?? "signal"})`
        : undefined,
    );
  }

  /**
   * Create, resume, or load the ACP session, authenticating once if needed.
   * @param init - The agent's `initialize` answer.
   * @param configuredMethod - The config's `auth_method`.
   */
  private async openSession(
    init: InitializeResponse,
    configuredMethod: string | null,
  ): Promise<void> {
    let authenticated = false;
    for (;;) {
      try {
        await this.chooseSession(init.agentCapabilities ?? {});
        return;
      } catch (error) {
        if (isAuthRequired(error) && authenticated) {
          throw new AuthRequired(this.loginNeed(), "not logged in");
        }
        if (!isAuthRequired(error)) {
          if (error instanceof TurnFailure) throw error;
          throw new TurnFailure(
            `${this.agentId} could not open a session: ${errorMessage(error)}${quoteTail(this.log.tail())}`,
          );
        }
        const method = this.authMethodFor(
          init.authMethods ?? [],
          configuredMethod,
        );
        if (!method) throw new AuthRequired(this.loginNeed(), "not logged in");
        this.log.note(`authenticate ${method}`);
        await this.otel.around(
          "acp.authenticate",
          { "hypotenuse.acp.auth_method": method },
          () =>
            this.guard(
              (this.conn as AcpConnection).authenticate(method),
              0,
              "",
            ),
        );
        authenticated = true;
      }
    }
  }

  /**
   * The agent's own login, as an `auth` elicitation.
   * @returns The need: the agent as provider, and the command that fixes it.
   */
  private loginNeed(): AuthNeed {
    return {
      provider: providerSlug(this.agentId),
      providerName: this.agentTitle,
      body: `${this.agentTitle} on runner ${this.ctx.runnerName} is not logged in. Its owner can sign in on that machine with \`hypotenuse agents login ${this.agentId}\` — the link has the steps. Reply here once it's done and I'll carry on.`,
    };
  }

  /**
   * The auth method the host may run itself: the configured one if the agent
   * runs it, else the agent's first agent-run method. Terminal methods need a
   * person at the machine.
   * @param methods - The advertised methods.
   * @param configured - The config's `auth_method`.
   * @returns The method id, or null.
   */
  private authMethodFor(
    methods: AuthMethod[],
    configured: string | null,
  ): string | null {
    const agentRun = methods.filter(
      (m) => (m as { type?: string }).type !== "terminal",
    );
    if (configured)
      return agentRun.find((m) => m.id === configured)?.id ?? null;
    return agentRun[0]?.id ?? null;
  }

  /**
   * The session for this turn (§5 of the plan's table).
   * @param caps - The agent's capabilities.
   */
  private async chooseSession(caps: AgentCapabilities): Promise<void> {
    const conn = this.conn as AcpConnection;
    const { assignment, previousAcpSessionId } = this.ctx;
    const extra = this.role?.additional_directories ?? [];
    const directories =
      extra.length && caps.sessionCapabilities?.additionalDirectories
        ? { additionalDirectories: extra }
        : {};
    const mcpServers = this.mcpServers(caps);
    this.resumed = false;
    if (
      previousAcpSessionId &&
      !assignment.fresh &&
      assignment.kind === "prompt"
    ) {
      try {
        if (caps.sessionCapabilities?.resume) {
          const answer = await this.otel.around("acp.session.resume", {}, () =>
            this.guard(
              conn.resumeSession({
                sessionId: previousAcpSessionId,
                cwd: this.cwd,
                mcpServers,
                ...directories,
              }),
              0,
              "",
            ),
          );
          this.acpSessionId = previousAcpSessionId;
          this.resumed = true;
          await this.applyMode(answer);
          return;
        }
        if (caps.loadSession) {
          this.acpSessionId = previousAcpSessionId;
          this.mapper.replaying = true;
          try {
            const answer = await this.otel.around("acp.session.load", {}, () =>
              this.guard(
                conn.loadSession({
                  sessionId: previousAcpSessionId,
                  cwd: this.cwd,
                  mcpServers,
                  ...directories,
                }),
                0,
                "",
              ),
            );
            this.resumed = true;
            await this.applyMode(answer);
            return;
          } finally {
            this.mapper.replaying = false;
          }
        }
      } catch (error) {
        if (isAuthRequired(error) || error instanceof TurnFailure) throw error;
        this.acpSessionId = null;
        this.log.note(
          `resuming ${previousAcpSessionId} failed: ${errorMessage(error)}`,
        );
        this.ctx.log.info(
          `could not resume the agent's session; starting a new one with the history in the prompt: ${errorMessage(error)}`,
          { session: assignment.agentSessionId },
        );
      }
    }
    const created: NewSessionResponse = await this.otel.around(
      "acp.session.new",
      { "hypotenuse.mcp.servers": mcpServers.length },
      () =>
        this.guard(
          conn.newSession({ cwd: this.cwd, mcpServers, ...directories }),
          0,
          "",
        ),
    );
    this.acpSessionId = created.sessionId;
    await this.applyMode(created);
  }

  /** Whether this turn continues the agent's own session. */
  private resumed = false;

  /** Settles when `session/prompt` answers (or fails). */
  private promptSettled: Promise<void> | null = null;

  /** Whether the skipped-servers thought has been said this turn. */
  private toldSkipped = false;

  /**
   * The turn's MCP servers: `hypotenuse`, then the role's extras
   * (`mcp-servers.ts`). An HTTP server the agent cannot use is skipped, with
   * a thought; an unset variable fails the turn naming it.
   * @param caps - The agent's capabilities.
   * @returns The servers.
   * @throws {TurnFailure} When an extra server names an unset variable.
   */
  private mcpServers(caps: AgentCapabilities): McpServer[] {
    let chosen: ReturnType<typeof turnMcpServers>;
    try {
      chosen = turnMcpServers(
        this.role,
        caps,
        this.ctx.env,
        this.ctx.hypotenuseMcp,
      );
    } catch (error) {
      if (error instanceof UnsetVariableError)
        throw new TurnFailure(error.message);
      throw error;
    }
    if (chosen.skipped.length > 0 && !this.toldSkipped) {
      this.toldSkipped = true;
      this.emit({
        type: "thought",
        body: `${this.agentId} cannot use HTTP MCP servers, so ${chosen.skipped.map((n) => `\`${n}\``).join(", ")} ${chosen.skipped.length === 1 ? "is" : "are"} not available this turn.`,
        ephemeral: false,
      });
    }
    return chosen.servers;
  }

  /**
   * Select the role's `mode`, if the agent offers one.
   * @param answer - The session's creation answer.
   */
  private async applyMode(answer: {
    configOptions?: SessionConfigOption[] | null;
    modes?: { availableModes: { id: string }[] } | null;
  }): Promise<void> {
    const mode = this.role?.mode;
    const sessionId = this.acpSessionId;
    if (!mode || !sessionId) return;
    const conn = this.conn as AcpConnection;
    const option = (answer.configOptions ?? []).find(
      (o) => o.category === "mode" || o.id === "mode",
    );
    try {
      if (option) {
        await this.guard(
          conn.setConfigOption(sessionId, option.id, mode),
          0,
          "",
        );
        return;
      }
      if (answer.modes?.availableModes.some((m) => m.id === mode)) {
        await this.guard(conn.setMode(sessionId, mode), 0, "");
        return;
      }
      this.ctx.log.warn(
        `${this.agentId} offers no mode "${mode}"; continuing in its default`,
      );
    } catch (error) {
      if (error instanceof TurnFailure) throw error;
      this.ctx.log.warn(
        `selecting mode "${mode}" failed: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * Send the prompt and see the turn to its end.
   * @returns How it ended.
   */
  private async prompt(): Promise<TurnResult> {
    const { ctx } = this;
    const conn = this.conn as AcpConnection;
    const sessionId = this.acpSessionId as string;
    let templateText: string | null = null;
    let templateUrl: string | null = null;
    const docs: RoleDoc[] = [];
    // A resumed agent already holds its instructions; nothing is re-read.
    if (!this.resumed) {
      const promptFile = this.role?.prompt_file;
      if (promptFile && isRemoteSource(promptFile)) templateUrl = promptFile;
      else if (promptFile) {
        try {
          templateText = readFileSync(promptFile, "utf8");
        } catch (error) {
          throw new TurnFailure(
            `Runner ${ctx.runnerName} cannot read its ${ctx.assignment.role} prompt file: ${errorMessage(error)}`,
          );
        }
      }
      for (const doc of this.role?.docs ?? []) {
        if (isRemoteSource(doc)) {
          docs.push({ source: doc, text: null });
          continue;
        }
        try {
          docs.push({ source: tildify(doc), text: readFileSync(doc, "utf8") });
        } catch (error) {
          throw new TurnFailure(
            `Runner ${ctx.runnerName} cannot read a ${ctx.assignment.role} doc: ${errorMessage(error)}`,
          );
        }
      }
    }
    const blocks = buildPrompt(
      ctx.assignment,
      this.role,
      {
        cwd: this.cwd,
        branch: this.branch,
        repositoryName: this.repositoryName(),
        runnerName: ctx.runnerName,
        resumed: this.resumed,
        templateText,
        templateUrl,
        docs,
        readOnly: this.workspace?.mode === "readonly",
      },
      (name) =>
        ctx.log.warn(
          `the prompt template uses an unknown variable {{${name}}}; it rendered empty`,
        ),
    );
    this.promptStartedAt = this.now();
    this.lastTraffic = this.now();
    const promptText = blocks
      .map((b) => (b as { text?: string }).text ?? "")
      .join("\n\n");
    this.otel.promptStarted(
      {
        "hypotenuse.prompt.blocks": blocks.length,
        "hypotenuse.prompt.bytes": Buffer.byteLength(promptText),
        "hypotenuse.prompt.history": ctx.assignment.history.length,
        "hypotenuse.prompt.guidance": ctx.assignment.guidance.length,
        "hypotenuse.prompt.context_bytes": Buffer.byteLength(
          ctx.assignment.promptContext ?? "",
        ),
        "hypotenuse.acp.resumed": this.resumed,
      },
      promptText,
    );
    if (ctx.log.enabled("debug")) {
      ctx.log.debug(
        `prompting ${this.agentId}: ${preview(promptText, ctx.log.level)}`,
        {
          session: ctx.assignment.agentSessionId,
          workItem: ctx.assignment.workItemId,
          bytes: Buffer.byteLength(promptText),
        },
      );
    }
    const request = conn.prompt(sessionId, blocks);
    this.promptSettled = request.then(
      () => {},
      () => {},
    );
    const answer = await this.guard(request, 0, "").catch((error: unknown) => {
      if (error instanceof TurnFailure) throw error;
      throw new TurnFailure(
        `${this.agentId} failed the turn: ${errorMessage(error)}${quoteTail(this.log.tail())}`,
      );
    });
    const usage = (
      answer as { usage?: { inputTokens?: number; outputTokens?: number } }
    ).usage;
    this.otel.promptEnded(
      {
        "gen_ai.response.finish_reasons": answer.stopReason,
        "gen_ai.usage.input_tokens": usage?.inputTokens,
        "gen_ai.usage.output_tokens": usage?.outputTokens,
      },
      answer.stopReason === "end_turn" || answer.stopReason === "cancelled"
        ? null
        : `stopReason: ${answer.stopReason}`,
    );
    if (this.endReason) return await this.stopped();
    this.emit({ type: "status", state: "finishing" });
    const stop =
      answer.stopReason === "cancelled" ? "end_turn" : answer.stopReason;
    if (this.mapper.askedUser && this.mapper.hasMessage)
      this.log.note(
        `said after asking (kept out of Linear): ${this.mapper.message().slice(0, 2000)}`,
      );
    this.emitAll(
      this.mapper.finish(stop, {
        branch: this.branch,
        signature: responseSignature({
          role: this.ctx.assignment.role ?? "worker",
          agentId: this.agentId,
          agentTitle: this.agentTitle,
          agentVersion: this.agentVersion,
          runnerName: this.ctx.runnerName,
        }),
      }),
    );
    return stop === "end_turn"
      ? this.result("completed")
      : this.result("failed", `stopReason: ${stop}`);
  }

  /**
   * The repository's configured name, if the turn has one.
   * @returns The name.
   */
  private repositoryName(): string | null {
    const remote = this.ctx.assignment.repository?.remote;
    if (!remote) return null;
    const repo = this.ctx.config.repositories.find(
      (r) => r.remote && r.remote.includes(remote),
    );
    return repo ? repositoryName(repo) : (remote.split("/").pop() ?? null);
  }

  /**
   * The cancel path's end: wind the agent down, then say what a stopped turn
   * owes for its reason.
   * @returns How it ended.
   */
  private async stopped(): Promise<TurnResult> {
    const reason = this.endReason ?? "stop";
    const waitingOnPerson =
      this.questions.waiting || this.waitingSince !== null;
    await this.windDown();
    // After a question, anything posted would take the session out of
    // awaitingInput and hide it. Only the person's own Stop is answered: it
    // has already ended the question. Every other ending stays in the log.
    const quiet = this.mapper.askedUser && reason !== "stop";
    if (reason === "noise") {
      const body =
        this.noiseFailure ?? `${this.agentId} wrote output that is not ACP.`;
      this.mapper.stopping = false;
      if (quiet) this.log.note(`after asking, not posted: ${body}`);
      else this.emit({ type: "error", body });
      return this.result("failed", body);
    }
    const timeouts = this.ctx.config.sessions;
    const event = stopActivity({
      reason,
      runnerName: this.ctx.runnerName,
      cwd: this.cwd,
      branch: this.branch,
      note: this.ctx.stopNote?.() ?? null,
      timeoutMs:
        reason === "idle"
          ? timeouts.idle_timeout
          : (this.role?.turn_timeout ?? timeouts.turn_timeout),
      waitingOnPerson,
      changedFiles: changedFiles(this.cwd),
    });
    if (event && quiet)
      this.log.note(
        `after asking, not posted: ${"body" in event ? String(event.body) : event.type}`,
      );
    else if (event) this.emit(event);
    this.log.note(`stopped: ${reason}`);
    if (reason === "timeout" || reason === "idle")
      return this.result(
        "failed",
        event && "body" in event ? String(event.body) : reason,
      );
    return this.result("cancelled");
  }

  /**
   * Steps 1–4 of the cancel path: `session/cancel`, answer every open
   * question `cancelled`, wait `stop_grace`, then SIGTERM and SIGKILL.
   */
  private async windDown(): Promise<void> {
    this.mapper.stopping = true;
    this.questions.cancelAll();
    const conn = this.conn;
    if (!conn || conn.hasExited) return;
    const grace = this.ctx.config.sessions.stop_grace;
    const deadline = this.now() + grace;
    if (this.acpSessionId && this.promptSettled) {
      await conn.cancel(this.acpSessionId);
      // The agent answers `session/prompt` with `cancelled` once it has wound
      // down; its stdin closing then lets it exit on its own.
      await within(
        Promise.race([this.promptSettled, conn.exited]),
        grace,
        null,
      );
    }
    conn.close();
    const left = Math.max(deadline - this.now(), 500);
    if ((await within(conn.exited, left, "timeout")) !== "timeout") return;
    this.log.note("still running after stop_grace; SIGTERM");
    conn.signal("SIGTERM");
    if (
      (await within(
        conn.exited,
        this.options.killGraceMs ?? KILL_GRACE_MS,
        "timeout",
      )) !== "timeout"
    )
      return;
    this.log.note("still running; SIGKILL");
    conn.signal("SIGKILL");
    await within(conn.exited, 2_000, null);
  }

  /** Close the agent after a turn that ended on its own. */
  private async shutdown(): Promise<void> {
    await this.closeAgent();
    if (this.conn) this.otel.exited(await within(this.conn.exited, 500, null));
    // The agent's last flush landed while it exited; the receiver drains it.
    await this.receiver?.close();
    this.receiver = null;
  }

  /**
   * Point the agent's own telemetry at the turn's loopback receiver, and
   * give it the `acp.prompt` span as `TRACEPARENT` (agents that honour it
   * parent their spans on it). Only for a turn whose telemetry asks for the
   * agent's; a runner whose owner turned it off never gets here.
   * @param launch - The launch, changed in place.
   */
  private withTelemetry(launch: {
    preset: string | null;
    command: string[];
    env: Record<string, string>;
  }): void {
    const turn = this.ctx.telemetry;
    if (!turn) return;
    const traceparent = this.otel.traceparent;
    if (traceparent) launch.env.TRACEPARENT = traceparent;
    if (!turn.agentNative) return;
    this.receiver = new NativeReceiver(turn);
    const endpoint = this.receiver.start();
    turn.addSecret(this.receiver.nonce);
    dropInheritedOtel(launch.env);
    const native = nativeTelemetryLaunch(launch.preset, {
      endpoint,
      level: turn.level,
    });
    Object.assign(launch.env, native.env);
    launch.command = [...launch.command, ...native.args];
  }

  /** Close the agent process, as {@link shutdown}'s first step. */
  private async closeAgent(): Promise<void> {
    const conn = this.conn;
    if (!conn) return;
    if (!conn.hasExited) {
      conn.close();
      if ((await within(conn.exited, 2_000, "timeout")) === "timeout") {
        conn.signal("SIGTERM");
        if (
          (await within(
            conn.exited,
            this.options.killGraceMs ?? KILL_GRACE_MS,
            "timeout",
          )) === "timeout"
        )
          conn.signal("SIGKILL");
      }
    }
    this.ctx.setPid(null);
  }

  /** The timers: thought flushes, keepalives, idle and turn timeouts. */
  private tick(): void {
    if (this.endReason) return;
    const now = this.now();
    this.emitAll(this.mapper.tick());
    const sessions = this.ctx.config.sessions;
    const waiting = this.waitingSince !== null;
    if (now - this.lastTraffic >= sessions.idle_timeout) {
      this.endNow("idle");
      return;
    }
    const turnTimeout = this.role?.turn_timeout ?? sessions.turn_timeout;
    if (this.promptStartedAt !== null && !waiting) {
      const elapsed = now - this.promptStartedAt - this.pausedMs;
      if (elapsed >= turnTimeout) {
        this.endNow("timeout");
        return;
      }
    }
    if (
      !waiting &&
      !this.mapper.askedUser &&
      now - this.lastEmit >= sessions.keepalive_interval
    ) {
      const last = this.mapper.lastAction;
      this.emit({
        type: "thought",
        body: last ? `Still working: ${last}` : "Still working.",
        ephemeral: true,
      });
    }
  }

  /**
   * A line of stdout that is not ACP.
   * @param line - The line.
   */
  private noise(line: string): void {
    this.log.note(`stdout (not ACP): ${line.slice(0, 500)}`);
    this.noiseInARow++;
    if (this.noiseInARow >= NOISE_LIMIT && !this.noiseFailure) {
      this.noiseFailure = `${this.agentId} wrote ${NOISE_LIMIT} lines to stdout that are not ACP, so its output cannot be trusted. Its launch command may need a flag to speak ACP, or to log to stderr.${quoteTail(this.log.tail())}`;
      this.endNow("noise");
    }
  }

  /**
   * Answer a permission request by policy, or ask the person.
   * @param params - The request.
   * @returns The answer.
   */
  private async permission(params: Parameters<typeof permissionQuestion>[0]) {
    const policy = this.role?.permission_policy ?? "allow";
    const decision = decide(policy, params.toolCall.kind);
    const waited = this.otel.permission(
      params.toolCall,
      typeof policy === "string" ? policy : JSON.stringify(policy),
      params.options,
    );
    if (decision !== "ask") {
      const optionId = automaticOption(params.options, decision);
      this.log.note(
        `permission ${params.toolCall.toolCallId}: ${decision} → ${optionId ?? "cancelled"}`,
      );
      waited({
        outcome: optionId ? "selected" : "cancelled",
        optionId: optionId ?? undefined,
        decidedBy: "policy",
      });
      return optionId
        ? { outcome: { outcome: "selected" as const, optionId } }
        : { outcome: { outcome: "cancelled" as const } };
    }
    this.emitAll(this.mapper.flushThought(true));
    const answer = await this.questions.ask(
      permissionQuestion(params, this.where, this.cwd),
    );
    const outcome = (
      answer as { outcome?: { outcome?: string; optionId?: string } }
    ).outcome;
    waited({
      outcome: outcome?.outcome ?? "cancelled",
      optionId: outcome?.optionId,
      decidedBy: "person",
    });
    return answer;
  }

  /**
   * The JSON-RPC error for a refused or failed file operation.
   * @param error - What the handler threw.
   * @returns The error to answer with.
   */
  private fsError(error: unknown): AcpError {
    if (error instanceof OutsideWorktree) {
      this.log.note(`refused file access outside the worktree: ${error.path}`);
      return new AcpError(RESOURCE_REFUSED, "outside the session worktree", {
        path: error.path,
      });
    }
    return new AcpError(-32603, errorMessage(error));
  }
}
