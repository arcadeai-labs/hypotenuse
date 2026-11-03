import { eq } from "drizzle-orm";
import { api } from "keryx";
import { conversations } from "../schema/conversations";
import { sandboxJobs } from "../schema/sandbox_jobs";

/**
 * **The dashboard's live half.** Every page that watches many things at once
 * — the project home, the conversations list, the inbox, the sandboxes list —
 * follows one channel per bot it may read:
 * `project:<projectId>:bot:<botId>:dashboard`.
 *
 * The bot is in the channel's name because Keryx authorizes a channel only
 * when a socket subscribes: there is no per-frame filter. A project-wide
 * channel would tell a member who cannot read a bot *when* its conversations
 * change, which is exactly what bot gating forbids. A per-bot channel is
 * authorized by `canReadBot` at subscribe time, so a member never receives a
 * frame about a bot they may not read.
 *
 * **Every frame is `{ event: "dashboard", stale }`** — the kind of read that
 * went stale, and nothing else: no id, no state, no text. The page re-reads
 * through the same RBAC-gated action the CLI and MCP use. Frames are
 * published after commit (every caller is an after-commit path), and a
 * failed publish is logged, never thrown: a frame is an accelerant, and a
 * reconnect re-reads everything.
 *
 * | `stale` | Re-read | Published by |
 * |---|---|---|
 * | `conversations` | `conversation:list`, `project:overview` | every `pingConversation` (a tick's step, a message, a cancel, a wake, an answer, a relay) |
 * | `inbox` | `inbox:list`, `project:overview` | every `pingConversation` too: raising an item pings its conversation (a tick, a relay), and every way one settles pings it after commit — `approval:decide`, `approvals:expire`, `help:answer` / `help:cancel` / the help expiry, `sandbox-job:answer`, the sandbox-question expiry, and an in-channel interaction |
 * | `sandboxes` | `sandbox-job:list`, `sandbox-ledger:list` | a job claimed, provisioned, reporting, cancelled, or ended, and every sandbox relay; a ledger row destroyed |
 */

/** The kinds of read a dashboard frame may say went stale. */
export const DASHBOARD_STALE_KINDS = [
  "conversations",
  "inbox",
  "sandboxes",
] as const;

/** One of {@link DASHBOARD_STALE_KINDS}. */
export type DashboardStale = (typeof DASHBOARD_STALE_KINDS)[number];

/**
 * The channel a bot's dashboard frames are published on.
 * @param projectId - The project.
 * @param botId - The bot.
 * @returns The channel name.
 */
export function botDashboardChannel(projectId: number, botId: number): string {
  return `project:${projectId}:bot:${botId}:dashboard`;
}

/** The channel-name shape {@link botDashboardChannel} produces. */
export const BOT_DASHBOARD_CHANNEL_PATTERN =
  /^project:(\d+):bot:(\d+):dashboard$/;

/**
 * A frame. Only ever these two keys.
 * @param stale - What went stale.
 * @returns The frame.
 */
export function dashboardFrame(stale: DashboardStale) {
  return { event: "dashboard", stale } as const;
}

/**
 * Publish content-free frames saying a bot's reads went stale. Never throws.
 * @param projectId - The project.
 * @param botId - The bot.
 * @param kinds - What went stale.
 */
export async function publishStale(
  projectId: number,
  botId: number,
  kinds: readonly DashboardStale[],
): Promise<void> {
  for (const kind of new Set(kinds)) {
    try {
      await api.pubsub.broadcast(
        botDashboardChannel(projectId, botId),
        JSON.stringify(dashboardFrame(kind)),
        "dashboard",
      );
    } catch (e) {
      api.logger.warn("could not publish a dashboard frame", {
        botId,
        kind,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

/**
 * The conversation half of a conversation ping: its bot's `conversations`
 * and `inbox` reads are stale. Reads the conversation's bot by primary key
 * (a conversation never changes bots), so a caller needs only the id.
 * Never throws.
 * @param projectId - The project.
 * @param conversationId - The conversation that changed.
 */
export async function publishConversationStale(
  projectId: number,
  conversationId: number,
): Promise<void> {
  try {
    const [row] = await api.db.db
      .select({ botId: conversations.botId })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .limit(1);
    if (!row) return;
    await publishStale(projectId, row.botId, ["conversations", "inbox"]);
  } catch (e) {
    api.logger.warn("could not publish a conversation's dashboard frames", {
      conversationId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * A sandbox job changed: its bot's `sandboxes` read is stale. Never throws.
 * @param jobId - The job.
 */
export async function publishJobStale(jobId: number): Promise<void> {
  try {
    const [row] = await api.db.db
      .select({ projectId: sandboxJobs.projectId, botId: sandboxJobs.botId })
      .from(sandboxJobs)
      .where(eq(sandboxJobs.id, jobId))
      .limit(1);
    if (!row) return;
    await publishStale(row.projectId, row.botId, ["sandboxes"]);
  } catch (e) {
    api.logger.warn("could not publish a sandbox job's dashboard frame", {
      jobId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}
