import { Glyph, type GlyphProps } from "./Glyph";

/**
 * Session status `awaitingInput`: a ring with a centre dot — the agent asked a person something.
 * @param props - See {@link GlyphProps}; `label` defaults to "Waiting for input".
 * @returns The glyph.
 */
export function AwaitingInputGlyph({
  label = "Waiting for input",
  ...props
}: GlyphProps) {
  return (
    <Glyph kind="awaiting-input" label={label} {...props}>
      <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="7" cy="7" r="2" fill="currentColor" />
    </Glyph>
  );
}
