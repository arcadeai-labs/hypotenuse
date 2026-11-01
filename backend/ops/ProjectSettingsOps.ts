import { eq } from "drizzle-orm";
import { config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/sandbox";
import {
  type ProjectSettings,
  projectSettings,
} from "../schema/project_settings";
import type { DbHandle } from "./DbOps";

/**
 * A project's settings row, created if it is somehow missing.
 *
 * `createProjectForOwner` inserts the row with the project, so the create path
 * here is a backstop. `ON CONFLICT DO NOTHING` then a read, because two readers
 * racing to create it would otherwise have the loser fail on the unique index.
 * @param db - A database handle.
 * @param projectId - The project.
 * @returns The settings row.
 */
export async function getOrCreateSettings(
  db: DbHandle,
  projectId: number,
): Promise<ProjectSettings> {
  const [existing] = await db
    .select()
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId))
    .limit(1);
  if (existing) return existing;
  await db.insert(projectSettings).values({ projectId }).onConflictDoNothing();
  const [created] = await db
    .select()
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId))
    .limit(1);
  return created;
}

/**
 * Shape a settings row for the API. Each feature that adds a column adds its
 * field here. The sandbox fields are what the project chose (null for the
 * deployment's default) beside what is in effect.
 * @param settings - The settings row.
 * @returns The serialized settings.
 */
export function serializeProjectSettings(settings: ProjectSettings) {
  return {
    projectId: settings.projectId,
    sandboxProvider: settings.sandboxProvider,
    sandboxConfig: settings.sandboxConfig,
    sandboxConcurrency: settings.sandboxConcurrency,
    sandboxMaxDurationMs: settings.sandboxMaxDurationMs,
    effectiveSandbox: effectiveSandboxSettings(settings),
    createdAt: settings.createdAt.getTime(),
    updatedAt: settings.updatedAt.getTime(),
  };
}

/** What a project's sandbox jobs run under, its choices over the deployment's. */
export interface EffectiveSandboxSettings {
  provider: string;
  image: string | null;
  concurrency: number;
  maxDurationMs: number;
}

/**
 * The sandbox settings in effect for a project: its own, else the
 * deployment's. A project's duration may only lower the deployment's.
 * @param settings - The settings row.
 * @returns The settings in effect.
 */
export function effectiveSandboxSettings(
  settings: ProjectSettings,
): EffectiveSandboxSettings {
  return {
    provider: settings.sandboxProvider || config.sandbox.defaultProvider,
    image: settings.sandboxConfig?.image ?? null,
    concurrency:
      settings.sandboxConcurrency ?? config.sandbox.defaultConcurrency,
    maxDurationMs: Math.min(
      settings.sandboxMaxDurationMs ?? config.sandbox.maxDurationMs,
      config.sandbox.maxDurationMs,
    ),
  };
}
