import { eq } from "drizzle-orm";
import { openInstallation } from "../ops/InstallationCredentialOps";
import { installationFor } from "../ops/SurfaceOps";
import type { OpenInstallation } from "../platforms/types";
import { channels } from "../schema/channels";
import { type ToolContext, ToolError } from "./types";

/**
 * What every `linear_*` tool needs: the installation the conversation speaks
 * through and the issue its session is about — **re-derived from the
 * conversation row on every call**, never taken from the model's arguments,
 * so a bot can only read or write the issue it was asked about, as its own
 * app, in its own workspace.
 */

/** A Linear conversation's scope. */
export interface LinearScope {
  inst: OpenInstallation;
  issueId: string;
  /** The bot's names in Linear, which nothing it writes may mention. */
  names: string[];
}

/**
 * Whether a conversation is a Linear session.
 * @param ctx - The conversation.
 * @returns `true` in a Linear channel.
 */
export async function isLinearConversation(
  ctx: Pick<ToolContext, "conversation"> & { db?: ToolContext["db"] },
): Promise<boolean> {
  const { api } = await import("keryx");
  const [channel] = await (ctx.db ?? api.db.db)
    .select({ type: channels.type })
    .from(channels)
    .where(eq(channels.id, ctx.conversation.channelId))
    .limit(1);
  return channel?.type === "linear";
}

/**
 * The scope of a call.
 * @param ctx - The call's context.
 * @returns The installation and the issue.
 * @throws {ToolError} Outside a Linear session, or when the app is not installed.
 */
export async function linearScope(ctx: ToolContext): Promise<LinearScope> {
  const [channel] = await ctx.db
    .select()
    .from(channels)
    .where(eq(channels.id, ctx.conversation.channelId))
    .limit(1);
  const issueId = ctx.conversation.details?.issueId;
  if (channel?.type !== "linear" || typeof issueId !== "string") {
    throw new ToolError(
      "not_linear",
      "This conversation is not a Linear agent session, so it has no issue.",
      "Use the Linear tools only in a Linear session.",
    );
  }
  const row = await installationFor(ctx.db, ctx.conversation.botId, channel);
  if (!row || row.status !== "active") {
    throw new ToolError(
      "not_installed",
      "Your Linear app is not installed in this workspace any more.",
      "Tell the person; a project admin must install the app again.",
    );
  }
  const inst = openInstallation(row);
  return {
    inst,
    issueId,
    names: [String(row.config.appUserName ?? "")].filter(Boolean),
  };
}

/**
 * Turn a Linear failure into an error the model reads.
 * @param e - What was thrown.
 * @param what - What the call was doing.
 * @returns The tool error.
 */
export function linearToolError(e: unknown, what: string): ToolError {
  const message = e instanceof Error ? e.message : String(e);
  return new ToolError(
    "linear_error",
    `Linear refused to ${what}: ${message.slice(0, 500)}`,
    "Check the input, or tell the person what you could not do.",
  );
}
