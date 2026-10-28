import { Glyph, type GlyphProps } from "./Glyph";

/**
 * A sandbox job that is still provisioning: a dotted ring.
 * @param props - See {@link GlyphProps}; `label` defaults to "Provisioning".
 * @returns The glyph.
 */
export function ProvisioningGlyph({
  label = "Provisioning",
  ...props
}: GlyphProps) {
  return (
    <Glyph kind="provisioning" label={label} {...props}>
      <circle
        cx="7"
        cy="7"
        r="5.25"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="0.1 2.65"
      />
    </Glyph>
  );
}
