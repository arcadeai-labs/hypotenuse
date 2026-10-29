import { and, eq, ne } from "drizzle-orm";
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
  aliasNameInput,
  aliasOptionsInput,
  botsNamingAlias,
  isReservedModelAlias,
  loadModelAlias,
  loadModelConnection,
  modelIdInput,
  serializeModelAlias,
} from "../../ops/ModelOps";
import { modelAliases, type NewModelAlias } from "../../schema/model_aliases";

/**
 * `model-alias:edit` — repoint an alias at another connection or model, change
 * its options, or rename it. Requires admin standing. Repointing is the point
 * of aliases: every bot naming it follows. Renaming is refused for `default`
 * and `fast`, and while a bot names the alias, since bots name it by name.
 */
export class ModelAliasEdit extends AuditedAction {
  name = "model-alias:edit";
  description =
    "Change what a model alias means: its connection, model id, or call options (every bot naming it follows), or its name. default and fast cannot be renamed, and an alias a bot names cannot be renamed. Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/model-alias/:aliasId",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    aliasId: idInput("The model alias to edit"),
    name: aliasNameInput("A new name for the alias").optional(),
    connectionId: idInput(
      "The model connection the alias calls through",
    ).optional(),
    modelId: modelIdInput.optional(),
    options: aliasOptionsInput.optional(),
  });

  /**
   * @param tx - The transaction the update and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (audit snapshots written here).
   * @returns The alias.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`; `CONNECTION_ACTION_PARAM_VALIDATION`
   *   for a refused rename or a taken name.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ModelAliasEdit>,
    connection: AuditedConnection,
  ) {
    const row = await loadModelAlias(tx, params.projectId, params.aliasId, {
      lock: true,
    });
    const current = await loadModelConnection(
      tx,
      params.projectId,
      row.connectionId,
    );
    connection.metadata.auditBefore = serializeModelAlias(row, current);

    const changes: Partial<NewModelAlias> = {};
    if (params.name !== undefined && params.name !== row.name) {
      if (isReservedModelAlias(row.name)) {
        throw new TypedError({
          message: `"${row.name}" is a required model name and cannot be renamed. Repoint it instead.`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "name",
        });
      }
      const naming = await botsNamingAlias(tx, params.projectId, row.name);
      if (naming.length > 0) {
        throw new TypedError({
          message: `"${row.name}" is named by ${naming.map((b) => `"${b.name}"`).join(", ")}, so renaming it would leave ${naming.length === 1 ? "that bot" : "those bots"} without a model. Point ${naming.length === 1 ? "it" : "them"} at another alias first.`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "name",
        });
      }
      const [taken] = await tx
        .select({ id: modelAliases.id })
        .from(modelAliases)
        .where(
          and(
            eq(modelAliases.projectId, params.projectId),
            eq(modelAliases.name, params.name),
            ne(modelAliases.id, row.id),
          ),
        )
        .limit(1);
      if (taken) {
        throw new TypedError({
          message: `This project already has a model named "${params.name}".`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "name",
        });
      }
      changes.name = params.name;
    }
    let target = current;
    if (
      params.connectionId !== undefined &&
      params.connectionId !== row.connectionId
    ) {
      target = await loadModelConnection(
        tx,
        params.projectId,
        params.connectionId,
        { lock: true },
      );
      changes.connectionId = target.id;
    }
    if (params.modelId !== undefined) changes.modelId = params.modelId;
    if (params.options !== undefined) changes.options = params.options;

    const [updated] =
      Object.keys(changes).length > 0
        ? await tx
            .update(modelAliases)
            .set(changes)
            .where(eq(modelAliases.id, row.id))
            .returning()
        : [row];

    const serialized = serializeModelAlias(updated, target);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "model-alias";
    connection.metadata.auditTargetPath = updated.name;
    return { modelAlias: serialized };
  }
}
