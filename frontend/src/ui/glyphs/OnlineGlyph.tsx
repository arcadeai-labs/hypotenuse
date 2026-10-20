import { Glyph, type GlyphProps } from "./Glyph";

/**
 * Runner presence: a solid dot — heartbeating and accepting work.
 * @param props - See {@link GlyphProps}; `label` defaults to "Online".
 * @returns The glyph.
 */
export function OnlineGlyph({ label = "Online", ...props }: GlyphProps) {
  return (
    <Glyph kind="online" label={label} {...props}>
      <circle cx="7" cy="7" r="4" fill="currentColor" />
    </Glyph>
  );
}
