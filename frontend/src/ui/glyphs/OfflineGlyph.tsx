import { Glyph, type GlyphProps } from "./Glyph";

/**
 * Runner presence: a hollow dot — no heartbeat.
 * @param props - See {@link GlyphProps}; `label` defaults to "Offline".
 * @returns The glyph.
 */
export function OfflineGlyph({ label = "Offline", ...props }: GlyphProps) {
  return (
    <Glyph kind="offline" label={label} {...props}>
      <circle cx="7" cy="7" r="3.25" stroke="currentColor" strokeWidth="1.5" />
    </Glyph>
  );
}
