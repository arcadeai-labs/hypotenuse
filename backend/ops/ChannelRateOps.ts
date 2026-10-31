import { api, config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/platforms";
import type { Bot } from "../schema/bots";
import { runRedisScript } from "./RedisScriptOps";

/**
 * **Rate limits on a bot's platform traffic.** Being in the channel is the
 * permission to talk to a bot, so identity is no defense against a flood:
 * limits and budgets are. Each bot counts messages per participant and per
 * channel in a fixed window (`rate-window.lua`); past either limit, a
 * message is recorded and ignored for the rest of the window, and the sender
 * is told once — where the platform has ephemeral messages.
 *
 * | Participant over | Channel over | Outcome |
 * |---|---|---|
 * | no | no | delivered |
 * | yes | no | `ignored: rate-limited` (participant) |
 * | no | yes | `ignored: rate-limited` (channel) |
 * | yes | yes | `ignored: rate-limited` (participant) |
 */

/** What the limiter decided for one message. */
export type RateDecision =
  | { limited: false }
  | {
      limited: true;
      scope: "participant" | "channel";
      /** The first refusal of this window for this sender: tell them once. */
      firstNotice: boolean;
    };

/** The current window's number. */
function windowNumber(): number {
  return Math.floor(Date.now() / (config.platforms.rateWindowSeconds * 1000));
}

/**
 * Count one message and decide whether it is over a limit.
 * @param bot - The bot (its limits).
 * @param channelId - The channel.
 * @param participantKey - The sender's platform identity.
 * @returns The decision.
 */
export async function countMessage(
  bot: Pick<Bot, "id" | "participantRateLimit" | "channelRateLimit">,
  channelId: number,
  participantKey: string,
): Promise<RateDecision> {
  const w = windowNumber();
  const ms = config.platforms.rateWindowSeconds * 1000;
  const p = Number(
    await runRedisScript(
      "rate-window",
      [`rate:bot:${bot.id}:participant:${participantKey}:${w}`],
      [ms],
    ),
  );
  const c = Number(
    await runRedisScript(
      "rate-window",
      [`rate:bot:${bot.id}:channel:${channelId}:${w}`],
      [ms],
    ),
  );
  const scope =
    p > bot.participantRateLimit
      ? "participant"
      : c > bot.channelRateLimit
        ? "channel"
        : null;
  if (!scope) return { limited: false };
  const noted = await api.redis.redis.set(
    `rate:bot:${bot.id}:noted:${participantKey}:${w}`,
    "1",
    "PX",
    ms,
    "NX",
  );
  return { limited: true, scope, firstNotice: noted === "OK" };
}
