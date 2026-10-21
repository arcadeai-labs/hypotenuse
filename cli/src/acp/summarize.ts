/**
 * How an ACP tool call reads in Linear, where an action is one line: a verb
 * from its `kind`, a compact parameter (a path, a command, a query), and a
 * Markdown result capped at 2 KB — a diff summarized as `+12 −3 in src/a.ts`
 * with the diff itself folded away, terminal and text output as its last 20
 * lines.
 */
import { isAbsolute, relative } from "node:path";
import type { ToolCallContent, ToolKind } from "./connection";

/** The longest parameter, in characters. */
export const PARAMETER_MAX = 200;

/** The longest result, in bytes (roughly; characters are counted). */
export const RESULT_MAX = 2048;

/** Lines of output a result keeps. */
export const RESULT_LINES = 20;

/** In-progress and done verbs for each ACP tool kind. */
export const VERBS: Record<string, [string, string]> = {
  read: ["Reading", "Read"],
  edit: ["Editing", "Edited"],
  delete: ["Deleting", "Deleted"],
  move: ["Moving", "Moved"],
  search: ["Searching", "Searched"],
  execute: ["Running", "Ran"],
  think: ["Thinking", "Thought"],
  fetch: ["Fetching", "Fetched"],
  switch_mode: ["Switching mode", "Switched mode"],
};

/** What a tool call is known to be, merged from its updates. */
export interface ToolCallState {
  toolCallId: string;
  title: string;
  kind: ToolKind | null;
  status: "pending" | "in_progress" | "completed" | "failed";
  rawInput: unknown;
  rawOutput: unknown;
  content: ToolCallContent[];
  locations: { path: string; line?: number | null }[];
}

/**
 * Truncate to a length, marking the cut.
 * @param text - The text.
 * @param max - The most characters.
 * @returns The text, or its head and an ellipsis.
 */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * A path as the person reads it: relative to the worktree when inside it.
 * @param path - An absolute (or relative) path.
 * @param cwd - The worktree.
 * @returns The display path.
 */
