import { DISC, Glyph, type GlyphProps } from "./Glyph";

/**
 * A conversation or sandbox job that ended complete: a filled disc with the
 * check knocked out.
 * @param props - See {@link GlyphProps}; `label` defaults to "Complete".
 * @returns The glyph.
 */
export function CompleteGlyph({ label = "Complete", ...props }: GlyphProps) {
  return (
    <Glyph kind="complete" label={label} {...props}>
      <path
        fillRule="evenodd"
        fill="currentColor"
        d={`${DISC} M4.57 6.63 L6.1 8.17 L9.42 4.65 L10.58 5.75 L6.1 10.43 L3.43 7.77 Z`}
      />
    </Glyph>
  );
}
