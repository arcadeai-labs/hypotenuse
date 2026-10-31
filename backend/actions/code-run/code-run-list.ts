import { count, desc, eq } from "drizzle-orm";
import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  HTTP_METHOD,
  paginate,
  paginationInputs,
} from "keryx";
import {
  ProjectMemberMiddleware,
  type RbacConnectionMeta,
} from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import { approvalsOfRuns, serializeCodeRun } from "../../ops/CodeRunOps";
import { loadReadableConversation } from "../../ops/ConversationOps";
import { idInput } from "../../ops/InputOps";
import { codeRuns } from "../../schema/code_runs";

/**
 * `code-run:list` — a conversation's code-mode programs, newest first: each
 * one's source, status, journal of host calls, approvals, and answer. Never
 * a continuation. Requires membership and the bot's read access.
 */
export class CodeRunList implements Action {
  name = "code-run:list";
  description =
    "List the programs a bot ran with run_code in a conversation, newest first: each one's source, status (running, interrupted, completed, failed, interrupted_by_crash), the host calls it made and how each was let through, the approvals it waited on, and its result or error. Requires membership and read access to the bot. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/conversation/:conversationId/code-runs",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    conversationId: idInput("The conversation"),
  });

  /**
   * @param params - The conversation and pagination.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The runs and pagination.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async run(
    params: ActionParams<CodeRunList>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const { conversation } = await loadReadableConversation(
      api.db.db,
      params.projectId,
      params.conversationId,
      connection.metadata.callerTags ?? [],
    );
    const where = eq(codeRuns.conversationId, conversation.id);
    const result = await paginate(
      api.db.db
        .select()
        .from(codeRuns)
        .where(where)
        .orderBy(desc(codeRuns.id))
        .$dynamic(),
      api.db.db.select({ count: count() }).from(codeRuns).where(where),
      params,
    );
    const byRun = await approvalsOfRuns(
      api.db.db,
      result.data.map((r) => r.id),
    );
    return {
      codeRuns: result.data.map((r) =>
        serializeCodeRun(r, byRun.get(r.id) ?? []),
      ),
      pagination: result.pagination,
    };
  }
}
