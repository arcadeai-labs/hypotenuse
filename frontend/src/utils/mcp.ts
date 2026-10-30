/**
 * Pure helpers for the MCP servers settings, a bot's Tools section, and the
 * approvals inbox. Nothing here calls the API; the pages do, and these turn
 * what the server answered into what a person reads.
 */

/** How an MCP server authenticates, as `mcp-server:create` takes it. */
export type McpAuthMode = "none" | "headers" | "bearer" | "oauth";

/** One auth mode the connect form offers. */
export interface AuthModeOption {
  mode: McpAuthMode;
  label: string;
  /** What the mode needs, said under the select. */
  hint: string;
}

/** The connect form's auth modes, in the order the select lists them. */
export const AUTH_MODE_OPTIONS: readonly AuthModeOption[] = [
  {
    mode: "none",
    label: "None",
    hint: "The server takes requests without credentials.",
  },
  {
    mode: "bearer",
    label: "Bearer token",
    hint: "Sent as Authorization: Bearer on every request.",
  },
  {
    mode: "headers",
    label: "Headers",
    hint: "Static headers sent on every request, such as an API key.",
  },
  {
    mode: "oauth",
    label: "OAuth",
    hint: "An admin signs the project in after it is connected. A client id is only needed when the server does not register clients itself.",
  },
];

/**
 * The option for an auth mode, falling back to the first.
 * @param mode - The mode.
 * @returns Its option.
 */
export function authModeOption(mode: string): AuthModeOption {
  return (
    AUTH_MODE_OPTIONS.find((o) => o.mode === mode) ??
    (AUTH_MODE_OPTIONS[0] as AuthModeOption)
  );
}

/** One row of the headers editor, as typed. */
export interface HeaderRow {
  name: string;
  value: string;
}

/** A header name the HTTP grammar accepts: a token. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Turn the headers editor's rows into what `mcp-server:create` takes. Blank
 * rows are dropped; a row with only one half, a name HTTP would refuse, or a
 * name given twice is a problem the form says before sending.
 * @param rows - The rows as typed.
 * @returns The headers, or the first problem in words.
 */
export function headersFromRows(
  rows: readonly HeaderRow[],
): { headers: Record<string, string> } | { problem: string } {
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value;
    if (!name && !value.trim()) continue;
    if (!name) return { problem: "Every header needs a name." };
    if (!HEADER_NAME.test(name))
      return { problem: `${name} is not a valid header name.` };
    if (!value.trim()) return { problem: `The ${name} header needs a value.` };
    const key = name.toLowerCase();
    if (seen.has(key)) return { problem: `${name} is given twice.` };
    seen.add(key);
    headers[name] = value;
  }
  if (seen.size === 0) return { problem: "Add at least one header." };
  return { headers };
}

/**
 * What a server's credentials are, in words that never hold one: the header
 * names, the bearer token's last four, or whether OAuth is signed in.
 * @param server - The server as `mcp-server:list` serializes it.
 * @returns The sentence.
 */
export function credentialSummary(server: {
  authMode: string;
  headerNames: string[] | null;
  lastFour: string | null;
  signedIn: boolean | null;
}): string {
  switch (server.authMode) {
    case "bearer":
      return server.lastFour ? `Bearer ••••${server.lastFour}` : "Bearer token";
    case "headers": {
      const names = server.headerNames ?? [];
      return names.length > 0 ? `Headers: ${names.join(", ")}` : "Headers";
    }
    case "oauth":
      return server.signedIn ? "OAuth, signed in" : "OAuth, not signed in";
    default:
      return "No credentials";
  }
}

/**
 * A server's status in words, with being switched off first: a disabled
 * server is offered to no bot whatever its last probe said.
 * @param server - Its `status` and `enabled`.
 * @returns "Connected", "Needs sign-in", ….
 */
