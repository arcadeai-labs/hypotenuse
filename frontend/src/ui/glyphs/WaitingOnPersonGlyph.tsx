import { Glyph, type GlyphProps } from "./Glyph";

/**
 * A conversation `waiting` on a person — an answer or an approval: a ring with
 * a centre dot.
 * @param props - See {@link GlyphProps}; `label` defaults to "Waiting for a person".
 * @returns The glyph.
 */
export function WaitingOnPersonGlyph({
  label = "Waiting for a person",
  ...props
}: GlyphProps) {
  return (
    <Glyph kind="waiting-person" label={label} {...props}>
      <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7" cy="7" r="2" fill="currentColor" />
    </Glyph>
  );
}
