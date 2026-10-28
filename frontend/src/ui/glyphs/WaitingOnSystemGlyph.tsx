import { Glyph, type GlyphProps } from "./Glyph";

/**
 * A conversation `waiting` on something that is not a person — a sandbox or a
 * timer: a ring with a small clock tick.
 * @param props - See {@link GlyphProps}; `label` defaults to "Waiting".
 * @returns The glyph.
 */
export function WaitingOnSystemGlyph({
  label = "Waiting",
  ...props
}: GlyphProps) {
  return (
    <Glyph kind="waiting-system" label={label} {...props}>
      <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M7 4 L7 7 L9.25 7"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Glyph>
  );
}
