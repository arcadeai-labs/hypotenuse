import { CompleteGlyph, FailedGlyph, ProvisioningGlyph } from "../../ui";
import { connectionStatusLabel } from "../../utils/models";

/**
 * A model connection's last probe as a glyph, in the status glyphs' shape
 * language: a dotted ring while it has never been tested (or its key or URL
 * changed since), a disc with a check when the key worked, a disc with a cross
 * when it did not. The shape carries the meaning, so colour is never the only
 * cue; the label says it in words.
 * @param props - The connection's `status`, and a `testId` for the glyph.
 * @returns The glyph.
 */
export function ConnectionStatusGlyph({
  status,
  testId,
}: {
  status: string;
  testId?: string;
}) {
  const label = connectionStatusLabel(status);
  const props = { label, "data-testid": testId, "data-status": status };
  if (status === "ok") return <CompleteGlyph {...props} />;
  if (status === "error") return <FailedGlyph {...props} />;
  return <ProvisioningGlyph {...props} />;
}
