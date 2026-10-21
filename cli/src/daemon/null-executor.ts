/**
 * The null executor: what a slot runs until the ACP agent host exists. It
 * proves the whole loop — offer, claim, events, completion — by saying it
 * received the turn and that there is no agent to run it, then completing.
 *
 * `HYPOTENUSE_NULL_TURN_MS` holds the turn open that long between the two
 * events, posting an ephemeral thought each second meanwhile, so drain, stop,
 * and the offline queue's supersession can be exercised against a turn that
 * is running.
 */
import type { SessionExecutor, TurnContext, TurnResult } from "./executor";

/** The thought the null executor posts first. */
export function receivedThought(runnerName: string): string {
  return `Hypotenuse runner ${runnerName} received this; no agent host is installed yet.`;
}

/** The null executor. */
export class NullExecutor implements SessionExecutor {
  /**
   * @param holdMs - How long to hold each turn open.
   */
  constructor(
    private readonly holdMs = Number(
      process.env.HYPOTENUSE_NULL_TURN_MS ?? 0,
    ) || 0,
  ) {}

  /**
   * @param ctx - The turn.
   * @returns `completed`, or `cancelled` when stopped while held open.
   */
  async run(ctx: TurnContext): Promise<TurnResult> {
    const issue = ctx.assignment.issue.identifier ?? "this issue";
    ctx.emit({ type: "thought", body: receivedThought(ctx.runnerName) });
    const until = Date.now() + this.holdMs;
    while (!ctx.signal.aborted && Date.now() < until) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(1_000, until - Date.now()));
        ctx.signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (!ctx.signal.aborted && Date.now() < until) {
        ctx.emit({
          type: "thought",
          body: `Holding this turn open (${Math.ceil((until - Date.now()) / 1000)}s left).`,
          ephemeral: true,
        });
      }
    }
    if (ctx.signal.aborted) {
      ctx.emit({
        type: "response",
        body: `Stopped (${ctx.stopReason() ?? "stop"}). Runner ${ctx.runnerName} has no coding agent yet, so nothing was changed for ${issue}.`,
      });
      return { outcome: "cancelled" };
    }
    ctx.emit({
      type: "response",
      body: `Runner ${ctx.runnerName} has no coding agent yet, so nothing was done for ${issue}.`,
    });
    return { outcome: "completed" };
  }
}
