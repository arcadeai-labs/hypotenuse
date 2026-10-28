import { Glyph, type GlyphProps } from "./Glyph";

/**
 * A conversation that is `working`, or a sandbox job that is running: a ring
 * with a quarter arc. The `ui-glyph-working` rule spins it slowly; reduced
 * motion stops it.
 * @param props - See {@link GlyphProps}; `label` defaults to "Working".
 * @returns The glyph.
 */
export function WorkingGlyph({ label = "Working", ...props }: GlyphProps) {
  return (
    <Glyph kind="working" label={label} {...props}>
      <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 7 L7 3.5 A3.5 3.5 0 0 1 10.5 7 Z" fill="currentColor" />
    </Glyph>
  );
}
