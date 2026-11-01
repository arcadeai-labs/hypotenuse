import {
  type Action,
  type ActionParams,
  api,
  type Connection,
  HTTP_METHOD,
} from "keryx";
import { z } from "zod";
import {
  ProjectMemberMiddleware,
  type RbacConnectionMeta,
} from "../../middleware/rbac";
import type { SessionImpl } from "../../middleware/session";
import { idInput } from "../../ops/InputOps";
import {
  channelInputs,
  resolveMemoryAccess,
  scopeChoiceParam,
} from "../../ops/MemoryAccessOps";
import { memoryPathPrefixInput } from "../../ops/MemoryChunkOps";
import { searchMemory } from "../../ops/MemorySearchOps";

/**
 * `memory:search` — the same hybrid search a bot runs, over the same read
 * set, with every part of each score shown: relevance, decay, and the rank on
 * each side. A person's search does not count as using a memory.
 */
export class MemorySearch implements Action {
  name = "memory:search";
  description =
    "Search memory the way a bot does: semantic and keyword ranking fused, weighed by how much each memory has faded. Returns hits with path, snippet, score, relevance, decay, and each side's rank. scope project searches shared memory; channel or both (with channelId) include the memory of one channel, which every bot working there shares. Requires membership; channel memory also needs read access to a bot working in the channel.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/memory/search",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    query: z.string().trim().min(1).max(500).describe("What to find"),
    scope: scopeChoiceParam.default("project"),
    ...channelInputs,
    pathPrefix: memoryPathPrefixInput.optional(),
    limit: z.coerce
      .number()
      .int()
      .positive()
      .max(50)
      .default(10)
      .describe("How many hits, at most 50"),
  });

  /**
   * @param params - The query and where to look.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The hits and how they were found.
   */
  async run(
    params: ActionParams<MemorySearch>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const access = await resolveMemoryAccess(
      api.db.db,
      params,
      connection.metadata.callerTags ?? [],
      "read",
    );
    const result = await searchMemory(api.db.db, access.readSet, params.query, {
      scope: params.scope,
      pathPrefix: params.pathPrefix || undefined,
      limit: params.limit,
    });
    return {
      hits: result.hits,
      mode: result.mode,
      keywordOnlyReason: result.keywordOnlyReason,
    };
  }
}
