/**
 * A config change that only a restart can apply, waiting for the running
 * turns to finish first.
 *
 * Every way it can end, in one place:
 *
 * | While waiting                                   | Then                                  |
 * |---|---|
 * | the turns finish (or the wait runs out)         | restart — if the file is still valid  |
 * | the file is invalid when the wait ends          | called off; claims resume             |
 * | a newer save still needs the restart            | keeps waiting                         |
 * | a newer save is invalid, or undoes the change   | called off; claims resume             |
 * | `daemon stop` / `upgrade` / `restart` (a drain or restart over the socket) | taken over: never restarts on its own |
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
  /** Whether the file the next process will read is valid. */
  configValid(): boolean;
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
   * decides what happens next, so this restart never runs on its own.
   */
  takeOver(): void {
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
    if (!this.deps.configValid()) {
      this.callOff(`${path} is not valid now; the running config stays`);
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
    return this.pending === generation && !this.deps.exiting();
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
