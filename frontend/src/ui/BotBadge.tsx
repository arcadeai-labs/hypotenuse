import type { HTMLAttributes } from "react";
import { cx } from "./cx";

/**
 * The **bot** chip with the bot's name beside it. It goes on every avatar that
 * stands for a bot — {@link Avatar} draws it whenever `bot` is set, and has no
 * prop to hide it — so a reader never mistakes a bot for a person.
 * @param props - `name` and native span props.
 * @returns The badge.
 */
export function BotBadge({
  name,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { name: string }) {
  return (
    <span {...props} className={cx("ui-bot-badge", className)} data-bot={name}>
      <span className="ui-bot-badge-tag">bot</span>
      <span className="ui-bot-badge-name">{name}</span>
    </span>
  );
}
