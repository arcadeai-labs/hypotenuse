import type { HTMLAttributes } from "react";
import { AgentBadge } from "./Chip";
import { cx } from "./cx";

/** See {@link Avatar}. */
export type AvatarProps = HTMLAttributes<HTMLSpanElement> & {
  /** Display name; also the source of the initials and the accessible name. */
  name: string;
  /** A picture, when there is one. Initials otherwise. */
  src?: string;
  /**
   * Set when this avatar stands for an agent, to the agent's kind. An agent
   * avatar **always** carries an {@link AgentBadge}: there is no prop to hide
   * it, because a reader must never mistake an agent for a person.
   */
  agent?: string;
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
 * A person or an agent.
 * @param props - See {@link AvatarProps}.
 * @returns The avatar, followed by the agent badge for an agent.
 */
export function Avatar({
  name,
  src,
  agent,
  size = 20,
  className,
  ...props
}: AvatarProps) {
  const face = (
    <span
      {...props}
      className={cx("ui-avatar", agent && "ui-avatar-agent", className)}
      style={{ width: size, height: size, ...props.style }}
      role="img"
      aria-label={agent ? `${name} (agent)` : name}
      title={name}
    >
      {src ? (
        <img src={src} alt="" />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
    </span>
  );
  if (!agent) return face;
  return (
    <span className="ui-avatar-group">
      {face}
      <AgentBadge kind={agent} />
    </span>
  );
}
