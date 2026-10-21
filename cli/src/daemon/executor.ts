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
