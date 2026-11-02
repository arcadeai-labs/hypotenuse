import { and, eq, inArray } from "drizzle-orm";
import {
  type ActionParams,
  config,
  ErrorType,
  HTTP_METHOD,
  TypedError,
} from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../../config/sandbox";
import { AdminMiddleware } from "../../middleware/rbac";
import { idInput } from "../../ops/InputOps";
import { getOrCreateSettings } from "../../ops/ProjectSettingsOps";
import {
  loadProjectConnectionById,
  serializeProjectConnection,
} from "../../ops/SandboxCredentialOps";
import { LIVE_SANDBOX_STATUSES } from "../../ops/SandboxOps";
import { SANDBOX_PROVIDERS } from "../../sandbox/registry";
import { projectConnections } from "../../schema/project_connections";
import { sandboxes } from "../../schema/sandboxes";

/**
 * `connection:delete` — remove a connection. Refused while the project's
 * sandbox provider runs on it, or while a sandbox on it is live: without the
 * account, nothing could destroy that sandbox. Requires admin standing.
 */
export class ConnectionDelete extends AuditedAction {
  name = "connection:delete";
  description =
    "Remove one of the project's connections. Refused while the project's sandbox provider uses it (switch providers first) or while a sandbox on it is still live (destroy it under Sandboxes, or wait for it to end). Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/connection/:connectionId",
    method: HTTP_METHOD.DELETE,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    connectionId: idInput("The connection to remove"),
  });

  /**
   * @param tx - The transaction the delete and its audit row share.
   * @param params - `projectId` and `connectionId`.
   * @param connection - The caller's connection (audit snapshots written here).
   * @returns The removed connection.
   * @throws {TypedError} `CONNECTION_ACTION_PARAM_VALIDATION` while it is in use.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ConnectionDelete>,
    connection: AuditedConnection,
  ) {
    const row = await loadProjectConnectionById(
      tx,
      params.projectId,
      params.connectionId,
      { lock: true },
    );
    connection.metadata.auditBefore = serializeProjectConnection(row);
    const kinds = Object.values(SANDBOX_PROVIDERS)
      .filter((d) => d.connectionKind === row.kind)
      .map((d) => d.kind);
    const settings = await getOrCreateSettings(tx, params.projectId);
    const provider = settings.sandboxProvider || config.sandbox.defaultProvider;
    if (kinds.includes(provider as (typeof kinds)[number])) {
      throw new TypedError({
        message: `The project's sandboxes run on this connection. Choose another sandbox provider under Settings → Sandboxes before removing it.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "connectionId",
      });
    }
    if (kinds.length > 0) {
      const [live] = await tx
        .select({ id: sandboxes.id })
        .from(sandboxes)
        .where(
          and(
            eq(sandboxes.projectId, params.projectId),
            inArray(sandboxes.provider, kinds),
            inArray(sandboxes.status, LIVE_SANDBOX_STATUSES),
          ),
        )
        .limit(1);
      if (live) {
        throw new TypedError({
          message: `Sandbox ${live.id} on this connection is still live, and could not be destroyed without it. Destroy it under Sandboxes, or wait for its job to end.`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "connectionId",
        });
      }
    }
    await tx
      .delete(projectConnections)
      .where(eq(projectConnections.id, row.id));
    connection.metadata.auditTargetType = "connection";
    connection.metadata.auditTargetPath = row.kind;
    return { connection: serializeProjectConnection(row) };
  }
}
