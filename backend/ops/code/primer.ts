import { config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/code";

/**
 * **The primer**, in three tiers, so a routine turn carries no API manual:
 *
 * | Tier | Where | What |
 * |---|---|---|
 * | 1 | `run_code`'s description, every turn | what it is, when to prefer it, and that `source: "?"` returns the API |
 * | 2 | `run_code` with `source: "?"` | {@link fullPrimer}: the API as TypeScript declarations, the limits, three worked examples |
 * | 3 | every failure's `next_action_hint` | {@link SHORT_PRIMER} |
 */

/** The reminder appended to every failure. */
export const SHORT_PRIMER =
  'run_code primer: the source is a function body (top-level await and return). Globals: memory.search/list/read/write, mcp.listTools/search/info/exec/capture, largeResult.read, console.log — all async except console. No fetch, require, timers, or files. Call mcp.info before mcp.exec. A refused host call throws a HostError whose code says why (approval_denied, mcp:not_found, …). Return a small value. Call run_code with source "?" for the full API.';

/** The host API, as TypeScript a model reads. */
const DECLARATIONS = `declare const memory: {
  /** Hybrid search of this channel's memory and the project's. At most 20 hits. */
  search(query: string, options?: { scope?: "channel" | "project" | "both"; pathPrefix?: string; limit?: number }):
    Promise<{ hits: { path: string; scope: "channel" | "project"; versionId: number; snippet: string; score: number }[] }>;
  /** Documents by path. */
  list(options?: { scope?: "channel" | "project" | "both"; pathPrefix?: string; limit?: number; offset?: number }):
    Promise<{ documents: { path: string; scope: string; description: string; versionId: number }[]; total: number; nextOffset: number | null }>;
  /** A document's text; parsed JSON for a .json path. scope defaults to "channel". */
  read(path: string, options?: { scope?: "channel" | "project" }): Promise<unknown>;
  /** Write a new version of a channel document. A non-string value is stored as JSON. */
  write(path: string, value: unknown, options?: { changeNote?: string; description?: string }):
    Promise<{ path: string; scope: "channel"; versionId: number; bytesWritten: number }>;
};

declare const mcp: {
  /** Your MCP tools, of one server or of all. */
  listTools(server?: string): Promise<unknown>;
  /** Find tools by what they do. */
  search(query: string): Promise<{ tools: { name: string; description: string; needsApproval: boolean }[] }>;
  /** A tool's input schema. Required once per tool per conversation before exec or capture. */
  info(server: string, tool: string): Promise<{ name: string; description: string; inputSchema: object; needsApproval: boolean }>;
  /** Call a tool. Returns parsed JSON when it answers JSON, else its text. A call that needs approval pauses the
   *  program until a person decides; the program then continues from here. */
  exec(server: string, tool: string, args?: Record<string, unknown>): Promise<unknown>;
  /** Call a tool and save its whole answer to channel memory at path; returns only an acknowledgement. */
  capture(server: string, tool: string, args: Record<string, unknown>, path: string):
    Promise<{ path: string; scope: "channel"; versionId: number; bytesWritten: number }>;
};

declare const largeResult: {
  /** Page through a large tool result of this conversation (lr_<n>). */
  read(id: string, options?: { offset?: number; limit?: number }):
    Promise<{ text: string; offset: number; totalChars: number; nextOffset: number | null }>;
};

/** Captured and returned beside the result. */
declare const console: { log(...values: unknown[]): void };

/** What a refused host call throws. code is the reason: approval_denied, or mcp:<type> / <type>. */
declare class HostError extends Error { code: string; hint: string }`;

/** Three worked examples: count by day, join two tools, capture then reduce. */
const EXAMPLES = `// 1. Count by day — fetch once, reduce locally, return a small answer.
await mcp.info("support", "list_tickets");
const tickets = await mcp.exec("support", "list_tickets", { since: "2026-10-01" }) as { createdAt: string }[];
const byDay: Record<string, number> = {};
for (const t of tickets) byDay[t.createdAt.slice(0, 10)] = (byDay[t.createdAt.slice(0, 10)] ?? 0) + 1;
return byDay;

// 2. Join two tools — customers with more than three tickets on the enterprise plan.
await mcp.info("support", "list_tickets");
await mcp.info("crm", "list_customers");
const [all, customers] = await Promise.all([
  mcp.exec("support", "list_tickets", { since: "2026-10-01" }) as Promise<{ customerId: string }[]>,
  mcp.exec("crm", "list_customers", { plan: "enterprise" }) as Promise<{ id: string; name: string }[]>,
]);
const counts = new Map<string, number>();
for (const t of all) counts.set(t.customerId, (counts.get(t.customerId) ?? 0) + 1);
return customers.filter((c) => (counts.get(c.id) ?? 0) > 3).map((c) => c.name);

// 3. Capture, then reduce — keep the raw export in memory, compute from it, keep only the answer in context.
await mcp.info("billing", "export_invoices");
await mcp.capture("billing", "export_invoices", { month: "2026-10" }, "exports/invoices-2026-10.json");
const invoices = await memory.read("exports/invoices-2026-10.json") as { amount: number; paid: boolean }[];
const unpaid = invoices.filter((i) => !i.paid);
console.log(\`\${unpaid.length} of \${invoices.length} unpaid\`);
return { unpaid: unpaid.length, total: unpaid.reduce((s, i) => s + i.amount, 0) };

// A call that needs approval and was refused can be caught:
try { await mcp.exec("mail", "send_email", { to: "toad", subject: "hi" }); }
catch (e) { if (e.code === "approval_denied") return "not sent: a person said no"; throw e; }`;

/**
 * The full primer `run_code` answers for `source: "?"`.
 * @returns The text.
 */
export function fullPrimer(): string {
  const c = config.code;
  const mib = (b: number) => `${Math.round(b / (1024 * 1024))} MiB`;
  const kib = (b: number) => `${Math.round(b / 1024)} KiB`;
  return [
    "# run_code",
    "",
    "Run a short TypeScript or JavaScript program in an isolated sandbox. The source is a function body: top-level `await` and `return` work, and the returned value is your result. Type annotations are stripped. There is no `fetch`, `require`, `import`, `process`, timers, or filesystem — only the globals below. Every call goes through the same permissions and approvals as your tools.",
    "",
    "Prefer it when a tool answers more than you need: fetch once, filter, join, and count in the program, and return a small answer. Do not call a tool once per record; capture once and compute locally. Calls to send, ask, or end your turn are not available in code.",
    "",
    "## API",
    "",
    "```ts",
    DECLARATIONS,
    "```",
    "",
    "## Limits",
    "",
    `- ${Math.round(c.timeoutMs / 1000)} s per run (${Math.round(c.cpuTimeoutMs / 1000)} s of computing), ${mib(c.memoryBytes)} of memory`,
    `- ${c.bridgeRequests} host calls per program, ${c.concurrentBridgeRequests} at once`,
    `- source ${kib(c.sourceBytes)}, result ${mib(c.resultBytes)} (use saveTo for more), console ${kib(c.consoleBytes)}`,
    "",
    "With `saveTo: {path}`, the result is written to channel memory as JSON instead of returned.",
    "",
    "## Examples",
    "",
    "```ts",
    EXAMPLES,
    "```",
  ].join("\n");
}
