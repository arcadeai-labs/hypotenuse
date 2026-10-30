import { type ActionParams, api, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { enqueueEmbed, staleChunkCount } from "../../ops/MemoryOps";
import { embeddingModel } from "../../ops/ModelOps";

/**
 * `memory:reindex` — re-embed every chunk of the project's memory whose
 * vector was made by another embedding model, dimension, or search-text
 * recipe (or not yet made). Admin-only and audited: it spends the
 * project's embedding budget. The work runs in the background.
 */
export class MemoryReindex extends AuditedAction {
  name = "memory:reindex";
  description =
    "Re-embed the project's memory chunks that have no vector for its current embedding model, in the background. Needed after the embedding model changes; search ranks those chunks by keyword alone until it finishes. Returns how many chunks are queued. Requires admin standing.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/memory/reindex",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({ projectId: idInput("The project") });

  /**
   * @param tx - The transaction the audit row is written in.
   * @param params - The project.
   * @param connection - The caller's connection.
   * @returns The embedding model and how many chunks wait for it.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<MemoryReindex>,
    connection: AuditedConnection,
  ) {
    const model = await embeddingModel(params.projectId);
    const stale = model
      ? await staleChunkCount(tx, params.projectId, model.revision)
      : 0;
    const result = {
      embeddingModel: model?.modelId ?? null,
      queuedChunks: stale,
    };
    connection.metadata.auditTargetType = "memory-index";
    connection.metadata.auditTargetPath = String(params.projectId);
    connection.metadata.auditAfter = result;
    return result;
  }

  /**
   * Start the embedding run.
   * @param result - The response.
   * @param params - The project.
   */
  async afterCommit(
    result: { queuedChunks: number },
    params: ActionParams<MemoryReindex>,
  ) {
    if (result.queuedChunks > 0) await enqueueEmbed(params.projectId);
    else api.logger.debug("memory:reindex found nothing stale");
  }
}
