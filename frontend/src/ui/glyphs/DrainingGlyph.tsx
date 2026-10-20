import { Glyph, type GlyphProps } from "./Glyph";

/**
 * Runner presence: a half dot — finishing its current work and taking no more.
 * @param props - See {@link GlyphProps}; `label` defaults to "Draining".
 * @returns The glyph.
 */
export function DrainingGlyph({ label = "Draining", ...props }: GlyphProps) {
  return (
    <Glyph kind="draining" label={label} {...props}>
      <circle cx="7" cy="7" r="3.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 3.75 A3.25 3.25 0 0 0 7 10.25 Z" fill="currentColor" />
    </Glyph>
  );
}
