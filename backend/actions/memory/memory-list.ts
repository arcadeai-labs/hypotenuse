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
import { idInput } from "../../ops/InputOps";
import {
  channelInputs,
  queryBoolean,
  resolveMemoryAccess,
  scopeChoiceParam,
} from "../../ops/MemoryAccessOps";
import { memoryPathPrefixInput } from "../../ops/MemoryChunkOps";
import {
  decayFactor,
  halfLifeFor,
  listDocuments,
  serializeMemoryDocument,
  staleChunkCount,
} from "../../ops/MemoryOps";
import { embeddingModel } from "../../ops/ModelOps";

/**
 * `memory:list` — the documents in a project's memory, or in one channel's
 * memory, by path, each with how much it has faded. Also says whether
 * the project has an embedding model and how many chunks still wait for a
 * vector, so the explorer can warn that search is keyword-only.
 */
export class MemoryList implements Action {
  name = "memory:list";
  description =
    "List memory documents by path, with each one's description, version, pin, and decay (1 = fresh, near 0 = faded). scope project lists the project's shared memory; scope channel (with channelId) the memory of one channel, which every bot working there shares; both lists the two. Also reports the embedding model and how many chunks are not embedded yet. Requires membership; channel memory also needs read access to a bot working in the channel. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = { route: "/project/:projectId/memory", method: HTTP_METHOD.GET };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    scope: scopeChoiceParam.default("project"),
    ...channelInputs,
    pathPrefix: memoryPathPrefixInput.optional(),
    includeForgotten: queryBoolean("Include forgotten (tombstoned) documents"),
  });

  /**
   * @param params - The scope, filters, and pagination.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The documents, pagination, and the index's state.
   */
  async run(
    params: ActionParams<MemoryList>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const access = await resolveMemoryAccess(
      api.db.db,
      params,
      connection.metadata.callerTags ?? [],
      "read",
    );
    const { rows, total } = await listDocuments(
      api.db.db,
      access.readSet,
      params.scope,
      {
        pathPrefix: params.pathPrefix || undefined,
        limit: params.limit,
        offset: (params.page - 1) * params.limit,
        includeForgotten: params.includeForgotten ?? false,
      },
    );
    const model = await embeddingModel(params.projectId);
    return {
      documents: rows.map((row) =>
        serializeMemoryDocument(row, {
          decay: decayFactor(row, halfLifeFor(access.readSet, row)),
        }),
      ),
      halfLifeDays: access.readSet.halfLifeDays,
      index: {
        embeddingModel: model?.modelId ?? null,
        staleChunks: await staleChunkCount(
          api.db.db,
          params.projectId,
          model?.revision ?? null,
        ),
      },
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        pages: Math.ceil(total / params.limit),
      },
    };
  }
}
