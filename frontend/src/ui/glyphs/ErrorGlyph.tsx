import { DISC, Glyph, type GlyphProps } from "./Glyph";

/**
 * Session status `error`: a filled disc with the cross knocked out.
 * @param props - See {@link GlyphProps}; `label` defaults to "Error".
 * @returns The glyph.
 */
export function ErrorGlyph({ label = "Error", ...props }: GlyphProps) {
  return (
    <Glyph kind="error" label={label} {...props}>
      <path
        fillRule="evenodd"
        fill="currentColor"
        d={`${DISC} M8.27 4.6 L9.4 5.73 L8.13 7 L9.4 8.27 L8.27 9.4 L7 8.13 L5.73 9.4 L4.6 8.27 L5.87 7 L4.6 5.73 L5.73 4.6 L7 5.87 Z`}
      />
    </Glyph>
  );
}
