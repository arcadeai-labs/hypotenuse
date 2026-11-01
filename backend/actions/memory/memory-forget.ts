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
  lockDocument,
  memoryNotFound,
  serializeMemoryDocument,
  writeVersion,
} from "../../ops/MemoryOps";

/**
 * `memory:forget` — tombstone a memory document. Search and lists stop
 * showing it; its history stays. Same access as writing it.
 */
export class MemoryForget extends AuditedAction {
  name = "memory:forget";
  description =
    "Forget a memory document: it stops appearing in search and lists, and its history is kept. Same access as memory:write — project memory needs admin standing, channel memory needs write access to a bot working in the channel.";
  middleware = [ProjectMemberMiddleware()];
  web = {
    route: "/project/:projectId/memory/document",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    scope: scopeNameInput,
    ...channelInputs,
    path: memoryPathInput,
    reason: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .optional()
      .describe("Why it is forgotten"),
  });

  /**
   * @param tx - The transaction the tombstone and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (tags set by the middleware).
   * @returns The tombstone.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND` for a document not there.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<MemoryForget>,
    connection: AuditedConnection,
  ) {
    const access = await resolveMemoryAccess(
      tx,
      params,
      connection.metadata.callerTags ?? [],
      "write",
    );
    const key = documentKey(access, params.scope, params.path);
    await lockDocument(tx, key);
    const current = await currentVersion(tx, key);
    if (!current || current.tombstone) throw memoryNotFound();
    const userId = connection.session?.data.userId ?? null;
    const { row } = await writeVersion(tx, key, {
      content: "",
      tombstone: true,
      changeNote: params.reason ?? "Forgotten by a person",
      sourceType: "person",
      sourceRef: userId ? { userId } : {},
      authorUserId: userId,
    });
    connection.metadata.auditTargetType = "memory-document";
    connection.metadata.auditTargetPath = `${params.scope}:${params.path}`;
    connection.metadata.auditBefore = auditMemoryDocument(current);
    connection.metadata.auditAfter = auditMemoryDocument(row);
    return { document: serializeMemoryDocument(row) };
  }
}
