import { and, eq } from "drizzle-orm";
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
import {
  loadProjectConnection,
  openConnection,
  probeConnection,
} from "../../ops/SandboxCredentialOps";
import {
  assertSandboxProviderAllowed,
  canNarrowEgress,
} from "../../sandbox/registry";
import { bots } from "../../schema/bots";
import {
  projectSettings,
  SANDBOX_EGRESS_MODES,
  type SandboxConfig,
} from "../../schema/project_settings";

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
    "Change a project's sandbox settings: sandboxProvider (where code jobs run: docker is for development only; vercel needs the project's vercel connection, probed here), sandboxImage (docker) or sandboxRuntime and sandboxVcpus (vercel), sandboxEgressMode (open-world or allowlist), sandboxConcurrency (jobs at once), and sandboxMaxDurationMs (which may only lower the deployment's ceiling). Only the fields sent change; null restores the default. Answers warnings for bots whose required egress allowlist the provider cannot hold. Requires admin standing in the project.";
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
    sandboxRuntime: z
      .string()
      .trim()
      .max(40)
      .nullable()
      .optional()
      .describe(
        "The stock runtime a job's sandbox boots, for a provider that boots runtimes (vercel: node24, node22, python3.13); null for the provider's default",
      ),
    sandboxVcpus: z
      .number()
      .int()
      .min(1)
      .max(64)
      .nullable()
      .optional()
      .describe(
        "vCPUs per sandbox, for a provider that sizes them (vercel: 1–8, 2 GiB each); null for the default",
      ),
    sandboxEgressMode: z
      .enum(SANDBOX_EGRESS_MODES)
      .nullable()
      .optional()
      .describe(
        "open-world (the default: open egress, a repository job narrowed where the provider can) or allowlist (every job narrowed to this API and its git hosts before its agent starts; needs a provider that can enforce one)",
      ),
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
    const providerKind =
      params.sandboxProvider === undefined
        ? before.sandboxProvider || config.sandbox.defaultProvider
        : params.sandboxProvider || config.sandbox.defaultProvider;
    const definition = assertSandboxProviderAllowed(
      providerKind,
      "sandboxProvider",
    );
    // A provider on the project's own account needs that account, proven,
    // before jobs are sent to it.
    if (params.sandboxProvider && definition.connectionKind) {
      const row = await loadProjectConnection(
        tx,
        params.projectId,
        definition.connectionKind,
      );
      if (!row) {
        throw new TypedError({
          message: `${definition.label} runs on the project's own account: add a ${definition.connectionKind} connection under Settings → Sandboxes first.`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "sandboxProvider",
        });
      }
      const probe = await probeConnection(row.kind, openConnection(row));
      if (probe.status !== "ok") {
        throw new TypedError({
          message: `The project's ${definition.connectionKind} connection does not work: ${probe.message}`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "sandboxProvider",
        });
      }
    }
    const options = definition.options;
    if (params.sandboxImage && !options.image) {
      throw new TypedError({
        message: `${definition.label} boots stock runtimes, not images; set sandboxRuntime instead.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key: "sandboxImage",
      });
    }
    if (params.sandboxRuntime) {
      if (!options.runtimes) {
        throw new TypedError({
          message: `${definition.label} boots images, not stock runtimes; set sandboxImage instead.`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "sandboxRuntime",
        });
      }
      if (!options.runtimes.values.includes(params.sandboxRuntime)) {
        throw new TypedError({
          message: `sandboxRuntime must be one of: ${options.runtimes.values.join(", ")}.`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "sandboxRuntime",
        });
      }
    }
    if (params.sandboxVcpus) {
      const range = options.vcpus;
      if (
        !range ||
        params.sandboxVcpus < range.min ||
        params.sandboxVcpus > range.max
      ) {
        throw new TypedError({
          message: range
            ? `sandboxVcpus must be between ${range.min} and ${range.max} for ${definition.label}.`
            : `${definition.label} does not size its sandboxes; leave sandboxVcpus unset.`,
          type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
          key: "sandboxVcpus",
        });
      }
    }
    const egressMode =
      params.sandboxEgressMode === undefined
        ? (before.sandboxConfig?.egressMode ?? "open-world")
        : (params.sandboxEgressMode ?? "open-world");
    const canNarrow = canNarrowEgress(definition.capabilities);
    if (egressMode === "allowlist" && !canNarrow) {
      throw new TypedError({
        message: `${definition.label} cannot enforce an egress allowlist; choose a provider that can, or the open-world egress mode.`,
        type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
        key:
          params.sandboxEgressMode !== undefined
            ? "sandboxEgressMode"
            : "sandboxProvider",
      });
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
    const sandboxConfig: SandboxConfig = { ...before.sandboxConfig };
    let configChanged = false;
    for (const [key, value] of [
      ["image", params.sandboxImage],
      ["runtime", params.sandboxRuntime],
      ["vcpus", params.sandboxVcpus],
      ["egressMode", params.sandboxEgressMode],
    ] as const) {
      if (value === undefined) continue;
      configChanged = true;
      if (value === null || value === "") {
        delete sandboxConfig[key];
      } else {
        (sandboxConfig as Record<string, unknown>)[key] = value;
      }
    }
    if (configChanged) changes.sandboxConfig = sandboxConfig;
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
    // Bots that require an allowlist cannot start jobs on a provider that
    // cannot hold one. Saved anyway — the admin may be mid-change — and said.
    const warnings: string[] = [];
    if (!canNarrow) {
      const strict = await tx
        .select({ displayName: bots.displayName })
        .from(bots)
        .where(
          and(
            eq(bots.projectId, params.projectId),
            eq(bots.requireEgressAllowlist, true),
          ),
        );
      for (const bot of strict) {
        warnings.push(
          `${bot.displayName} requires an egress allowlist, which ${definition.label} cannot enforce; its sandbox jobs will be refused.`,
        );
      }
    }
    connection.metadata.auditTargetType = "project-settings";
    connection.metadata.auditTargetPath = String(params.projectId);
    return { settings, warnings };
  }
}
