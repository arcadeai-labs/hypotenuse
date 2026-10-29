import { and, eq, ne } from "drizzle-orm";
import {
  type ActionParams,
  ErrorType,
  HTTP_METHOD,
  secret,
  TypedError,
} from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import { encryptSecret, lastFourOf } from "../../ops/CryptoOps";
import { idInput } from "../../ops/InputOps";
import {
  assertUsableBaseUrl,
  baseUrlInput,
  connectionNameInput,
  loadModelConnection,
  serializeModelConnection,
} from "../../ops/ModelOps";
import {
  modelConnections,
  type NewModelConnection,
} from "../../schema/model_connections";

/**
 * `model-connection:edit` — rename a connection, change its base URL, or rotate
 * its key. Requires admin standing. A new key or base URL sets the status back
 * to `unverified`, because the last probe no longer describes it.
 */
export class ModelConnectionEdit extends AuditedAction {
  name = "model-connection:edit";
  description =
    "Rename a model connection, change its base URL (null for the provider's default), or rotate its API key. A new key or base URL resets its status to unverified; run model-connection:test after. Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/model-connection/:connectionId",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    connectionId: idInput("The model connection to edit"),
    name: connectionNameInput.optional(),
    baseUrl: baseUrlInput.nullable().optional(),
    apiKey: secret(
      z
        .string()
        .trim()
        .min(1, "An API key cannot be empty")
        .max(4096)
        .optional()
        .describe("A new API key, replacing the stored one. Never returned"),
    ),
  });

  /**
   * @param tx - The transaction the update and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (audit snapshots written here).
   * @returns The connection, without its key.
   * @throws {TypedError} `CONNECTION_ACTION_NOT_FOUND`; `CONNECTION_ACTION_PARAM_VALIDATION`
   *   for a taken name or an unusable base URL.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ModelConnectionEdit>,
    connection: AuditedConnection,
  ) {
    const row = await loadModelConnection(
      tx,
      params.projectId,
      params.connectionId,
      { lock: true },
    );
    connection.metadata.auditBefore = serializeModelConnection(row);

    const changes: Partial<NewModelConnection> = {};
    if (params.name !== undefined && params.name !== row.name) {
      const [taken] = await tx
        .select({ id: modelConnections.id })
        .from(modelConnections)
        .where(
          and(
            eq(modelConnections.projectId, params.projectId),
            eq(modelConnections.name, params.name),
            ne(modelConnections.id, row.id),
          ),
        )
        .limit(1);
      if (taken) {
        throw new TypedError({
          message: `This project already has a model connection named "${params.name}".`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "name",
        });
      }
      changes.name = params.name;
    }
    if (params.baseUrl !== undefined && params.baseUrl !== row.baseUrl) {
      await assertUsableBaseUrl(row.provider, params.baseUrl);
      changes.baseUrl = params.baseUrl;
    }
    if (params.apiKey !== undefined) {
      changes.secret = encryptSecret(params.apiKey);
      changes.lastFour = lastFourOf(params.apiKey);
    }
    if (changes.baseUrl !== undefined || changes.secret !== undefined) {
      changes.status = "unverified";
      changes.lastError = null;
      changes.lastCheckedAt = null;
    }

    const [updated] =
      Object.keys(changes).length > 0
        ? await tx
            .update(modelConnections)
            .set(changes)
            .where(eq(modelConnections.id, row.id))
            .returning()
        : [row];

    const serialized = serializeModelConnection(updated);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "model-connection";
    connection.metadata.auditTargetPath = updated.name;
    return { modelConnection: serialized };
  }
}
