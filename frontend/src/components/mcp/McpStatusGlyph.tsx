import {
  CompleteGlyph,
  FailedGlyph,
  StaleGlyph,
  WaitingOnPersonGlyph,
} from "../../ui";
import { mcpServerStatusLabel } from "../../utils/mcp";

/**
 * An MCP server's state as a glyph, in the status glyphs' shape language: a
 * disc with a check when its tools were listed, a disc with a cross when it
 * could not be reached, the ring with a centre dot when a person must sign it
 * in (a person is needed), and the faded dashed ring when an admin switched
 * it off. The label says it in words, so colour is never the only cue.
 * @param props - The server's `status` and `enabled`, and a `testId`.
 * @returns The glyph.
 */
export function McpStatusGlyph({
  status,
  enabled,
  testId,
}: {
  status: string;
  enabled: boolean;
  testId?: string;
}) {
  const label = mcpServerStatusLabel({ status, enabled });
  const props = {
    label,
    "data-testid": testId,
    "data-status": enabled ? status : "disabled",
  };
  if (!enabled) return <StaleGlyph {...props} />;
  if (status === "ok") return <CompleteGlyph {...props} />;
  if (status === "needs_auth") return <WaitingOnPersonGlyph {...props} />;
  return <FailedGlyph {...props} />;
}
