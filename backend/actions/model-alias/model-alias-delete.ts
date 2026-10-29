import { eq } from "drizzle-orm";
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
  botsNamingAlias,
  loadModelAlias,
  serializeModelAlias,
} from "../../ops/ModelOps";
import { modelAliases } from "../../schema/model_aliases";

/**
 * `model-alias:delete` — remove a model name from the project. Requires admin
 * standing. Refused while any bot names it, listing the bots.
 */
export class ModelAliasDelete extends AuditedAction {
  name = "model-alias:delete";
  description =
    "Delete a model alias from a project. Refused while any bot names it as its model or fast model; the refusal lists those bots. Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/model-alias/:aliasId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    aliasId: idInput("The model alias to delete"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - `projectId` and `aliasId`.
   * @param connection - The caller's connection (audit snapshots written here).
   * @returns The deleted alias.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`; `CONNECTION_ACTION_PARAM_VALIDATION`
   *   while a bot names it.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ModelAliasDelete>,
    connection: AuditedConnection,
  ) {
    const row = await loadModelAlias(tx, params.projectId, params.aliasId, {
      lock: true,
    });
    const naming = await botsNamingAlias(tx, params.projectId, row.name);
    if (naming.length > 0) {
      throw new TypedError({
        message: `The model "${row.name}" is named by ${naming.map((b) => `"${b.name}"`).join(", ")}. Point ${naming.length === 1 ? "that bot" : "those bots"} at another model first.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "aliasId",
      });
    }

    await tx.delete(modelAliases).where(eq(modelAliases.id, row.id));
    const serialized = serializeModelAlias(row);
    connection.metadata.auditBefore = serialized;
    connection.metadata.auditTargetType = "model-alias";
    connection.metadata.auditTargetPath = row.name;
    return { modelAlias: serialized };
  }
}
