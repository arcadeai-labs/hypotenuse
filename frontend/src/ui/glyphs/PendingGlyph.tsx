import { Glyph, type GlyphProps } from "./Glyph";

/**
 * Session status `pending`: a dotted ring — queued, nothing has run yet.
 * @param props - See {@link GlyphProps}; `label` defaults to "Pending".
 * @returns The glyph.
 */
export function PendingGlyph({ label = "Pending", ...props }: GlyphProps) {
  return (
    <Glyph kind="pending" label={label} {...props}>
      <circle
        cx="7"
        cy="7"
        r="5.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="0.1 2.65"
      />
    </Glyph>
  );
}
