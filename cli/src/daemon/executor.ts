/**
 * The seam between the supervisor and whatever runs a turn: the ACP agent
 * host (`acp/host.ts`) in the daemon, and scripted executors in tests.
 */
import type {
  CANCEL_REASONS,
  COMPLETE_OUTCOMES,
  WorkAssignment,
} from "../../../protocol/src/index";
import type { Config } from "../config/schema";
import type { TurnTelemetry } from "../telemetry/collector";
import type { Workspace } from "../worktree/manager";
import type { EventInput } from "./event-sink";
import type { DaemonLog } from "./log";

/** A person's reply to a question the turn asked, as the server delivers it. */
export interface TurnReply {
  /** The inbound prompt activity it came from. */
  activityId: number;
  /** What they wrote. */
  body: string;
}

/** Why a running turn is being stopped. */
export type StopReason =
  | (typeof CANCEL_REASONS)[number]
  | "drain"
  | "shutdown"
  | "kill"
  | "revoked";

/** Everything a turn gets. */
export interface TurnContext {
  /** What the server assigned. */
  assignment: WorkAssignment;
  /** The config at the time the turn started (reloads apply to new turns). */
  config: Config;
  /** This runner's name. */
  runnerName: string;
  /** Fires when the turn must stop; `stopReason()` says why. */
  signal: AbortSignal;
  /** Why the turn is being stopped, once it is. */
  stopReason(): StopReason | null;
  /** Report an event; durable before it returns. A no-op once the turn is silenced. */
  emit(event: EventInput): void;
  /** The daemon log, with this session's fields. */
  log: DaemonLog;
  /** The daemon's state directory (session logs, working directories). */
  stateDir: string;
  /** The daemon's environment, which agents inherit. */
  env: Record<string, string | undefined>;
  /** The ACP session this runner last held for the session, if any. */
  previousAcpSessionId: string | null;
  /**
   * Register the reader of a person's replies to the turn's questions. It
   * answers true when a reply answered a question, false when it did not
   * (it becomes the session's next prompt), and null when nothing was asked.
   */
  onReply(handler: (reply: TurnReply) => boolean | null): void;
  /** Record the agent's process id (null once it is gone). */
  setPid(pid: number | null): void;
  /** Report whether the turn's agent could start, for capabilities. */
  agentAvailability(available: boolean, error?: string): void;
  /** The turn's state as heartbeats report it. */
  setState(state: "starting" | "running"): void;
  /**
   * Where the turn works: the session's worktree (created, fetched, and set
   * up, or reused), a person's checkout, or a scratch directory. Absent in
   * harnesses that do not manage worktrees; the turn then works in
   * `<state dir>/workspaces/<agentSessionId>`.
   * @throws {WorkspaceError} When it cannot be prepared; its body is the turn's error.
   */
  prepareWorkspace?(io: WorkspaceIo): Promise<Workspace>;
  /** Pull request URLs already linked to the session. */
  pullRequests?: readonly string[];
  /** Remember a pull request linked to the session. */
  recordPullRequest?(url: string): void;
  /** What a person said when they stopped the turn (`agents kill --reason`). */
  stopNote?(): string | null;
  /**
   * How to start the turn's `hypotenuse` MCP server — this program's `mcp`
   * command with the session id and the turn's nonce — or absent where the
   * daemon serves no tools (some harnesses).
   */
  hypotenuseMcp?: HypotenuseMcpLaunch | null;
  /**
   * Register the reader of the turn's `linear_ask_user` calls: true before
   * the question is posted, false if posting it failed.
   */
  onAskingUser?(handler: (asking: boolean) => void): void;
  /** Register the reader of pull requests linked through `linear_report_pr`. */
  onReportedPullRequest?(handler: (url: string) => void): void;
  /**
   * The turn's telemetry, when the project exports it and this runner's
   * owner allows it; null or absent otherwise. The supervisor ends it.
   */
  telemetry?: TurnTelemetry | null;
}

/** A stdio MCP server's launch, as ACP's `mcpServers` wants it. */
export interface HypotenuseMcpLaunch {
  /** An absolute path. */
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** What preparing a workspace needs from the turn. */
export interface WorkspaceIo {
  /** A line for the session log. */
  output(line: string): void;
  /** The per-session environment for setup commands, given the branch. */
  env(branch: string | null): Record<string, string>;
}

/** How a turn ended. */
export interface TurnResult {
  outcome: (typeof COMPLETE_OUTCOMES)[number];
  error?: string | null;
  acpSessionId?: string | null;
  branch?: string | null;
}

/** Runs one turn. */
export interface SessionExecutor {
  /**
   * Run a turn to its end. Must return (not throw) when `signal` fires, after
   * emitting what a stopped turn owes the person.
   * @param ctx - The turn.
   * @returns How it ended.
   */
  run(ctx: TurnContext): Promise<TurnResult>;
}
