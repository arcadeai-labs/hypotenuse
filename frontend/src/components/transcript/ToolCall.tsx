import { ChevronRight } from "lucide-react";
import { FailedGlyph, StaleGlyph, WorkingGlyph } from "../../ui";
import { JsonBlock } from "../JsonBlock";
import { oneLine, type TranscriptItem } from "./model";

/** What each call status says beside the tool's name. */
const STATUS_WORDS: Record<string, string | null> = {
  running: "running",
  unsettled: "no result yet",
  ok: null,
  error: "error",
  interrupted: "interrupted",
};

/**
 * One tool call, collapsed to a row: the tool, its input on one line, and
 * how it ended. Opening it shows the input and the result in full. A call
 * still running spins; one recovery settled as interrupted — it may or may
 * not have run — is marked with the faded dashed ring and says so.
 * @param props.item - The call.
 * @returns The row.
 */
export function ToolCall({
  item,
}: {
  item: Extract<TranscriptItem, { kind: "tool" }>;
}) {
  const parameter = oneLine(item.input);
  const words = STATUS_WORDS[item.status];
  return (
    <details
      className="tx-call"
      data-status={item.status}
      data-testid="tx-tool-call"
      data-tool={item.toolName}
    >
      <summary className="tx-action tx-call-summary">
        {item.status === "running" ? (
          <WorkingGlyph label="Running" />
        ) : item.status === "interrupted" || item.status === "unsettled" ? (
          <StaleGlyph
            label={
              item.status === "interrupted" ? "Interrupted" : "No result yet"
            }
          />
        ) : item.status === "error" ? (
          <FailedGlyph label="Error" />
        ) : (
          <ChevronRight size={14} aria-hidden className="tx-chevron" />
        )}
        <span className="tx-verb">{item.toolName}</span>
        {parameter && <code className="tx-parameter">{parameter}</code>}
        {words && (
          <span className="tx-call-status" data-testid="tx-tool-status">
            {words}
          </span>
        )}
        {item.durationMs !== null && (
          <span className="tx-duration tabular">
            {(item.durationMs / 1000).toFixed(1)}s
          </span>
        )}
      </summary>
      <div className="tx-call-detail">
        {item.status === "interrupted" && (
          <p className="tx-call-note" data-testid="tx-interrupted-note">
            The conversation stopped while this call was in flight, so it may or
            may not have run.{" "}
            {item.replay === "safe"
              ? "It is safe to run again."
              : "It is not run again on its own."}
          </p>
        )}
        <JsonBlock value={item.input} label="Input" />
        <JsonBlock
          value={item.output ?? null}
          label={item.status === "running" ? "Result (running)" : "Result"}
        />
      </div>
    </details>
  );
}