export function mcpServerStatusLabel(server: {
  status: string;
  enabled: boolean;
}): string {
  if (!server.enabled) return "Disabled";
  switch (server.status) {
    case "ok":
      return "Connected";
    case "needs_auth":
      return "Needs sign-in";
    case "error":
      return "Could not connect";
    default:
      return server.status;
  }
}

/**
 * The words for how many tools a server lists.
 * @param count - The count.
 * @returns "1 tool", "4 tools".
 */
export function toolCountLabel(count: number): string {
  return `${count} tool${count === 1 ? "" : "s"}`;
}

/** The annotations MCP defines, as a server claims them. */
export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

/** One annotation chip: what it says, and whether it is a caution. */
export interface AnnotationChip {
  key: string;
  label: string;
  caution: boolean;
}

/**
 * The chips a tool's annotations draw. Only hints the server actually set are
 * drawn; an absent hint says nothing, which is different from `false`.
 * @param annotations - The tool's annotations.
 * @returns The chips, read-only first.
 */
export function annotationChips(
  annotations: ToolAnnotations | null | undefined,
): AnnotationChip[] {
  const a = annotations ?? {};
  const chips: AnnotationChip[] = [];
  if (a.readOnlyHint === true)
    chips.push({ key: "read-only", label: "Read-only", caution: false });
  if (a.destructiveHint === true)
    chips.push({ key: "destructive", label: "Destructive", caution: true });
  if (a.idempotentHint === true)
    chips.push({ key: "idempotent", label: "Idempotent", caution: false });
  if (a.openWorldHint === true)
    chips.push({ key: "open-world", label: "Open world", caution: false });
  return chips;
}

/**
 * Split the allowlist editor's text into patterns: one per line (commas too),
 * trimmed, blank ones dropped, each kept once in the order first written.
 * @param text - The editor's text.
 * @returns The patterns.
 */
export function parsePatterns(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[\n,]/)) {
    const p = raw.trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Whether two pattern lists say the same thing, in the same order.
 * @param a - One list.
 * @param b - The other.
 * @returns `true` when equal.
 */
export function samePatterns(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((p, i) => p === b[i]);
}

/** Why a tool runs without a person, or that it waits. */
export type ToolAllowance =
  | { runs: true; via: "pattern"; pattern: string }
  | { runs: true; via: "read-only" }
  | { runs: false };

/**
 * What the gate would decide for each of a server's tools, from the patterns'
 * matches (`mcp-server:match-tools`, which answers with the server's own
 * matcher) and the read-only setting — the same two columns the gate reads.
 * @param tools - The server's tools, named `server/tool`, with annotations.
 * @param matches - `match-tools`' `matches`.
 * @param autoAllowReadOnly - Whether read-only tools run unasked.
 * @returns Each tool's name and allowance, in the tools' order.
 */
export function previewAllowances(
  tools: readonly { name: string; annotations?: ToolAnnotations | null }[],
  matches: readonly { pattern: string; tools: string[] }[],
  autoAllowReadOnly: boolean,
): { name: string; allowance: ToolAllowance }[] {
  return tools.map((tool) => {
    const hit = matches.find((m) => m.tools.includes(tool.name));
    if (hit)
      return {
        name: tool.name,
        allowance: { runs: true, via: "pattern", pattern: hit.pattern },
      };
    if (autoAllowReadOnly && tool.annotations?.readOnlyHint === true)
      return { name: tool.name, allowance: { runs: true, via: "read-only" } };
    return { name: tool.name, allowance: { runs: false } };
  });
}

/** An approval's statuses, as the server names them. */
export const APPROVAL_STATUSES = [
  "pending",
  "approved",
  "denied",
  "expired",
  "consumed",
] as const;

/** One approval status. */
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/**
 * An approval's status in words.
 * @param status - The server's status.
 * @returns "Waiting", "Approved", ….
 */
export function approvalStatusLabel(status: string): string {
  switch (status) {
    case "pending":
      return "Waiting for a decision";
    case "approved":
      return "Approved";
    case "denied":
      return "Denied";
    case "expired":
      return "Expired";
    case "consumed":
      return "Approved and run";
    default:
      return status;
  }
}

/**
 * A duration in the largest whole unit that fits, for "expires in" and the
 * approval expiry: "45 seconds", "3 minutes", "2 hours", "7 days".
 * @param ms - The duration in milliseconds; negative is treated as zero.
 * @returns The words.
 */
export function durationWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const unit = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  if (s < 60) return unit(s, "second");
  const m = Math.floor(s / 60);
  if (m < 60) return unit(m, "minute");
  const h = Math.floor(m / 60);
  if (h < 48) return unit(h, "hour");
  return unit(Math.floor(h / 24), "day");
}

