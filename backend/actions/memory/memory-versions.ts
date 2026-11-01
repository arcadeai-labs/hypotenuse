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
  documentKey,
  resolveMemoryAccess,
  scopeNameInput,
} from "../../ops/MemoryAccessOps";
import { memoryPathInput } from "../../ops/MemoryChunkOps";
import { listVersions, serializeMemoryDocument } from "../../ops/MemoryOps";

/**
 * `memory:versions` — a document's history, newest first: every write, edit,
 * and forget, with who or what made it and why. Text included, so the
 * explorer can diff any two.
 */
export class MemoryVersions implements Action {
  name = "memory:versions";
  description =
    "List a memory document's versions, newest first, each with its text, change note, source (agent, person, consolidation, promotion, decay), and provenance. Forgotten versions are tombstones. Requires membership; channel memory also needs read access to a bot working in the channel. Paginated.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/memory/document/versions",
    method: HTTP_METHOD.GET,
  };
  inputs = paginationInputs({ defaultLimit: 25 }).extend({
    projectId: idInput("The project"),
    scope: scopeNameInput,
    ...channelInputs,
    path: memoryPathInput,
  });

  /**
   * @param params - Which document, and the page.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The versions and pagination.
   */
  async run(
    params: ActionParams<MemoryVersions>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const access = await resolveMemoryAccess(
      api.db.db,
      params,
      connection.metadata.callerTags ?? [],
      "read",
    );
    const { rows, total } = await listVersions(
      api.db.db,
      documentKey(access, params.scope, params.path),
      params.page - 1,
      params.limit,
    );
    return {
      versions: rows.map((row) =>
        serializeMemoryDocument(row, { content: true }),
      ),
      pagination: {
        page: params.page,
        limit: params.limit,
        total,
        pages: Math.ceil(total / params.limit),
      },
    };
  }
}