export function displayPath(path: string, cwd: string): string {
  if (!isAbsolute(path)) return path;
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

/**
 * The verb for a tool call.
 * @param call - The tool call.
 * @param done - Finished (completed or failed) rather than under way.
 * @returns The verb, or the call's title for `other` and unknown kinds.
 */
export function verb(
  call: Pick<ToolCallState, "kind" | "title">,
  done: boolean,
): string {
  const pair = call.kind ? VERBS[call.kind] : undefined;
  const text = pair ? pair[done ? 1 : 0] : call.title.trim() || "Tool call";
  return truncate(text.replace(/\s+/g, " "), 255);
}

/**
 * A string field of an object, if it has one.
 * @param value - The object.
 * @param keys - Field names to try, in order.
 * @returns The first non-empty string.
 */
function field(value: unknown, keys: string[]): string | null {
  if (typeof value !== "object" || value === null) return null;
  for (const key of keys) {
    const v = (value as Record<string, unknown>)[key];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (Array.isArray(v) && v.every((x) => typeof x === "string") && v.length)
      return v.join(" ");
  }
  return null;
}

/**
 * The one-line parameter of an action.
 * @param call - The tool call.
 * @param cwd - The worktree.
 * @returns The parameter (never empty).
 */
export function compactParameter(call: ToolCallState, cwd: string): string {
  const firstPath = call.locations[0]?.path;
  let text: string | null = null;
  switch (call.kind) {
    case "read":
    case "edit":
    case "delete":
    case "move":
      text = firstPath
        ? displayPath(firstPath, cwd)
        : field(call.rawInput, ["path", "file_path", "filePath", "file"]);
      if (text) text = displayPath(text, cwd);
      break;
    case "execute":
      text = field(call.rawInput, ["command", "cmd", "commandLine"]);
      break;
    case "search":
    case "fetch":
      text = field(call.rawInput, ["query", "pattern", "url", "q"]);
      break;
    default:
      break;
  }
  if (!text && call.rawInput !== undefined && call.rawInput !== null) {
    const json = JSON.stringify(call.rawInput);
    if (json && json !== "{}") text = json;
  }
  if (!text) text = call.title.trim() || call.toolCallId;
  return truncate(text.replace(/[\r\n]+/g, " ").trim(), PARAMETER_MAX) || "…";
}

/**
 * Count added and removed lines between two texts (a line-set diff: good
 * enough for a one-line summary).
 * @param oldText - Before (null for a new file).
 * @param newText - After.
 * @returns Lines added and removed.
 */
export function diffStat(
  oldText: string | null | undefined,
  newText: string,
): { added: number; removed: number } {
  const before = oldText ? oldText.split("\n") : [];
  const after = newText.split("\n");
  if (before.at(-1) === "") before.pop();
  if (after.at(-1) === "") after.pop();
  // Longest common subsequence, bounded so a huge file stays cheap.
  if (before.length * after.length > 4_000_000) {
    return { added: after.length, removed: before.length };
  }
  const prev = new Array<number>(after.length + 1).fill(0);
  for (let i = 1; i <= before.length; i++) {
    let diag = 0;
    for (let j = 1; j <= after.length; j++) {
      const up = prev[j] as number;
      prev[j] =
        before[i - 1] === after[j - 1]
          ? diag + 1
          : Math.max(up, prev[j - 1] as number);
      diag = up;
    }
  }
  const common = prev[after.length] as number;
  return { added: after.length - common, removed: before.length - common };
}

/**
 * A unified-looking diff body for display.
 * @param oldText - Before.
 * @param newText - After.
 * @returns `-` and `+` lines.
 */
function diffBody(oldText: string | null | undefined, newText: string): string {
  const minus = (oldText ?? "")
    .split("\n")
    .filter((l, i, a) => i < a.length - 1 || l !== "")
    .map((l) => `-${l}`);
  const plus = newText
    .split("\n")
    .filter((l, i, a) => i < a.length - 1 || l !== "")
    .map((l) => `+${l}`);
  return [...minus, ...plus].join("\n");
}

/**
 * The last lines of some output, fenced.
 * @param text - The output.
 * @returns A fenced block of its last {@link RESULT_LINES} lines.
 */
function tail(text: string): string {
  const lines = text.replace(/\s+$/, "").split("\n");
  const kept = lines.slice(-RESULT_LINES);
  const fence = text.includes("```") ? "~~~" : "```";
  return `${fence}\n${kept.join("\n")}\n${fence}`;
}

/**
 * Cap a result, closing an open fence or collapsible section if the cut
 * lands inside one.
 * @param text - The Markdown.
 * @returns At most {@link RESULT_MAX} characters.
 */
export function capResult(text: string): string {
  if (text.length <= RESULT_MAX) return text;
  let cut = text.slice(0, RESULT_MAX - 40);
  cut = cut.slice(0, Math.max(cut.lastIndexOf("\n"), 0)) || cut;
  const fences = (cut.match(/^(```|~~~)/gm) ?? []).length;
  if (fences % 2 === 1) cut += `\n${cut.match(/^(```|~~~)/m)?.[0] ?? "```"}`;
  const sections = (cut.match(/^\+\+\+/gm) ?? []).length;
  if (sections % 2 === 1) cut += "\n+++";
  return `${cut}\n…`;
}

/**
 * The Markdown result of a finished tool call.
 * @param call - The tool call.
 * @param cwd - The worktree.
 * @returns The result, or undefined when there is nothing to show.
 */
export function compactResult(
  call: ToolCallState,
  cwd: string,
): string | undefined {
  const parts: string[] = [];
  for (const item of call.content) {
    if (item.type === "diff") {
      const { added, removed } = diffStat(item.oldText, item.newText);
      const path = displayPath(item.path, cwd);
      const body = diffBody(item.oldText, item.newText);
      parts.push(
        `+${added} −${removed} in ${path}\n\n+++ Diff\n\`\`\`diff\n${body}\n\`\`\`\n+++`,
      );
    } else if (item.type === "content") {
      const block = item.content;
      if (block.type === "text" && block.text.trim())
        parts.push(tail(block.text));
      else if (block.type === "resource_link")
        parts.push(`[${block.name}](${block.uri})`);
    } else if (item.type === "terminal") {
      parts.push(`Terminal \`${item.terminalId}\``);
    }
  }
  if (
    !parts.length &&
    call.rawOutput !== undefined &&
    call.rawOutput !== null
  ) {
    const text =
      typeof call.rawOutput === "string"
        ? call.rawOutput
        : (field(call.rawOutput, ["output", "stdout", "result", "text"]) ??
          JSON.stringify(call.rawOutput));
    if (text.trim()) parts.push(tail(text));
  }
  if (!parts.length) return undefined;
  return capResult(parts.join("\n\n"));
}

/**
 * The first line of a failed call's output.
 * @param call - The tool call.
 * @returns `Failed: <first line>`.
 */
export function failedResult(call: ToolCallState): string {
  let text = "";
  for (const item of call.content) {
    if (item.type === "content" && item.content.type === "text") {
      text = item.content.text;
      break;
    }
  }
  if (!text && call.rawOutput !== undefined && call.rawOutput !== null) {
    text =
      typeof call.rawOutput === "string"
        ? call.rawOutput
        : (field(call.rawOutput, ["error", "message", "output", "stderr"]) ??
          "");
  }
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  return first ? `Failed: ${truncate(first.trim(), 500)}` : "Failed";
}

/** Shapes of secrets that are redacted before any agent output is quoted. */
export const SECRET_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bsk_(?:live|test)_[A-Za-z0-9]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bhyp_(?:rt|cli)_[A-Za-z0-9_-]{16,}/g,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
];

/**
 * Replace anything shaped like a secret.
 * @param text - Text an agent wrote.
 * @returns The text with secrets as `[redacted]`.
 */
export function redact(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" && /^Bearer/i.test(match)
        ? `${prefix}[redacted]`
        : "[redacted]",
    );
  }
  return out;
}
