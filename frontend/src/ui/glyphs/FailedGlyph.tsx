import { DISC, Glyph, type GlyphProps } from "./Glyph";

/**
 * A conversation or sandbox job that ended in failure: a filled disc with a
 * cross knocked out of it.
 * @param props - See {@link GlyphProps}; `label` defaults to "Failed".
 * @returns The glyph.
 */
export function FailedGlyph({ label = "Failed", ...props }: GlyphProps) {
  return (
    <Glyph kind="failed" label={label} {...props}>
      <path
        fillRule="evenodd"
        fill="currentColor"
        d={`${DISC} M8.27 4.6 L9.4 5.73 L8.13 7 L9.4 8.27 L8.27 9.4 L7 8.13 L5.73 9.4 L4.6 8.27 L5.87 7 L4.6 5.73 L5.73 4.6 L7 5.87 Z`}
      />
    </Glyph>
  );
}
