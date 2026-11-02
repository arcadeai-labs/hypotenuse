import { eq } from "drizzle-orm";
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
  connectionConfigInput,
  connectionDefinition,
  connectionSecretShape,
  loadProjectConnectionById,
  openConnection,
  probeConnection,
  serializeProjectConnection,
  validateConnectionConfig,
} from "../../ops/SandboxCredentialOps";
import { projectConnections } from "../../schema/project_connections";

/**
 * `connection:edit` — rename a connection, change its fields, or replace its
 * token. A change to the fields or the token is probed before it is saved;
 * the old values stay until the new ones work. Requires admin standing.
 */
export class ConnectionEdit extends AuditedAction {
  name = "connection:edit";
  description =
    "Change one of the project's connections: its name, its non-secret config (sent whole), or its token. A new config or token is probed before it is saved; a failing one is refused and the old one kept. Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/connection/:connectionId",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    connectionId: idInput("The connection"),
    name: z.string().trim().min(1).max(80).optional().describe("A new name"),
    config: connectionConfigInput.optional(),
    token: secret(
      connectionSecretShape
        .describe("A replacement token. Stored encrypted; never returned")
        .optional(),
    ),
  });

  /**
   * @param tx - The transaction the update and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (audit snapshots written here).
   * @returns The connection, without its token.
   * @throws {TypedError} When the new config or token fails its probe.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ConnectionEdit>,
    connection: AuditedConnection,
  ) {
    const row = await loadProjectConnectionById(
      tx,
      params.projectId,
      params.connectionId,
      { lock: true },
    );
    connection.metadata.auditBefore = serializeProjectConnection(row);
    const definition = connectionDefinition(row.kind);
    const changes: Partial<typeof projectConnections.$inferInsert> = {};
    if (params.name !== undefined) changes.name = params.name;
    if (params.config !== undefined || params.token !== undefined) {
      const current = openConnection(row);
      const next = {
        config:
          params.config !== undefined
            ? validateConnectionConfig(definition, params.config)
            : current.config,
        secret: params.token ?? current.secret,
      };
      const probe = await probeConnection(row.kind, next);
      if (probe.status !== "ok") {
        throw new TypedError({
          message: `${definition.label} refused the change: ${probe.message}`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: params.token !== undefined ? "token" : "config",
        });
      }
      changes.config = next.config;
      if (params.token !== undefined) {
        changes.secret = encryptSecret(params.token);
        changes.lastFour = lastFourOf(params.token);
      }
      changes.status = "ok";
      changes.lastCheckedAt = new Date();
      changes.lastError = null;
    }
    const [updated] =
      Object.keys(changes).length > 0
        ? await tx
            .update(projectConnections)
            .set(changes)
            .where(eq(projectConnections.id, row.id))
            .returning()
        : [row];
    const serialized = serializeProjectConnection(updated);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "connection";
    connection.metadata.auditTargetPath = updated.kind;
    return { connection: serialized };
  }
}
