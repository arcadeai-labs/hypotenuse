import { createHash } from "node:crypto";
import type { McpCatalogTool } from "../schema/mcp_servers";

/**
 * The approval gate's pure half: allowlist patterns, the call key, and the
 * decision table's first two columns. No I/O, so the catalog, the gate, and
 * the dashboard's pattern preview all answer the same way.
 */

/** The longest pattern accepted, and the longest `/regex/` body. */
export const MAX_PATTERN_CHARS = 200;

/**
 * Whether a pattern is well formed: `server/tool`, `server/*`, `*\/tool`, a
 * bare `tool`, or `/regex/` (a valid JavaScript regular expression, matched
 * against `server/tool`).
 * @param pattern - The pattern.
 * @returns A sentence naming what is wrong, or `null`.
 */
export function patternProblem(pattern: string): string | null {
  if (pattern.length === 0) return "A pattern cannot be empty.";
  if (pattern.length > MAX_PATTERN_CHARS)
    return `A pattern is at most ${MAX_PATTERN_CHARS} characters.`;
  if (pattern.length > 1 && pattern.startsWith("/") && pattern.endsWith("/")) {
    try {
      new RegExp(pattern.slice(1, -1));
      return null;
    } catch {
      return `${pattern} is not a valid regular expression.`;
    }
  }
  const parts = pattern.split("/");
  if (parts.length > 2 || parts.some((p) => p.length === 0))
    return `${pattern} is not server/tool, server/*, */tool, a bare tool name, or /regex/.`;
  return null;
}

/**
 * Whether a pattern matches a call.
 *
 * | Pattern | Matches |
 * |---|---|
 * | `server/tool` | that tool of that server |
 * | `server/*` | every tool of that server |
 * | `*\/tool` | that tool name on any server |
 * | `tool` | that tool name on any server |
 * | `/regex/` | any `server/tool` the expression finds |
 * @param pattern - The pattern.
 * @param server - The server's name.
 * @param tool - The tool's name.
 * @returns `true` on a match.
 */
export function matchPattern(
  pattern: string,
  server: string,
  tool: string,
): boolean {
  if (pattern.length > 1 && pattern.startsWith("/") && pattern.endsWith("/")) {
    try {
      return new RegExp(pattern.slice(1, -1)).test(`${server}/${tool}`);
    } catch {
      return false;
    }
  }
  const slash = pattern.indexOf("/");
  if (slash === -1) return pattern === tool;
  const s = pattern.slice(0, slash);
  const t = pattern.slice(slash + 1);
  return (s === "*" || s === server) && (t === "*" || t === tool);
}

/**
 * Whether any of a bot's patterns allows a call.
 * @param patterns - The bot's `allowedTools` for that server.
 * @param server - The server's name.
 * @param tool - The tool's name.
 * @returns The first matching pattern, or `null`.
 */
export function allowingPattern(
  patterns: string[],
  server: string,
  tool: string,
): string | null {
  return patterns.find((p) => matchPattern(p, server, tool)) ?? null;
}

/**
 * JSON with object keys sorted at every depth, so equal arguments give equal
 * text whatever order the model wrote them in.
 * @param value - Any JSON value.
 * @returns The canonical text.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/**
 * The key that binds an approval to one call:
 * `sha256(server + "/" + tool + "\n" + canonicalJson(args))`.
 * @param server - The server's name.
 * @param tool - The tool's name.
 * @param args - The arguments.
 * @returns The hex digest.
 */
export function callKey(
  server: string,
  tool: string,
  args: Record<string, unknown>,
): string {
  return createHash("sha256")
    .update(`${server}/${tool}\n${canonicalJson(args)}`)
    .digest("hex");
}

/** Why a call may run without a person, or that it may not. */
export type Allowance =
  | { allowed: true; via: "pattern"; pattern: string }
  | { allowed: true; via: "read-only" }
  | { allowed: false };

/**
 * The gate's first two columns: allowlisted by pattern, or read-only with
 * `autoAllowReadOnly` on. Anything else needs a person.
 * @param binding - The bot's patterns and read-only setting for the server.
 * @param server - The server's name.
 * @param tool - The cached tool.
 * @returns Whether it may run unasked, and why.
 */
export function allowance(
  binding: { allowedTools: string[]; autoAllowReadOnly: boolean },
  server: string,
  tool: Pick<McpCatalogTool, "name" | "annotations">,
): Allowance {
  const pattern = allowingPattern(binding.allowedTools, server, tool.name);
  if (pattern) return { allowed: true, via: "pattern", pattern };
  if (binding.autoAllowReadOnly && tool.annotations?.readOnlyHint === true)
    return { allowed: true, via: "read-only" };
  return { allowed: false };
}
