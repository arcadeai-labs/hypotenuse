import { ChevronRight } from "lucide-react";
import { Link } from "react-router-dom";
import { FailedGlyph, StaleGlyph, WorkingGlyph } from "../../ui";
import {
  isLiveJob,
  jobStatusLabel,
  type SandboxJobRow,
  sandboxStartJobId,
  usageWords,
} from "../../utils/sandboxJobs";
import { MarkdownBlock } from "../MarkdownBlock";
import { SandboxJobStatusGlyph } from "../sandboxes/SandboxJobStatusGlyph";
import type { TranscriptItem } from "./model";

/**
 * A `sandbox_start` or `sandbox_wait` call: a row naming the job's title and
 * where it is now, opening to the task the bot wrote, what the agent last
 * reported, how it ended, and a link to the job's own page — its questions,
 * artifacts, and full transcript. A `sandbox_wait` row says the bot ended its
 * turn waiting on the job. Before the call has a job (it waits on an
 * approval, say) it reads like any other call.
 * @param props.item - The call.
 * @param props.job - Its job, when read.
 * @returns The row.
 */
export function SandboxStartCall({
  item,
  job,
}: {
  item: Extract<TranscriptItem, { kind: "tool" }>;
  job: SandboxJobRow | undefined;
}) {
  const input = (item.input ?? {}) as { title?: unknown; task?: unknown };
  const output = (item.output ?? null) as { note?: unknown } | null;
  const jobId = sandboxStartJobId(item.output);
  const title =
    job?.title ?? (typeof input.title === "string" ? input.title : "");
  const task = job?.task ?? (typeof input.task === "string" ? input.task : "");
  const words = job
    ? jobStatusLabel(job.status)
    : item.status === "running"
      ? "starting"
      : item.status === "error"
        ? "error"
        : item.status === "interrupted"
          ? "interrupted"
          : jobId === null
            ? "no job yet"
            : "";
  return (
    <details
      className="tx-call"
      data-status={item.status}
      data-job-status={job?.status}
      data-testid="tx-sandbox-job"
      data-tool={item.toolName}
    >
      <summary className="tx-action tx-call-summary">
        {job ? (
          <SandboxJobStatusGlyph status={job.status} />
        ) : item.status === "running" ? (
          <WorkingGlyph label="Running" />
        ) : item.status === "interrupted" || item.status === "unsettled" ? (
          <StaleGlyph label="Interrupted" />
        ) : item.status === "error" ? (
          <FailedGlyph label="Error" />
        ) : (
          <ChevronRight size={14} aria-hidden className="tx-chevron" />
        )}
        <span className="tx-verb">
          {item.toolName === "sandbox_wait" ? "waits on sandbox" : "sandbox"}
        </span>
        {title && <span className="tx-parameter">{title}</span>}
        {words && (
          <span className="tx-call-status" data-testid="tx-sandbox-status">
            {words}
          </span>
        )}
        {job && (
          <span className="tx-duration tabular">
            {usageWords(job.usage, job.budgetTokens)}
          </span>
        )}
      </summary>
      <div className="tx-call-detail">
        {jobId !== null && (
          <p className="tx-call-note">
            <Link to={`/sandboxes/${jobId}`} data-testid="tx-sandbox-link">
              Open job #{jobId}
            </Link>
            {job && isLiveJob(job.status)
              ? " — its questions, messages, and live transcript."
              : " — its artifacts and full transcript."}
          </p>
        )}
        {typeof output?.note === "string" && !job && (
          <p className="tx-call-note">{output.note}</p>
        )}
        {task && item.toolName === "sandbox_start" && (
          <figure className="json-block">
            <figcaption className="json-block-label">Task</figcaption>
            <div className="json-block-body sandbox-task">
              <MarkdownBlock>{task}</MarkdownBlock>
            </div>
          </figure>
        )}
        {job?.statusMessage && (
          <p className="tx-call-note" data-testid="tx-sandbox-reported">
            Last reported: {job.statusMessage}
          </p>
        )}
        {job?.closingText && (
          <figure className="json-block">
            <figcaption className="json-block-label">
              What it said at the end
            </figcaption>
            <div className="json-block-body sandbox-task">
              <MarkdownBlock>{job.closingText}</MarkdownBlock>
            </div>
          </figure>
        )}
        {job && Object.keys(job.artifacts ?? {}).length > 0 && (
          <p className="tx-call-note">
            Artifacts: {Object.keys(job.artifacts).join(", ")}
          </p>
        )}
        {job?.error && (
          <p className="tx-call-note" data-testid="tx-sandbox-error">
            {job.error}
          </p>
        )}
      </div>
    </details>
  );
}
