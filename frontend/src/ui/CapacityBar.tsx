import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/** One slot of a {@link CapacityBar}. */
export interface CapacitySegment {
  /** What the slot is doing. `stale` is a live slot whose runner went quiet. */
  state: "busy" | "free" | "stale";
  /** The work in the slot, e.g. the issue identifier. */
  label?: ReactNode;
  /** Where the label links to. */
  href?: string;
}

/**
 * A runner's capacity, one segment per slot. A filled segment is labelled with
 * the work in it and links there.
 * @param props - `segments`, an optional `label` for the bar, and native div props.
 * @returns The bar, announced as "busy of total".
 */
export function CapacityBar({
  segments,
  label,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & {
  segments: CapacitySegment[];
  label?: ReactNode;
}) {
  const busy = segments.filter((s) => s.state !== "free").length;
  return (
    <div {...props} className={cx("ui-capacity", className)}>
      {label !== undefined && (
        <div className="ui-capacity-label">
          {label}
          <span className="ui-capacity-count">
            {busy}/{segments.length}
          </span>
        </div>
      )}
      <div
        className="ui-capacity-track"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={segments.length}
        aria-valuenow={busy}
        aria-label={`${busy} of ${segments.length} slots in use`}
      >
        {segments.map((segment, i) => {
          const body =
            segment.label === undefined ? null : segment.href ? (
              <a href={segment.href}>{segment.label}</a>
            ) : (
              segment.label
            );
          return (
            <div
              // Slots are positional: the n-th slot is the n-th slot.
              // biome-ignore lint/suspicious/noArrayIndexKey: slots have no id.
              key={i}
              className={cx("ui-capacity-segment", `ui-slot-${segment.state}`)}
              data-slot={segment.state}
            >
              {body}
            </div>
          );
        })}
      </div>
    </div>
  );
}
