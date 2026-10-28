import { Glyph, type GlyphProps } from "./Glyph";

/**
 * A conversation that is `hibernating` — the normal rest state, so a calm
 * hollow ring rather than anything that reads as stale.
 * @param props - See {@link GlyphProps}; `label` defaults to "Hibernating".
 * @returns The glyph.
 */
export function HibernatingGlyph({
  label = "Hibernating",
  ...props
}: GlyphProps) {
  return (
    <Glyph kind="hibernating" label={label} {...props}>
      <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.5" />
    </Glyph>
  );
}
