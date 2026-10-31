import type { CodeRunList } from "@backend/actions/code-run/code-run-list";
import type { ActionResponse } from "keryx";
import { ChevronRight } from "lucide-react";
import { Fragment } from "react";
import { Link } from "react-router-dom";
import { FailedGlyph, StaleGlyph, WorkingGlyph } from "../../ui";
import { JsonBlock } from "../JsonBlock";
import type { TranscriptItem } from "./model";

/** One code run, as `code-run:list` answers it. */
export type CodeRunDetail = ActionResponse<CodeRunList>["codeRuns"][number];

/** What each run status says beside the call. */
const RUN_WORDS: Record<string, string> = {
  running: "running",
  interrupted: "waiting for approval",
  completed: "",
  failed: "failed",
  interrupted_by_crash: "interrupted",
};

/** Words the highlighter sets heavier. */
const KEYWORDS = new Set(
  "await async const let var return if else for of in while do try catch finally throw new function class interface type extends typeof instanceof as true false null undefined break continue switch case default".split(
    " ",
  ),
);

/** One run of highlighted text. */
interface Token {
  kind: "comment" | "string" | "keyword" | "number" | "global" | "plain";
  text: string;
}

/** The host API's globals, set apart from the program's own names. */
const GLOBALS = new Set(["memory", "mcp", "largeResult", "console"]);

/**
 * Split a program into tokens to set apart: comments, strings, keywords,
 * numbers, and the host API's globals. A display aid, not a parser — what it
 * misses stays plain text.
 * @param source - The program.
 * @returns The tokens, in order, joining back to the source.
 */
export function tokenize(source: string): Token[] {
  const pattern =
    /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g;
  const out: Token[] = [];
  let last = 0;
  for (const m of source.matchAll(pattern)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ kind: "plain", text: source.slice(last, at) });
    const [text, comment, string, number, word] = m;
    out.push({
      kind: comment
        ? "comment"
        : string
          ? "string"
          : number
            ? "number"
            : word && KEYWORDS.has(word)
              ? "keyword"
              : word && GLOBALS.has(word)
                ? "global"
                : "plain",
      text,
    });
    last = at + text.length;
  }
  if (last < source.length)
    out.push({ kind: "plain", text: source.slice(last) });
  return out;
}

/**
 * A program's source, set in monospace with comments, strings, keywords, and
 * the host API told apart by weight and tone — no colour is spent on syntax.
 * @param props.source - The program.
 * @returns The block.
 */
export function CodeSource({ source }: { source: string }) {
  return (
    <figure className="json-block" data-testid="code-run-source">
      <figcaption className="json-block-label">Program</figcaption>
      <pre className="json-block-body code-source">
        <code>
          {tokenize(source).map((t, i) =>
            t.kind === "plain" ? (
              <Fragment key={i}>{t.text}</Fragment>
            ) : (
              <span key={i} className={`code-tok code-tok-${t.kind}`}>
                {t.text}
              </span>
            ),
          )}
        </code>
      </pre>
    </figure>
  );
}

/**
 * The journal of a run's host calls: what each called, how the gate let it
 * through, and how it went. Sizes and timings only — never payloads.
 * @param props.run - The run.
 * @returns The table, or nothing when it called nothing.
 */
