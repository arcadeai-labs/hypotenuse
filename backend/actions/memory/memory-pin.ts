import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { ProjectMemberMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import {
  channelInputs,
  documentKey,
  resolveMemoryAccess,
  scopeNameInput,
} from "../../ops/MemoryAccessOps";
import { memoryPathInput } from "../../ops/MemoryChunkOps";
import {
  auditMemoryDocument,
  currentVersion,
  memoryNotFound,
  serializeMemoryDocument,
  setPinned,
} from "../../ops/MemoryOps";

/**
 * `memory:pin` — pin or unpin a memory document. A pinned memory never
 * fades, in ranking or by the decay clock. Same access as writing it.
 */
export class MemoryPin extends AuditedAction {
  name = "memory:pin";
  description =
    "Pin a memory document so it never fades (in search ranking or by the decay clock), or unpin it. Same access as memory:write.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/memory/document/pin",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    scope: scopeNameInput,
    ...channelInputs,
    path: memoryPathInput,
    pinned: z.boolean().default(true).describe("true pins; false unpins"),
  });

  /**
   * @param tx - The transaction the change and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The document.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<MemoryPin>,
    connection: AuditedConnection,
  ) {
    const access = await resolveMemoryAccess(
      tx,
      params,
      connection.metadata.callerTags ?? [],
      "write",
    );
    const key = documentKey(access, params.scope, params.path);
    const before = await currentVersion(tx, key);
    const row = await setPinned(tx, key, params.pinned);
    if (!before || !row) throw memoryNotFound();
    connection.metadata.auditTargetType = "memory-document";
    connection.metadata.auditTargetPath = `${params.scope}:${params.path}`;
    connection.metadata.auditBefore = auditMemoryDocument(before);
    connection.metadata.auditAfter = auditMemoryDocument(row);
    return { document: serializeMemoryDocument(row) };
  }
}
