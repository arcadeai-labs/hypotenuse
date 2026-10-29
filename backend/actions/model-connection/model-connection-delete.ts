import { asc, eq } from "drizzle-orm";
import { type ActionParams, ErrorType, HTTP_METHOD, TypedError } from "keryx";
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
  serializeModelConnection,
} from "../../ops/ModelOps";
import { modelAliases } from "../../schema/model_aliases";
import { modelConnections } from "../../schema/model_connections";

/**
 * `model-connection:delete` — remove a connection and its key. Requires admin
 * standing. Refused while any model alias uses it, naming the aliases: deleting
 * it would leave every bot behind them without a model.
 */
export class ModelConnectionDelete extends AuditedAction {
  name = "model-connection:delete";
  description =
    "Delete a model connection and its stored key. Refused while any model alias uses it; repoint or delete those aliases first. Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/model-connection/:connectionId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    connectionId: idInput("The model connection to delete"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - `projectId` and `connectionId`.
   * @param connection - The caller's connection (audit snapshots written here).
   * @returns The deleted connection.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`; `CONNECTION_ACTION_PARAM_VALIDATION`
   *   while an alias uses it.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ModelConnectionDelete>,
    connection: AuditedConnection,
  ) {
    // Locked, so an alias created against it concurrently waits and then
    // fails on the missing row rather than slipping in after the check.
    const row = await loadModelConnection(
      tx,
      params.projectId,
      params.connectionId,
      { lock: true },
    );
    const using = await tx
      .select({ name: modelAliases.name })
      .from(modelAliases)
      .where(eq(modelAliases.connectionId, row.id))
      .orderBy(asc(modelAliases.name));
    if (using.length > 0) {
      throw new TypedError({
        message: `The model connection "${row.name}" is used by the model ${using.length === 1 ? "alias" : "aliases"} ${using.map((a) => `"${a.name}"`).join(", ")}. Point ${using.length === 1 ? "it" : "them"} at another connection, or delete ${using.length === 1 ? "it" : "them"}, first.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "connectionId",
      });
    }

    await tx.delete(modelConnections).where(eq(modelConnections.id, row.id));
    const serialized = serializeModelConnection(row);
    connection.metadata.auditBefore = serialized;
    connection.metadata.auditTargetType = "model-connection";
    connection.metadata.auditTargetPath = row.name;
    return { modelConnection: serialized };
  }
}
