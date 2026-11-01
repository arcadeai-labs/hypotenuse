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
import { isAdmin } from "../../ops/MembershipOps";
import {
  channelInputs,
  documentKey,
  resolveMemoryAccess,
  scopeNameInput,
} from "../../ops/MemoryAccessOps";
import { memoryPathInput } from "../../ops/MemoryChunkOps";
import {
  decayFactor,
  halfLifeFor,
  memoryNotFound,
  readVersion,
  serializeMemoryDocument,
} from "../../ops/MemoryOps";

/**
 * `memory:view` — one memory document, current or at a version, with its
 * text, provenance, and decay, and what the caller may do with it.
 */
export class MemoryView implements Action {
  name = "memory:view";
  description =
    "Read one memory document: its markdown, description, version, pin, decay, and provenance (the conversation and entries it was learned from, the person who wrote it, or the channel memory it was promoted from). Pass versionId for an earlier version. standing says whether you may change, forget, pin, or promote it. Requires membership; channel memory also needs read access to a bot working in the channel.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/memory/document",
    method: HTTP_METHOD.GET,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    scope: scopeNameInput,
    ...channelInputs,
    path: memoryPathInput,
    versionId: z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .describe("An earlier version's versionId; omit for the current one"),
  });

  /**
   * @param params - Which document, and which version.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The document and the caller's standing on it.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async run(
    params: ActionParams<MemoryView>,
    connection: Connection<SessionImpl, RbacConnectionMeta>,
  ) {
    const callerTags = connection.metadata.callerTags ?? [];
    const access = await resolveMemoryAccess(
      api.db.db,
      params,
      callerTags,
      "read",
    );
    const row = await readVersion(
      api.db.db,
      documentKey(access, params.scope, params.path),
      params.versionId,
    );
    if (!row) throw memoryNotFound();
    const admin = isAdmin(callerTags);
    const canWrite =
      params.scope === "project" ? admin : Boolean(access.standing?.canWrite);
    return {
      document: serializeMemoryDocument(row, {
        content: true,
        decay: decayFactor(row, halfLifeFor(access.readSet, row)),
      }),
      standing: {
        canWrite,
        canPromote: params.scope === "channel" && canWrite && admin,
      },
    };
  }
}
