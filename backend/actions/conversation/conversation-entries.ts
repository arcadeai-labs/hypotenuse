import { and, asc, count, desc, eq, gt, lt } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import { z } from "zod";
import {
  ProjectMemberMiddleware,
  type RbacConnectionMeta,
} from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import {
  loadReadableConversation,
  serializeConversation,
} from "../../ops/ConversationOps";
import { idInput } from "../../ops/InputOps";
import { serializeEntry } from "../../ops/TranscriptOps";
import { conversationEntries } from "../../schema/conversation_entries";

/**
 * `conversation:entries` — a conversation's transcript, oldest first:
 * messages, the bot's reasoning, every tool call and its result, state
 * changes, and summaries. `since` reads only entries after a seq, which is
 * how a poller or the live page follows along. Requires membership and the
 * bot's read access.
 */
export class ConversationEntries implements Action {
  name = "conversation:entries";
  description =
    "Read a conversation's transcript in order: messages (role user or assistant), thinking, tool_call_intent and tool_result pairs, status_change, and compaction summaries. Pass since (a seq) to read only newer entries, or order=desc with before (a seq) to page backwards from the newest; the conversation's state is returned alongside, so a poller knows when the bot is done (state is not working). Requires membership and read access to the bot. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/conversation/:conversationId/entries",
    method: HTTP_METHOD.GET,
  };
  // A transcript page loads its last 200 entries at once.
  inputs = paginationInputs({ defaultLimit: 25, maxLimit: 200 }).extend({
    projectId: idInput("The project"),
    conversationId: idInput("The conversation"),
    since: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Only entries with a seq greater than this"),
    before: z.coerce
      .number()
      .int()
      .min(1)
      .optional()
      .describe("Only entries with a seq less than this (paging backwards)"),
    order: z
      .enum(["asc", "desc"])
      .default("asc")
      .describe(
        "asc (oldest first, the default) or desc (newest first: pass desc to read a transcript's tail, then before to page back)",
      ),
  });

  /**
   * @param params - The conversation, `since`, and pagination.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The entries, the conversation as it stands, and pagination.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async run(
    params: ActionParams<ConversationEntries>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const callerTags = connection.metadata.callerTags ?? [];
    const { conversation } = await loadReadableConversation(
      api.db.db,
      params.projectId,
      params.conversationId,
      callerTags,
    );
    const where = and(
      eq(conversationEntries.conversationId, conversation.id),
      params.since !== undefined
        ? gt(conversationEntries.seq, params.since)
        : undefined,
      params.before !== undefined
        ? lt(conversationEntries.seq, params.before)
        : undefined,
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(conversationEntries)
        .where(where)
        .orderBy(
          params.order === "desc"
            ? desc(conversationEntries.seq)
            : asc(conversationEntries.seq),
        )
        .$dynamic(),
      api.db.db
        .select({ count: count() })
        .from(conversationEntries)
        .where(where),
      params,
    );
    return {
      conversation: serializeConversation(conversation),
      entries: result.data.map(serializeEntry),
      pagination: result.pagination,
    };
  }
}
