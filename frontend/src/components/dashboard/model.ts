/**
 * The dashboard's pure pieces: channel names, frame reading, the detail line
 * under a conversation's state, inbox links, and query strings. No React, so
 * every rule here is unit-tested.
 */

/** What a dashboard frame may say went stale (`DashboardEffectsOps`). */
export const DASHBOARD_STALE_KINDS = [
  "conversations",
  "inbox",
  "sandboxes",
] as const;

/** One of {@link DASHBOARD_STALE_KINDS}. */
export type DashboardStale = (typeof DASHBOARD_STALE_KINDS)[number];

/**
 * The per-bot channel a reader follows.
 * @param projectId - The project.
 * @param botId - The bot.
 * @returns `project:<p>:bot:<b>:dashboard`.
 */
export function botDashboardChannel(projectId: number, botId: number): string {
  return `project:${projectId}:bot:${botId}:dashboard`;
}

/**
 * What a frame says went stale, if it is a dashboard frame at all.
 * @param payload - The broadcast's parsed payload.
 * @returns The stale kind, or `null`.
 */
export function staleOf(payload: unknown): DashboardStale | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { event?: unknown; stale?: unknown };
  if (p.event !== "dashboard") return null;
  return (DASHBOARD_STALE_KINDS as readonly unknown[]).includes(p.stale)
    ? (p.stale as DashboardStale)
    : null;
}

/** A conversation as the dashboard's lists carry it. */
export interface DashboardConversation {
  id: number;
  state: "working" | "hibernating" | "waiting" | "ended";
  waitingOn: {
    kind: string;
    at?: number;
    sandboxJobId?: number;
    approvalIds?: number[];
  } | null;
  outcome: "completed" | "failed" | "cancelled" | null;
  epoch: number;
  lastActivityAt: number;
}

/**
 * How long ago, in the fewest words: "just now", "4m ago", "2h ago", "3d ago".
 * @param at - Epoch ms.
 * @param now - The current time.
 * @returns The words.
 */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * The line under a conversation's state glyph, per the dashboard's state
 * table: what it is doing, what it waits on, or how long it has rested.
 * @param c - The conversation.
 * @param now - The current time.
 * @returns One short line.
 */
export function stateDetail(
  c: DashboardConversation,
  now = Date.now(),
): string {
  switch (c.state) {
    case "working":
      return `turn ${c.epoch} · working`;
    case "hibernating":
      return `last message ${ago(c.lastActivityAt, now)}`;
    case "ended":
      return c.outcome === "failed"
        ? "failed — retry it"
        : (c.outcome ?? "ended");
    case "waiting":
      switch (c.waitingOn?.kind) {
        case "approval": {
          const n = c.waitingOn.approvalIds?.length ?? 1;
          return n > 1 ? `needs ${n} approvals` : "needs approval";
        }
        case "sandbox":
          return c.waitingOn.sandboxJobId
            ? `sandbox job #${c.waitingOn.sandboxJobId}`
            : "sandbox job";
        case "timer":
          return c.waitingOn.at
            ? `wakes ${new Date(c.waitingOn.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`
            : "on a timer";
        case "help":
          return `asked the team ${ago(c.lastActivityAt, now)}`;
        default:
          return `asked ${ago(c.lastActivityAt, now)}`;
      }
  }
}

/** The kinds the inbox holds. */
export const INBOX_KINDS = ["approval", "help", "sandbox-question"] as const;

/** One of {@link INBOX_KINDS}. */
export type InboxKind = (typeof INBOX_KINDS)[number];

/** One inbox item as `inbox:list` answers it. */
export interface InboxItem {
  kind: InboxKind;
  id: number;
  bot: { id: number; name: string; displayName: string };
  conversationId: number | null;
  jobId: number | null;
  title: string;
  detail: string | null;
  createdAt: number;
  expiresAt: number | null;
  canAnswer: boolean;
}

/**
 * Where an inbox item is answered: the page its own action lives on.
 * @param item - The item.
 * @returns The route.
 */
export function inboxHref(
  item: Pick<InboxItem, "kind" | "id" | "jobId">,
): string {
  if (item.kind === "approval") return `/approvals/${item.id}`;
  if (item.kind === "help") return `/help/${item.id}`;
  return `/sandboxes/${item.jobId ?? ""}`;
}

/**
 * What an inbox item's kind is called.
 * @param kind - The kind.
 * @returns The words.
 */
export function inboxKindLabel(kind: InboxKind): string {
  if (kind === "approval") return "Approval";
  if (kind === "help") return "Help request";
  return "Sandbox question";
}

/**
 * The query string for one page of the inbox.
 * @param kind - The kind filter, or empty for all.
 * @param page - The 1-indexed page.
 * @returns `?page=…&limit=25`, with `kind` when set.
 */
export function inboxQuery(kind: string, page: number): string {
  const params = new URLSearchParams({ page: String(page), limit: "25" });
  if (kind) params.set("kind", kind);
  return `?${params}`;
}

/**
 * Money as the home page shows it: two places, and a `+` when some of the
 * day's spend was on a model without a price (unknown, not free).
 * @param usd - The priced sum.
 * @param unpriced - How many records had no price.
 * @returns "$1.23" or "$1.23+".
 */
export function spendLabel(usd: number, unpriced: number): string {
  return `$${usd.toFixed(2)}${unpriced > 0 ? "+" : ""}`;
}

/**
 * The glyph a waiting kind is drawn with. The glyph set has no separate
 * help shape: waiting on the team is a person needed, the same as an answer.
 * @param kind - What it waits on (or an inbox kind).
 * @returns The glyph's `waitingOn`.
 */
export function waitingGlyph(
  kind: string,
): "answer" | "approval" | "sandbox" | "timer" {
  if (kind === "approval" || kind === "sandbox" || kind === "timer") {
    return kind;
  }
  if (kind === "sandbox-question") return "sandbox";
  return "answer";
}
