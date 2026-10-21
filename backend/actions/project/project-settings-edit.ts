import { eq } from "drizzle-orm";
import { type ActionParams, HTTP_METHOD } from "keryx";
import { z } from "zod";
import {
  AuditedAction,
  type AuditedConnection,
  type TxHandle,
} from "../../classes/AuditedAction";
import { AdminMiddleware } from "../../middleware/rbac";
import {
  getOrCreateSettings,
  RoutingSettingsEditInput,
  serializeProjectSettings,
} from "../../ops/ProjectSettingsOps";
import { projectSettings } from "../../schema/project_settings";

/**
 * `project:settings-edit` — change a project's settings. Today that is the
 * `routing` section: the queue, sticky, offer, and stop timers and the
 * repository-confidence threshold. Keys left out keep their value; a key set
 * to `null` returns to its default. Admin only.
 */
export class ProjectSettingsEdit extends AuditedAction {
  name = "project:settings-edit";
  description =
    "Change a project's settings: the routing section's timers (queueTimeoutMs, stickyTimeoutMs, offerTtlMs, stopGraceMs), repositoryConfidence, and maxReviewRounds. Keys left out keep their value; null restores the default. Requires the admin tag on the project.";
  middleware = [AdminMiddleware()];
  web = { route: "/project/settings", method: HTTP_METHOD.POST };
  inputs = z.object({
    projectId: z.coerce
      .number()
      .int()
      .positive()
      .describe("The project whose settings to change"),
    routing: RoutingSettingsEditInput.optional().describe(
      "Routing settings to change; null restores a key's default",
    ),
  });

  /**
   * @param tx - The transaction the update and its audit row share.
   * @param params - What to change.
   * @param connection - The caller's connection.
   * @returns The settings, resolved.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ProjectSettingsEdit>,
    connection: AuditedConnection,
  ) {
    const before = await getOrCreateSettings(tx, params.projectId);
    const routing: Record<string, unknown> = { ...before.routing };
    for (const [key, value] of Object.entries(params.routing ?? {})) {
      if (value === undefined) continue;
      if (value === null) delete routing[key];
      else routing[key] = value;
    }
    const [after] = await tx
      .update(projectSettings)
      .set({ routing })
      .where(eq(projectSettings.id, before.id))
      .returning();
    connection.metadata.auditBefore = serializeProjectSettings(before);
    connection.metadata.auditAfter = serializeProjectSettings(after);
    connection.metadata.auditTargetType = "project_settings";
    connection.metadata.auditTargetPath = "routing";
    return { settings: serializeProjectSettings(after) };
  }
}
