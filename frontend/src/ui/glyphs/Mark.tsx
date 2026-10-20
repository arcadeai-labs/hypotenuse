import { Glyph, type GlyphProps } from "./Glyph";

/**
 * The mark, `◢`: a right triangle whose hypotenuse runs from Linear (top right)
 * to your machine (bottom left). One colour, `currentColor`, so the same shape
 * serves the sidebar, the favicon, and the transcript's agent lines.
 * @param props - See {@link GlyphProps}; `label` defaults to "Hypotenuse".
 * @returns The mark.
 */
export function Mark({ label = "Hypotenuse", ...props }: GlyphProps) {
  return (
    <Glyph kind="mark" label={label} {...props}>
      <path d="M13 1 L13 13 L1 13 Z" fill="currentColor" />
    </Glyph>
  );
}
