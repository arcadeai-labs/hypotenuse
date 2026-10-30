import {
  CompleteGlyph,
  FailedGlyph,
  StaleGlyph,
  WaitingOnPersonGlyph,
} from "../../ui";
import { approvalStatusLabel } from "../../utils/mcp";

/**
 * An approval's status as a glyph: the ring with a centre dot while it waits
 * for a person — the same glyph as a conversation waiting on one — a check
 * once approved (and run), a cross when denied, and the faded dashed ring
 * when nobody decided in time.
 * @param props - The approval's `status`, and a `testId`.
 * @returns The glyph.
 */
export function ApprovalStatusGlyph({
  status,
  testId,
}: {
  status: string;
  testId?: string;
}) {
  const props = {
    label: approvalStatusLabel(status),
    "data-testid": testId,
    "data-status": status,
  };
  switch (status) {
    case "pending":
      return <WaitingOnPersonGlyph {...props} />;
    case "approved":
    case "consumed":
      return <CompleteGlyph {...props} />;
    case "denied":
      return <FailedGlyph {...props} />;
    default:
      return <StaleGlyph {...props} />;
  }
}
