import { Glyph, type GlyphProps } from "./Glyph";

/**
 * Session status `stale`: a dashed, faded ring — Linear stopped hearing from the agent.
 * @param props - See {@link GlyphProps}; `label` defaults to "Stale".
 * @returns The glyph.
 */
export function StaleGlyph({ label = "Stale", ...props }: GlyphProps) {
  return (
    <Glyph kind="stale" label={label} {...props}>
      <circle
        cx="7"
        cy="7"
        r="5.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeDasharray="2.5 2"
      />
    </Glyph>
  );
}
