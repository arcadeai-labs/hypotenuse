import { and, count, desc, eq } from "drizzle-orm";
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
import { loadReadableConversation } from "../../ops/ConversationOps";
import { idInput } from "../../ops/InputOps";
import { serializeOutboxMessage } from "../../ops/OutboxOps";
import { OUTBOX_STATUSES, outboxMessages } from "../../schema/outbox_messages";

/**
 * `conversation:outbox` — what a conversation sent (or is sending) to the
 * world: every outbox row, newest first, with its kind, the transcript seq
 * it came from, and where its delivery stands. A row's target names the
 * platform and thread, never a credential; an API callback's URL is shown
 * without its query string.
 */
export class ConversationOutbox implements Action {
  name = "conversation:outbox";
  description =
    "List what a conversation sent to its platform, newest first: each outbox row's kind (message, status, stream, plan, question, approval, link, or an API callback kind), the transcript seq it came from, its delivery status (pending, sending, sent, failed, undeliverable, superseded), attempts, and error. Filter by status. Requires membership and read access to the bot. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/conversation/:conversationId/outbox",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    conversationId: idInput("The conversation"),
    status: z
      .enum(OUTBOX_STATUSES)
      .optional()
      .describe("Only rows in this delivery status"),
  });

  /**
   * @param params - The conversation, filter, and pagination.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The outbox rows and pagination.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async run(
    params: ActionParams<ConversationOutbox>,
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
      eq(outboxMessages.conversationId, conversation.id),
      params.status ? eq(outboxMessages.status, params.status) : undefined,
    );
    const result = await paginate(
      api.db.db
        .select()
        .from(outboxMessages)
        .where(where)
        .orderBy(desc(outboxMessages.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(outboxMessages).where(where),
      params,
    );
    return {
      outbox: result.data.map(serializeOutboxMessage),
      pagination: result.pagination,
    };
  }
}
