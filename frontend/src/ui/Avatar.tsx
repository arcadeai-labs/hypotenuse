import type { HTMLAttributes } from "react";
import { BotBadge } from "./BotBadge";
import { cx } from "./cx";

/** See {@link Avatar}. */
export type AvatarProps = HTMLAttributes<HTMLSpanElement> & {
  /** Display name; also the source of the initials and the accessible name. */
  name: string;
  /** A picture, when there is one. Initials otherwise. */
  src?: string;
  /**
   * Set when this avatar stands for a bot. A bot avatar **always** carries a
   * {@link BotBadge}: there is no prop to hide it, because a reader must never
   * mistake a bot for a person. Without a picture a bot is a monogram on the
   * accent tint, never a person-like default.
   */
  bot?: boolean;
  /** Diameter in px. */
  size?: number;
};

/**
 * Up to two initials for a name.
 * @param name - A display name.
 * @returns The initials, upper-cased.
 */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0]?.[0] ?? "";
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? "") : "";
  return `${first}${last}`.toUpperCase();
}

/**
 * A person or a bot.
 * @param props - See {@link AvatarProps}.
 * @returns The avatar, followed by the bot badge for a bot.
 */
export function Avatar({
  name,
  src,
  bot = false,
  size = 20,
  className,
  ...props
}: AvatarProps) {
  const face = (
    <span
      {...props}
      className={cx("ui-avatar", bot && "ui-avatar-bot", className)}
      style={{ width: size, height: size, ...props.style }}
      role="img"
      aria-label={bot ? `${name} (bot)` : name}
      title={name}
    >
      {src ? (
        <img src={src} alt="" />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
    </span>
  );
  if (!bot) return face;
  return (
    <span className="ui-avatar-group">
      {face}
      <BotBadge name={name} />
    </span>
  );
}
