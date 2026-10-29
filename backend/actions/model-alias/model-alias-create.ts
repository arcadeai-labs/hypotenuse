import { and, eq } from "drizzle-orm";
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
  loadModelConnection,
  modelIdInput,
  serializeModelAlias,
} from "../../ops/ModelOps";
import { MODEL_ALIAS_KINDS, modelAliases } from "../../schema/model_aliases";

/**
 * `model-alias:create` — name a model for the project: `default`, `fast`, or any
 * other name bots can choose. Requires admin standing, because it decides what
 * the project pays for.
 */
export class ModelAliasCreate extends AuditedAction {
  name = "model-alias:create";
  description =
    "Name a model for a project: an alias (default, fast, or any lowercase name) pointing at a model connection and one of its model ids, with optional call options. Bots choose models by alias. Every project needs default and fast before its bots can run. Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = { route: "/project/:projectId/model-alias", method: HTTP_METHOD.PUT };
  inputs = z.object({
    projectId: idInput("The project"),
    name: aliasNameInput(
      "The alias name: default, fast, or any lowercase name such as reasoning",
    ),
    kind: z
      .enum(MODEL_ALIAS_KINDS)
      .default("language")
      .describe("What the model is for: language"),
    connectionId: idInput("The model connection the alias calls through"),
    modelId: modelIdInput,
    options: aliasOptionsInput.default({}),
  });

  /**
   * @param tx - The transaction the insert and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (audit snapshots written here).
   * @returns The alias.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` for a taken name;
   *   `CONNECTION_ACTION_NOT_FOUND` for a connection not in the project.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ModelAliasCreate>,
    connection: AuditedConnection,
  ) {
    // Locked, so `model-connection:delete` cannot remove it between this
    // check and the insert.
    const modelConnection = await loadModelConnection(
      tx,
      params.projectId,
      params.connectionId,
      { lock: true },
    );
    const [taken] = await tx
      .select({ id: modelAliases.id })
      .from(modelAliases)
      .where(
        and(
          eq(modelAliases.projectId, params.projectId),
          eq(modelAliases.name, params.name),
        ),
      )
      .limit(1);
    if (taken) {
      throw new TypedError({
        message: `This project already has a model named "${params.name}". Edit that alias instead.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "name",
      });
    }

    const [row] = await tx
      .insert(modelAliases)
      .values({
        projectId: params.projectId,
        name: params.name,
        kind: params.kind,
        connectionId: modelConnection.id,
        modelId: params.modelId,
        options: params.options,
      })
      .returning();

    const serialized = serializeModelAlias(row, modelConnection);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "model-alias";
    connection.metadata.auditTargetPath = row.name;
    return { modelAlias: serialized };
  }
}
