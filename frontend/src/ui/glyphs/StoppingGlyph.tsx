import { Glyph, type GlyphProps } from "./Glyph";

/**
 * Session status `stopping`: a ring around a small square — a stop was asked for and is in flight.
 * @param props - See {@link GlyphProps}; `label` defaults to "Stopping".
 * @returns The glyph.
 */
export function StoppingGlyph({ label = "Stopping", ...props }: GlyphProps) {
  return (
    <Glyph kind="stopping" label={label} {...props}>
      <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.5" />
      <rect x="5" y="5" width="4" height="4" rx="0.5" fill="currentColor" />
    </Glyph>
  );
}
