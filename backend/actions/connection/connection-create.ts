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
  connectionKindInput,
  connectionSecretShape,
  loadProjectConnection,
  probeConnection,
  serializeProjectConnection,
  validateConnectionConfig,
} from "../../ops/SandboxCredentialOps";
import { projectConnections } from "../../schema/project_connections";

/**
 * `connection:create` — connect a project to an account on a service that is
 * not a model provider: today, a Vercel team and project for sandboxes. The
 * connection is probed before it is saved, so a bad token fails here; the
 * token is sealed and never returned. One connection per kind per project.
 * Requires admin standing.
 */
export class ConnectionCreate extends AuditedAction {
  name = "connection:create";
  description =
    "Connect the project to an account a sandbox provider runs on (kind vercel: config { teamId, projectId } and a token). The connection is probed before it is saved, so a bad token, team, or project is refused here. The token is encrypted and never returned; only its last four characters are. One connection per kind. Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = { route: "/project/:projectId/connection", method: HTTP_METHOD.PUT };
  inputs = z.object({
    projectId: idInput("The project to connect"),
    kind: connectionKindInput,
    name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe("A name for the connection; the kind's label by default"),
    config: connectionConfigInput,
    token: secret(
      connectionSecretShape.describe(
        "The account's access token. Stored encrypted; never returned",
      ),
    ),
  });

  /**
   * @param tx - The transaction the insert and its audit row share.
   * @param params - The validated inputs.
   * @param connection - The caller's connection (audit snapshots written here).
   * @returns The connection, without its token.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` for a kind the
   *   project already has, a missing field, or a probe that fails.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ConnectionCreate>,
    connection: AuditedConnection,
  ) {
    const definition = connectionDefinition(params.kind);
    const config = validateConnectionConfig(definition, params.config);
    if (await loadProjectConnection(tx, params.projectId, params.kind)) {
      throw new TypedError({
        message: `This project already has a ${definition.label} connection; edit it to replace its token.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "kind",
      });
    }
    const probe = await probeConnection(params.kind, {
      config,
      secret: params.token,
    });
    if (probe.status !== "ok") {
      throw new TypedError({
        message: `${definition.label} refused the connection: ${probe.message}`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "token",
      });
    }
    const [row] = await tx
      .insert(projectConnections)
      .values({
        projectId: params.projectId,
        kind: params.kind,
        name: params.name ?? definition.label,
        config,
        secret: encryptSecret(params.token),
        lastFour: lastFourOf(params.token),
        status: "ok",
        lastCheckedAt: new Date(),
        createdByUserId: connection.session?.data.userId ?? null,
      })
      .returning();
    const serialized = serializeProjectConnection(row);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "connection";
    connection.metadata.auditTargetPath = row.kind;
    return { connection: serialized };
  }
}
