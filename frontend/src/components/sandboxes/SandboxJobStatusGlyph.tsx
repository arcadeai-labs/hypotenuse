import { GLYPH_COMPONENTS } from "../../ui";
import { jobGlyphKind, jobStatusLabel } from "../../utils/sandboxJobs";

/**
 * The glyph for a sandbox job's status, labelled with it for assistive
 * technology: rings while it is alive, discs once it has ended.
 * @param props.status - The job's status, as the server reports it.
 * @returns The glyph.
 */
export function SandboxJobStatusGlyph({ status }: { status: string }) {
  const Shape = GLYPH_COMPONENTS[jobGlyphKind(status)];
  return <Shape label={jobStatusLabel(status)} />;
}
