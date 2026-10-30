import { cx } from "../../ui/cx";

/** See {@link DecayMeter}. */
export interface DecayMeterProps {
  /** How much weight the memory still carries, 0–1. */
  freshness: number;
  /**
   * `bar` is a short track; `glyph` is a ring whose arc shrinks as the memory
   * fades. Which one the memory explorer keeps is still open; the style guide
   * shows both.
   */
  variant?: "bar" | "glyph";
  /** What hovering it says; the percentage when omitted. */
  title?: string;
}

/**
 * How faded a memory is. Announced as a percentage, so the shape is never the
 * only cue.
 * @param props - See {@link DecayMeterProps}.
 * @returns The meter.
 */
export function DecayMeter({
  freshness,
  variant = "bar",
  title,
}: DecayMeterProps) {
  const clamped = Math.min(1, Math.max(0, freshness));
  const percent = Math.round(clamped * 100);
  const label = `${percent}% fresh`;
  if (variant === "glyph") {
    // A 14-unit ring; the arc's length is the freshness.
    const circumference = 2 * Math.PI * 5.25;
    return (
      <svg
        className="decay-glyph"
        width={14}
        height={14}
        viewBox="0 0 14 14"
        role="img"
        aria-label={label}
        data-freshness={percent}
      >
        <circle className="decay-glyph-track" cx="7" cy="7" r="5.25" />
        <circle
          className="decay-glyph-fill"
          cx="7"
          cy="7"
          r="5.25"
          strokeDasharray={`${circumference * clamped} ${circumference}`}
          transform="rotate(-90 7 7)"
        />
      </svg>
    );
  }
  return (
    <span
      className={cx("decay-bar", percent < 34 && "is-faded")}
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-label={label}
      title={title ?? label}
    >
      <span className="decay-bar-fill" style={{ width: `${percent}%` }} />
    </span>
  );
}
