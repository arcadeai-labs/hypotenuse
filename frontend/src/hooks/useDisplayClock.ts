import { useEffect, useState } from "react";

/** How often a live duration label should advance. */
const TICK_MS = 1_000;

/**
 * Whether a duration label still needs a moving clock.
 * @param startedAt - Epoch ms the thing started, or null.
 * @param finishedAt - Epoch ms it finished, or null if still going.
 * @returns Whether elapsed time should tick.
 */
export function durationIsLive(
  startedAt: number | null | undefined,
  finishedAt: number | null | undefined,
): boolean {
  return startedAt != null && finishedAt == null;
}

/**
 * A wall-clock that ticks while something on screen is still running.
 *
 * **This is not a poll.** It does not fetch. Without a tick, a live duration
 * label freezes at the last socket ping. One second is enough for a
 * human-readable elapsed string and does not talk to the server.
 * @param enabled - Whether anything displayed still needs a moving clock.
 * @returns Epoch ms, updating while enabled.
 */
export function useDisplayClock(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [enabled]);

  return now;
}
