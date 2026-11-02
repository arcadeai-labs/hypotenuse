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
  loadProjectConnectionById,
  openConnection,
  probeConnection,
  serializeProjectConnection,
} from "../../ops/SandboxCredentialOps";
import { projectConnections } from "../../schema/project_connections";

/**
 * `connection:test` — probe a saved connection and record the result as its
 * status. Audited: it writes the row. Requires admin standing.
 */
export class ConnectionTest extends AuditedAction {
  name = "connection:test";
  description =
    "Probe one of the project's connections against its service, through the server, and record the result as its status (ok or error, with the reason). Creates nothing. Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = {
    route: "/project/:projectId/connection/:connectionId/test",
    method: HTTP_METHOD.POST,
  };
  inputs = z.object({
    projectId: idInput("The project"),
    connectionId: idInput("The connection to test"),
  });

  /**
   * @param tx - The transaction the status update and its audit row share.
   * @param params - `projectId` and `connectionId`.
   * @param connection - The caller's connection (audit snapshots written here).
   * @returns The connection with its new status, and what the probe said.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ConnectionTest>,
    connection: AuditedConnection,
  ) {
    // Locked across the probe, so a token replaced meanwhile cannot have
    // this probe's verdict written over it.
    const row = await loadProjectConnectionById(
      tx,
      params.projectId,
      params.connectionId,
      { lock: true },
    );
    connection.metadata.auditBefore = serializeProjectConnection(row);
    const probe = await probeConnection(row.kind, openConnection(row));
    const [updated] = await tx
      .update(projectConnections)
      .set({
        status: probe.status,
        lastCheckedAt: new Date(),
        lastError: probe.status === "ok" ? null : probe.message,
      })
      .where(eq(projectConnections.id, row.id))
      .returning();
    const serialized = serializeProjectConnection(updated);
    connection.metadata.auditAfter = serialized;
    connection.metadata.auditTargetType = "connection";
    connection.metadata.auditTargetPath = updated.kind;
    return { connection: serialized, message: probe.message };
  }
}
