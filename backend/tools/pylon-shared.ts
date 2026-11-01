import { eq } from "drizzle-orm";
import { openInstallation } from "../ops/InstallationCredentialOps";
import { PylonApiError } from "../ops/PylonOps";
import { installationFor } from "../ops/SurfaceOps";
import type { CustomerReplyPolicy } from "../platforms/pylon/adapter";
import type { OpenInstallation } from "../platforms/types";
import { channels } from "../schema/channels";
import { type ToolContext, ToolError } from "./types";

/**
 * What every `pylon_*` tool needs: the installation the conversation speaks
 * through, the issue it is about, and the issue's account — **re-derived from
 * the conversation row on every call**, never taken from the model's
 * arguments, so a bot reads and writes only the issue it is working and only
 * that customer's records, as its own token.
 */

/** A Pylon conversation's scope. */
export interface PylonScope {
  inst: OpenInstallation;
  issueId: string;
  /** The issue's account (the channel's), or `null` for an issue with none. */
  accountId: string | null;
  policy: CustomerReplyPolicy;
}

/**
 * The channel of a conversation, read.
 * @param ctx - The conversation, and a database handle when there is one.
 * @returns The channel row, or `undefined`.
 */
async function channelOf(
  ctx: Pick<ToolContext, "conversation"> & { db?: ToolContext["db"] },
) {
  const { api } = await import("keryx");
  const [channel] = await (ctx.db ?? api.db.db)
    .select()
    .from(channels)
    .where(eq(channels.id, ctx.conversation.channelId))
    .limit(1);
  return channel;
}

/**
 * Whether a conversation is about a Pylon issue.
 * @param ctx - The conversation.
 * @returns `true` in a Pylon channel.
 */
export async function isPylonConversation(
  ctx: Pick<ToolContext, "conversation"> & { db?: ToolContext["db"] },
): Promise<boolean> {
  return (await channelOf(ctx))?.type === "pylon";
}

/**
 * The customer reply policy of a conversation's installation.
 * @param ctx - The conversation.
 * @returns The policy, `never` outside Pylon or without an installation.
 */
export async function replyPolicyOf(
  ctx: Pick<ToolContext, "conversation"> & { db?: ToolContext["db"] },
): Promise<CustomerReplyPolicy> {
  const channel = await channelOf(ctx);
  if (channel?.type !== "pylon") return "never";
  const { api } = await import("keryx");
  const row = await installationFor(
    ctx.db ?? api.db.db,
    ctx.conversation.botId,
    channel,
  );
  if (!row || row.status !== "active") return "never";
  const policy = row.config.customerReplyPolicy;
  return policy === "approve" || policy === "auto-on-low-risk"
    ? policy
    : "never";
}

/**
 * The scope of a call.
 * @param ctx - The call's context.
 * @returns The installation, the issue, and its account.
 * @throws {ToolError} Outside a Pylon conversation, or when the token is not connected.
 */
export async function pylonScope(ctx: ToolContext): Promise<PylonScope> {
  const channel = await channelOf(ctx);
  const issueId = ctx.conversation.details?.issueId;
  if (channel?.type !== "pylon" || typeof issueId !== "string") {
    throw new ToolError(
      "not_pylon",
      "This conversation is not about a Pylon issue.",
      "Use the Pylon tools only while working a Pylon issue.",
    );
  }
  const row = await installationFor(ctx.db, ctx.conversation.botId, channel);
  if (!row || row.status !== "active") {
    throw new ToolError(
      "not_installed",
      "Your Pylon token is not connected any more.",
      "Write your findings in your reply; a project admin must connect the token again.",
    );
  }
  const accountId = (channel.details as { accountId?: unknown }).accountId;
  const policy = row.config.customerReplyPolicy;
  return {
    inst: openInstallation(row),
    issueId,
    accountId: typeof accountId === "string" ? accountId : null,
    policy:
      policy === "approve" || policy === "auto-on-low-risk" ? policy : "never",
  };
}

/**
 * Turn a Pylon failure into an error the model reads.
 * @param e - What was thrown.
 * @param what - What the call was doing.
 * @returns The tool error.
 */
export function pylonToolError(e: unknown, what: string): ToolError {
  if (e instanceof ToolError) return e;
  const message = e instanceof Error ? e.message : String(e);
  const retryable = e instanceof PylonApiError && e.retryable;
  return new ToolError(
    retryable ? "pylon_busy" : "pylon_error",
    `Pylon refused to ${what}: ${message.slice(0, 500)}`,
    retryable
      ? "Pylon is rate-limiting or unavailable; try again in a minute, or carry on without it."
      : "Check the input, or say in your note what you could not do.",
  );
}
