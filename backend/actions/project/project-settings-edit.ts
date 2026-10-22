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
  applySectionEdit,
  getOrCreateSettings,
  ManagerSettingsEditInput,
  RoutingSettingsEditInput,
  serializeProjectSettings,
} from "../../ops/ProjectSettingsOps";
import { projectSettings } from "../../schema/project_settings";

/**
 * `project:settings-edit` — change a project's settings: the `routing`
 * section (the queue, sticky, offer, and stop timers, the
 * repository-confidence threshold, the review-round limit) and the `manager`
 * section (whether a manager may complete issues, how many dispatches it may
 * have under way). Keys left out keep their value; a key set to `null`
 * returns to its default. Admin only.
 */
export class ProjectSettingsEdit extends AuditedAction {
  name = "project:settings-edit";
  description =
    "Change a project's settings: the routing section's timers (queueTimeoutMs, stickyTimeoutMs, offerTtlMs, stopGraceMs), repositoryConfidence, and maxReviewRounds; and the manager section (canCompleteIssues, maxParallelDispatch). Keys left out keep their value; null restores the default. Requires the admin tag on the project.";
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
    manager: ManagerSettingsEditInput.optional().describe(
      "Manager settings to change; null restores a key's default",
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
    const routing = applySectionEdit(before.routing, params.routing);
    const manager = applySectionEdit(before.manager, params.manager);
    const [after] = await tx
      .update(projectSettings)
      .set({ routing, manager })
      .where(eq(projectSettings.id, before.id))
      .returning();
    connection.metadata.auditBefore = serializeProjectSettings(before);
    connection.metadata.auditAfter = serializeProjectSettings(after);
    connection.metadata.auditTargetType = "project_settings";
    connection.metadata.auditTargetPath =
      [params.routing ? "routing" : null, params.manager ? "manager" : null]
        .filter(Boolean)
        .join(",") || undefined;
    return { settings: serializeProjectSettings(after) };
  }
}
