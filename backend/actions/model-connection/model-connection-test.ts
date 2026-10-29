import { eq } from "drizzle-orm";
import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import {
  loadModelConnection,
  probeConnection,
  serializeModelConnection,
} from "../../ops/ModelOps";
import { modelConnections } from "../../schema/model_connections";

/**
 * `model-connection:test` — prove a connection's key works against its
 * endpoint, and record the answer as its status. Requires admin standing.
 * Audited because it writes the status every member sees.
 *
 * A failed probe is not a failed request: it answers 200 with `status: "error"`
 * and the sentence that explains it, since that is a fact about the key.
 */
export class ModelConnectionTest extends AuditedAction {
  name = "model-connection:test";
  description =
    "Verify a model connection's API key against its provider, through the server, and record the result as its status (ok or error, with the reason). Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/model-connection/:connectionId/test",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    connectionId: idInput("The model connection to test"),
  });

  /**
   * @param tx - The transaction the status update and its audit row share.
   * @param params - `projectId` and `connectionId`.
   * @param connection - The caller's connection (audit snapshots written here).
   * @returns The connection with its new status.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ModelConnectionTest>,
    connection: AuditedConnection,
  ) {
    // Locked across the probe, so a key rotated meanwhile cannot have this
    // probe's verdict written over it.
    const row = await loadModelConnection(
      tx,
      params.projectId,
      params.connectionId,
      { lock: true },
    );
    connection.metadata.auditBefore = serializeModelConnection(row);

    const result = await probeConnection(row);
    const [updated] = await tx
      .update(modelConnections)
      .set(result)
      .where(eq(modelConnections.id, row.id))
      .returning();

    const serialized = serializeModelConnection(updated);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "model-connection";
    connection.metadata.auditTargetPath = updated.name;
    return { modelConnection: serialized };
  }
}
