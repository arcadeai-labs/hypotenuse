import { eq } from "drizzle-orm";
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
import {
  getOrCreateSettings,
  serializeProjectSettings,
} from "../../ops/ProjectSettingsOps";
import { assertSandboxProviderAllowed } from "../../sandbox/registry";
import { projectSettings } from "../../schema/project_settings";

/**
 * `project:settings-edit` — change a project's settings: where its sandbox
 * jobs run, the image, how many run at once, and how long one may run. Only
 * the fields sent change; null returns a field to the deployment's default.
 * A provider this deployment may not use (`docker` in production) is refused
 * here, as well as when a job starts. Requires admin standing.
 */
export class ProjectSettingsEdit extends AuditedAction {
  name = "project:settings-edit";
  description =
    "Change a project's sandbox settings: sandboxProvider (where code jobs run; docker is for development only), sandboxImage, sandboxConcurrency (jobs at once), and sandboxMaxDurationMs (which may only lower the deployment's ceiling). Only the fields sent change; null restores the default. Requires admin standing in the project.";
  middleware = [AdminMiddleware()];
  web = { route: "/project/:projectId/settings", method: HTTP_METHOD.POST };
  inputs = z.object({
    projectId: idInput("The project"),
    sandboxProvider: z
      .string()
      .trim()
      .max(40)
      .nullable()
      .optional()
      .describe("Where sandbox jobs run, e.g. docker; null for the default"),
    sandboxImage: z
      .string()
      .trim()
      .max(300)
      .regex(/^[A-Za-z0-9][\w./:@-]*$/, "an image reference")
      .nullable()
      .optional()
      .describe("The image a job's sandbox runs; null for the provider's own"),
    sandboxConcurrency: z
      .number()
      .int()
      .min(1)
      .max(50)
      .nullable()
      .optional()
      .describe("How many sandbox jobs may run at once; null for the default"),
    sandboxMaxDurationMs: z
      .number()
      .int()
      .min(60_000)
      .nullable()
      .optional()
      .describe(
        "The longest one job may run, in milliseconds; at most the deployment's ceiling. null for the ceiling",
      ),
  });

  /**
   * @param tx - The transaction the change and its audit row share.
   * @param params - The inputs.
   * @param connection - The caller's connection.
   * @returns The settings.
   */
  async runWithAudit(
    tx: TxHandle,
    params: ActionParams<ProjectSettingsEdit>,
    connection: AuditedConnection,
  ) {
    const before = await getOrCreateSettings(tx, params.projectId);
    connection.metadata.auditBefore = serializeProjectSettings(before);
    if (params.sandboxProvider) {
      assertSandboxProviderAllowed(params.sandboxProvider);
    }
    if (
      params.sandboxMaxDurationMs &&
      params.sandboxMaxDurationMs > config.sandbox.maxDurationMs
    ) {
      throw new TypedError({
        message: `sandboxMaxDurationMs may only lower the deployment's ceiling of ${config.sandbox.maxDurationMs} ms.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "sandboxMaxDurationMs",
      });
    }
    const changes: Partial<typeof projectSettings.$inferInsert> = {};
    if (params.sandboxProvider !== undefined) {
      changes.sandboxProvider = params.sandboxProvider || null;
    }
    if (params.sandboxImage !== undefined) {
      changes.sandboxConfig = params.sandboxImage
        ? { ...before.sandboxConfig, image: params.sandboxImage }
        : {};
    }
    if (params.sandboxConcurrency !== undefined) {
      changes.sandboxConcurrency = params.sandboxConcurrency;
    }
    if (params.sandboxMaxDurationMs !== undefined) {
      changes.sandboxMaxDurationMs = params.sandboxMaxDurationMs;
    }
    const [after] =
      Object.keys(changes).length > 0
        ? await tx
            .update(projectSettings)
            .set(changes)
            .where(eq(projectSettings.id, before.id))
            .returning()
        : [before];
    const settings = serializeProjectSettings(after);
    connection.metadata.auditAfter = settings;
    connection.metadata.auditTargetType = "project-settings";
    connection.metadata.auditTargetPath = String(params.projectId);
    return { settings };
  }
}
