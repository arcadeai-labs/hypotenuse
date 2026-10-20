import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/** See {@link Chip}. */
export type ChipProps = HTMLAttributes<HTMLSpanElement> & {
  /** A leading glyph or dot. */
  icon?: ReactNode;
  /** `subtle` (default) sits on any surface; `accent` is for the one chip that should draw the eye. */
  tone?: "subtle" | "accent";
};

/**
 * A generic pill: a filter, a repository name, an "update available" note.
 * @param props - See {@link ChipProps}.
 * @returns The chip.
 */
export function Chip({
  icon,
  tone = "subtle",
  className,
  children,
  ...props
}: ChipProps) {
  return (
    <span {...props} className={cx("ui-chip", `ui-chip-${tone}`, className)}>
      {icon}
      {children}
    </span>
  );
}

/** A role a runner can serve. */
export type AgentRole = "manager" | "worker";

/**
 * The role a session or runner plays: a rounded square holding **M** or **W**,
 * tinted with that role's token. The full word is the accessible name.
 * @param props - `role`, `showLabel` to print the word beside the letter, and native span props.
 * @returns The role chip.
 */
export function RoleChip({
  role,
  showLabel = false,
  className,
  ...props
}: Omit<HTMLAttributes<HTMLSpanElement>, "role"> & {
  role: AgentRole;
  showLabel?: boolean;
}) {
  const word = role === "manager" ? "Manager" : "Worker";
  return (
    <span
      {...props}
      className={cx("ui-role-chip", `ui-role-${role}`, className)}
      data-role={role}
      title={word}
    >
      <span className="ui-role-letter" aria-hidden="true">
        {word[0]}
      </span>
      <span className={showLabel ? "ui-role-label" : "visually-hidden"}>
        {word}
      </span>
    </span>
  );
}

/**
 * The "agent" chip with the agent's name (`claude`, `codex`, or whatever key the
 * runner's config gives it). It goes on every avatar that stands for an agent,
 * so a reader never mistakes an agent for a person.
 * @param props - `kind` and native span props.
 * @returns The badge.
 */
export function AgentBadge({
  kind,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { kind: string }) {
  return (
    <span
      {...props}
      className={cx("ui-agent-badge", className)}
      data-agent={kind}
    >
      <span className="ui-agent-badge-tag">agent</span>
      <span className="ui-agent-badge-kind">{kind}</span>
    </span>
  );
}