/**
 * When a pending approval expires, relative to now.
 * @param expiresAt - Epoch ms.
 * @param now - Epoch ms, for tests.
 * @returns "Expires in 3 hours", or "Expired" once past.
 */
export function expiresInWords(expiresAt: number, now = Date.now()): string {
  if (expiresAt <= now) return "Expired";
  return `Expires in ${durationWords(expiresAt - now)}`;
}

/** The shortest and longest approval expiry `bot:edit` takes, in seconds. */
export const APPROVAL_TTL_MIN_SECONDS = 60;
export const APPROVAL_TTL_MAX_SECONDS = 30 * 24 * 60 * 60;

/** The expiries the bot page offers, in seconds. */
export const APPROVAL_TTL_CHOICES: readonly number[] = [
  15 * 60,
  60 * 60,
  4 * 60 * 60,
  24 * 60 * 60,
  3 * 24 * 60 * 60,
  7 * 24 * 60 * 60,
  APPROVAL_TTL_MAX_SECONDS,
];

/**
 * The expiries to offer for a bot: the standard ones, plus its current value
 * when that is not one of them (set over the API or the CLI), in order.
 * @param current - The bot's `approvalTtlSeconds`.
 * @returns Seconds, ascending.
 */
export function approvalTtlChoices(current: number): number[] {
  const all = new Set([...APPROVAL_TTL_CHOICES, current]);
  return [...all].sort((a, b) => a - b);
}

/** What the OAuth hop's return says, read from the settings page's query. */
export interface OAuthLanding {
  /** The server it was for, or `null` when the query names none. */
  serverId: number | null;
  /** `true` when it signed in; `false` with `error` when it did not. */
  signedIn: boolean;
  /** What went wrong, in the server's words. */
  error: string | null;
}

/**
 * Read the landing of `mcp-server:oauth-callback`, which comes back to
 * `/settings/mcp-servers?server=<id>&signedIn=1` or `&oauthError=<msg>`.
 * @param params - The page's search params.
 * @returns The landing, or `null` when the page was not reached that way.
 */
export function oauthLanding(params: URLSearchParams): OAuthLanding | null {
  const signedIn = params.get("signedIn") === "1";
  const error = params.get("oauthError");
  if (!signedIn && error === null) return null;
  const raw = Number(params.get("server"));
  return {
    serverId: Number.isInteger(raw) && raw > 0 ? raw : null,
    signedIn,
    error: signedIn ? null : error || "The sign-in did not finish.",
  };
}

/**
 * The query `approval:list` is read with.
 * @param status - The status to show, or empty for every status.
 * @param page - The page, from 1.
 * @returns The query string, with its `?`.
 */
export function approvalsQuery(status: string, page: number): string {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  params.set("page", String(page));
  params.set("limit", "25");
  return `?${params.toString()}`;
}

/**
 * Why a person may not decide an approval, beyond the RBAC map: the server
 * answers `canDecide` per approval from the bot's write list and its
 * approver tag.
 * @param botName - The bot.
 * @returns The sentence a disabled control carries.
 */
export function cannotDecideReason(botName: string): string {
  return `Only someone who may change ${botName}, or who holds its approver tag, can decide this.`;
}