function HostCalls({ run }: { run: CodeRunDetail }) {
  if (run.hostCalls.length === 0) return null;
  return (
    <figure className="json-block" data-testid="code-run-host-calls">
      <figcaption className="json-block-label">
        Host calls ({run.hostCalls.length})
      </figcaption>
      <table className="code-host-calls">
        <tbody>
          {run.hostCalls.map((h, i) => (
            <tr key={i} data-ok={h.ok ? "true" : "false"}>
              <td className="code-host-fn">{h.fn}</td>
              <td className="code-host-name">{h.name ?? ""}</td>
              <td className="code-host-gate">
                {h.gate === "approved" && h.approvalId ? (
                  <Link to={`/approvals/${h.approvalId}`}>approved</Link>
                ) : h.gate === "denied" && h.approvalId ? (
                  <Link to={`/approvals/${h.approvalId}`}>denied</Link>
                ) : (
                  (h.gate ?? "")
                )}
              </td>
              <td className="code-host-result">
                {h.ok ? "ok" : (h.errorType ?? "error")}
              </td>
              <td className="code-host-ms tabular">{h.ms} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/**
 * The approvals a paused program waits on, each linking to where someone who
 * may decide it does.
 * @param props.run - The run.
 * @returns The list, or nothing.
 */
function RunApprovals({ run }: { run: CodeRunDetail }) {
  const pending = run.approvals.filter((a) => a.status === "pending");
  if (pending.length === 0) return null;
  return (
    <ul className="code-run-approvals" data-testid="code-run-approvals">
      {pending.map((a) => (
        <li key={a.id}>
          Waiting for approval to run <code>{a.name}</code> —{" "}
          <Link to={`/approvals/${a.id}`}>decide</Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * A `run_code` call: a row naming the program's first line and how it
 * ended, opening to the program, its result or error, what it logged, the
 * journal of its host calls with their gate decisions, and — while it is
 * paused — the approvals it waits on.
 * @param props.item - The call.
 * @param props.run - Its run, when read.
 * @returns The row.
 */
export function CodeRunCall({
  item,
  run,
}: {
  item: Extract<TranscriptItem, { kind: "tool" }>;
  run: CodeRunDetail | undefined;
}) {
  const source = String((item.input as { source?: unknown }).source ?? "");
  const firstLine =
    source
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const output = (item.output ?? null) as Record<string, unknown> | null;
  const status = run?.status ?? (item.status === "running" ? "running" : null);
  const failed = item.status === "error";
  const words =
    status === "interrupted" && !output
      ? RUN_WORDS.interrupted
      : failed
        ? String(output?.error_type ?? "failed")
        : item.status === "interrupted"
          ? "interrupted"
          : status
            ? RUN_WORDS[status]
            : "";
  const consoleLines = Array.isArray(output?.console)
    ? (output.console as string[])
    : [];
  const result =
    output && !failed
      ? "result" in output
        ? output.result
        : "path" in output
          ? {
              savedTo: output.path,
              versionId: output.versionId,
              bytesWritten: output.bytesWritten,
            }
          : output
      : undefined;
  return (
    <details
      className="tx-call"
      data-status={item.status}
      data-testid="tx-code-run"
      data-tool="run_code"
    >
      <summary className="tx-action tx-call-summary">
        {item.status === "running" ? (
          <WorkingGlyph label="Running" />
        ) : item.status === "interrupted" ||
          (item.status === "unsettled" && status !== "interrupted") ? (
          <StaleGlyph label="Interrupted" />
        ) : failed ? (
          <FailedGlyph label="Failed" />
        ) : (
          <ChevronRight size={14} aria-hidden className="tx-chevron" />
        )}
        <span className="tx-verb">run_code</span>
        {firstLine && <code className="tx-parameter">{firstLine}</code>}
        {words && (
          <span className="tx-call-status" data-testid="tx-tool-status">
            {words}
          </span>
        )}
        {run?.durationMs != null && (
          <span className="tx-duration tabular">
            {(run.durationMs / 1000).toFixed(1)}s
          </span>
        )}
      </summary>
      <div className="tx-call-detail">
        {run && <RunApprovals run={run} />}
        <CodeSource source={source} />
        {failed && output && (
          <p className="tx-call-note" data-testid="code-run-error">
            <strong>{String(output.error_type)}</strong>:{" "}
            {String(output.message ?? "")}
          </p>
        )}
        {result !== undefined && (
          <JsonBlock value={result} label="Result" testId="code-run-result" />
        )}
        {consoleLines.length > 0 && (
          <figure className="json-block" data-testid="code-run-console">
            <figcaption className="json-block-label">Console</figcaption>
            <pre className="json-block-body">{consoleLines.join("\n")}</pre>
          </figure>
        )}
        {run && <HostCalls run={run} />}
      </div>
    </details>
  );
}
