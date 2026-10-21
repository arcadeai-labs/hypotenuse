/**
 * The seam between the supervisor and whatever runs a turn. This build's
 * slots run the null executor; the ACP agent host replaces it behind the same
 * interface.
 */
import type {
  CANCEL_REASONS,
  COMPLETE_OUTCOMES,
  WorkAssignment,
} from "../../../protocol/src/index";
import type { Config } from "../config/schema";
import type { EventInput } from "./event-sink";
import type { DaemonLog } from "./log";

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
