import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  HTTP_METHOD,
  paginationInputs,
} from "keryx";
import {
  ProjectMemberMiddleware,
  type RbacConnectionMeta,
} from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import { serializeChannel } from "../../ops/ConversationOps";
import { idInput } from "../../ops/InputOps";
import { readableMemoryChannels } from "../../ops/MemoryAccessOps";

/**
 * `memory:channels` — the channels of a project whose memory the caller may
 * read, each with how many live documents it holds and the bots working in
 * it: the memory explorer's index. A channel's memory is shared by every bot
 * working there.
 */
export class MemoryChannels implements Action {
  name = "memory:channels";
  description =
    "List the channels of a project whose memory you may read, each with how many documents it holds, the bots working in it (every one of them reads and writes the same channel memory), and whether you may change it. Use a channel's id with memory:list, memory:search, and memory:view. Requires membership; a channel is listed when you may read a bot working in it. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/memory/channels",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
  });

  /**
   * @param params - The project, and the page.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The channels with their document counts and bots, and pagination.
   */
  async run(
    params: ActionParams<MemoryChannels>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const all = await readableMemoryChannels(
      api.db.db,
      params.projectId,
      connection.metadata.callerTags ?? [],
    );
    const start = (params.page - 1) * params.limit;
    return {
      channels: all.slice(start, start + params.limit).map((row) => ({
        ...serializeChannel(row.channel),
        documents: row.documents,
        bots: row.bots.map((b) => ({ id: b.id, name: b.name, slug: b.slug })),
        canWrite: row.standing.canWrite,
      })),
      pagination: {
        page: params.page,
        limit: params.limit,
        total: all.length,
        pages: Math.ceil(all.length / params.limit),
      },
    };
  }
}
