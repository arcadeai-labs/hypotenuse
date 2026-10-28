import type { HTMLAttributes } from "react";
import { PLATFORM_LABELS, type Platform } from "../../../design/states";
import { cx } from "./cx";

/**
 * Where a conversation lives — Slack, Linear, Pylon, or the HTTP API — set as
 * text in a neutral chip. Never a logo: text is legible in both themes and
 * carries no trademark to get wrong.
 * @param props - `platform` and native span props.
 * @returns The chip.
 */
export function PlatformChip({
  platform,
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { platform: Platform }) {
  return (
    <span
      {...props}
      className={cx("ui-chip", "ui-chip-subtle", "ui-platform-chip", className)}
      data-platform={platform}
    >
      {PLATFORM_LABELS[platform]}
    </span>
  );
}
