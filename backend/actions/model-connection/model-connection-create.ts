import { and, eq } from "drizzle-orm";
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
  providerInput,
  serializeModelConnection,
} from "../../ops/ModelOps";
import { modelConnections } from "../../schema/model_connections";

/**
 * `model-connection:create` — connect a model provider to a project with an API
 * key. Requires admin standing. The key is sealed before it is written and
 * never returned; the connection starts `unverified` until
 * `model-connection:test` proves it.
 */
export class ModelConnectionCreate extends AuditedAction {
  name = "model-connection:create";
  description =
    "Connect a model provider (anthropic, openai, gateway, or openai-compatible) to a project with an API key. The key is encrypted and never returned; only its last four characters are. Requires admin standing in the project. Run model-connection:test next to verify the key.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/model-connection",
    method: HTTP_METHOD.PUT,
  };
  inputs = z.object({
    projectId: idInput("The project to connect the provider to"),
    name: connectionNameInput,
    provider: providerInput,
    baseUrl: baseUrlInput.optional(),
    apiKey: secret(
      z
        .string()
        .trim()
        .min(1, "An API key is required")
        .max(4096)
        .describe("The provider's API key. Stored encrypted; never returned"),
    ),
  });

  /**
   * @param tx - The transaction the insert and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (audit snapshots written here).
   * @returns The connection, without its key.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` for a taken name or
   *   an unusable base URL.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ModelConnectionCreate>,
    connection: AuditedConnection,
  ) {
    const baseUrl = params.baseUrl ?? null;
    await assertUsableBaseUrl(params.provider, baseUrl);

    const [taken] = await tx
      .select({ id: modelConnections.id })
      .from(modelConnections)
      .where(
        and(
          eq(modelConnections.projectId, params.projectId),
          eq(modelConnections.name, params.name),
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

    const [row] = await tx
      .insert(modelConnections)
      .values({
        projectId: params.projectId,
        name: params.name,
        provider: params.provider,
        baseUrl,
        secret: encryptSecret(params.apiKey),
        lastFour: lastFourOf(params.apiKey),
        createdByUserId: connection.session?.data.userId ?? null,
      })
      .returning();

    const serialized = serializeModelConnection(row);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "model-connection";
    connection.metadata.auditTargetPath = row.name;
    return { modelConnection: serialized };
  }
}
