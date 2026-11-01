import { and, desc, eq, isNotNull, or } from "drizzle-orm";
import { api } from "keryx";
import { conversationEntries } from "../schema/conversation_entries";
import { type SandboxJob, sandboxJobs } from "../schema/sandbox_jobs";
import { type ToolContext, ToolError } from "./types";

/**
 * What the sandbox tools share: finding a job of *this* conversation — a job
 * started elsewhere is never visible, so a bot cannot reach another
 * conversation's work — and who asked.
 */

/**
 * A job this conversation started.
 * @param ctx - The call's context.
 * @param jobId - The job.
 * @returns The job.
 * @throws {ToolError} `not_found` for any other job.
 */
export async function conversationJob(
  ctx: Pick<ToolContext, "db" | "conversation">,
  jobId: number,
): Promise<SandboxJob> {
  const [job] = await ctx.db
    .select()
    .from(sandboxJobs)
    .where(
      and(
        eq(sandboxJobs.id, jobId),
        eq(sandboxJobs.parentConversationId, ctx.conversation.id),
      ),
    )
    .limit(1);
  if (!job) {
    throw new ToolError(
      "not_found",
      `This conversation started no sandbox job ${jobId}.`,
      "Call sandbox_status with no jobId to list this conversation's jobs.",
    );
  }
  return job;
}

/**
 * Whether this conversation has started any job.
 * @param ctx - The bot and conversation.
 * @returns `true` if so.
 */
export async function hasJobs(
  ctx: Pick<ToolContext, "conversation"> & { db?: ToolContext["db"] },
): Promise<boolean> {
  const [row] = await (ctx.db ?? api.db.db)
    .select({ id: sandboxJobs.id })
    .from(sandboxJobs)
    .where(eq(sandboxJobs.parentConversationId, ctx.conversation.id))
    .limit(1);
  return Boolean(row);
}

/**
 * Who sent the conversation's latest message: the person a job is for.
 * @param ctx - The call's context.
 * @returns Their participant or user id.
 */
export async function latestRequester(
  ctx: Pick<ToolContext, "db" | "conversation">,
): Promise<{ participantId: number | null; userId: number | null }> {
  const [row] = await ctx.db
    .select({
      participantId: conversationEntries.participantId,
      userId: conversationEntries.userId,
    })
    .from(conversationEntries)
    .where(
      and(
        eq(conversationEntries.conversationId, ctx.conversation.id),
        eq(conversationEntries.kind, "message"),
        or(
          isNotNull(conversationEntries.participantId),
          isNotNull(conversationEntries.userId),
        ),
      ),
    )
    .orderBy(desc(conversationEntries.seq))
    .limit(1);
  return {
    participantId: row?.participantId ?? null,
    userId: row?.userId ?? null,
  };
}

/**
 * The job this conversation started most recently.
 * @param ctx - The call's context.
 * @returns Its id, or `0` (which no job has) when there is none.
 */
export async function latestConversationJobId(
  ctx: Pick<ToolContext, "db" | "conversation">,
): Promise<number> {
  const [row] = await ctx.db
    .select({ id: sandboxJobs.id })
    .from(sandboxJobs)
    .where(eq(sandboxJobs.parentConversationId, ctx.conversation.id))
    .orderBy(desc(sandboxJobs.id))
    .limit(1);
  return row?.id ?? 0;
}
