/**
 * A config change that only a restart can apply, waiting for the running
 * turns to finish first.
 *
 * Every way it can end, in one place:
 *
 * | While waiting                                   | Then                                  |
 * |---|---|
 * | the turns finish (or the wait runs out)         | restart — if the file is still valid  |
 * | the next process would refuse to start (an invalid file, no runner for the server, another project) | called off; claims resume |
 * | a newer save still needs the restart            | keeps waiting                         |
 * | a newer save is invalid, or undoes the change   | called off; claims resume             |
 * | `daemon stop` / `upgrade` / `restart` (a drain or restart over the socket) | taken over for good: no later save starts or calls off anything |
 * | the daemon begins exiting (a signal, a revocation) | never restarts                     |
 *
 * Generations keep a superseded wait from acting: only the newest request
 * can restart.
 */

/** What a config restart drives. */
export interface ConfigRestartDeps {
  /** Stop claiming new turns. */
  pauseClaims(): void;
  /** Claim again. */
  resumeClaims(): void;
  /** Wait for the running turns, bounded; whether they all finished. */
  waitIdle(timeoutMs: number): Promise<boolean>;
  /** Stop the turns still running after the wait ran out. */
  stopTurns(): Promise<void>;
  /**
   * Why the next process would refuse to start, from the file as it is now
   * (the config and the runner it names), or null when it would start.
   */
  startProblem(): string | null;
  /** Whether the daemon has begun exiting. */
  exiting(): boolean;
  /** Restart the daemon. */
  restart(): void;
  /** Log a line. */
  log(message: string): void;
}

/** A pending config restart's state machine. */
export class ConfigRestart {
  private pending: number | null = null;
  private generation = 0;
  /** A stop, upgrade, or restart owns the daemon's lifecycle now. */
  private takenOver = false;

  /**
   * @param deps - What it drives.
   * @param timeoutMs - How long running turns get to finish.
   */
  constructor(
    private readonly deps: ConfigRestartDeps,
    private readonly timeoutMs: number,
  ) {}

  /** Whether a restart is waiting. */
  get isPending(): boolean {
    return this.pending !== null;
  }

  /** Whether a stop, upgrade, or restart took over: saves do nothing now. */
  get isTakenOver(): boolean {
    return this.takenOver;
  }

  /**
   * A save was reloaded. Start waiting when it needs a restart; while
   * waiting, keep on or call it off.
   * @param outcome - Whether the save needs a restart, or was invalid.
   * @param path - The config file, for the log.
   * @returns The wait, when this save started one (tests await it).
   */
  saved(
    outcome: { needsRestart: boolean; invalid: boolean },
    path: string,
  ): Promise<void> | null {
    if (this.takenOver) return null;
    if (this.pending !== null) {
      if (!outcome.needsRestart) {
        this.callOff(
          outcome.invalid
            ? `${path} is not valid now; the running config stays`
            : "the change that needed it was undone",
        );
      }
      return null;
    }
    if (!outcome.needsRestart) return null;
    const generation = ++this.generation;
    this.pending = generation;
    this.deps.pauseClaims();
    return this.wait(generation, path);
  }

  /**
   * A stop, an upgrade, or a restart asked over the control socket: it
   * decides what happens next, for good — the daemon is on its way out, so
   * no later save may start a restart or resume claims under it.
   */
  takeOver(): void {
    this.takenOver = true;
    if (this.pending === null) return;
    this.pending = null;
    this.deps.log("config restart called off: a stop or restart was asked for");
  }

  /**
   * Wait for the turns, then restart unless something called it off.
   * @param generation - This request.
   * @param path - The config file, for the log.
   */
  private async wait(generation: number, path: string): Promise<void> {
    const idle = await this.deps.waitIdle(this.timeoutMs);
    if (!this.current(generation)) return;
    const problem = this.deps.startProblem();
    if (problem) {
      this.callOff(
        `the daemon would not start on ${path} as it is now (${problem}); the running config stays`,
      );
      return;
    }
    if (!idle) await this.deps.stopTurns();
    if (!this.current(generation)) return;
    this.pending = null;
    this.deps.restart();
  }

  /**
   * Whether a request may still act.
   * @param generation - The request.
   * @returns False once it was superseded, called off, or the daemon exits.
   */
  private current(generation: number): boolean {
    return (
      this.pending === generation && !this.takenOver && !this.deps.exiting()
    );
  }

  /**
   * Call off the waiting restart and claim again.
   * @param reason - Why, for the log.
   */
  private callOff(reason: string): void {
    if (this.pending === null) return;
    this.pending = null;
    this.deps.resumeClaims();
    this.deps.log(`config restart called off: ${reason}`);
  }
}
