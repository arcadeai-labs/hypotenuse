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
