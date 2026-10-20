import { Glyph, type GlyphProps } from "./Glyph";

/**
 * Session status `active`: a ring with a quarter arc. The `ui-glyph-active` rule spins it slowly; reduced motion stops it.
 * @param props - See {@link GlyphProps}; `label` defaults to "Active".
 * @returns The glyph.
 */
export function ActiveGlyph({ label = "Active", ...props }: GlyphProps) {
  return (
    <Glyph kind="active" label={label} {...props}>
      <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 7 L7 3.5 A3.5 3.5 0 0 1 10.5 7 Z" fill="currentColor" />
    </Glyph>
  );
}
