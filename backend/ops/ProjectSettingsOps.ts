import { eq } from "drizzle-orm";
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
 * Shape a settings row for the API. It carries no setting yet; each feature
 * that adds a column adds its field here.
 * @param settings - The settings row.
 * @returns The serialized settings.
 */
export function serializeProjectSettings(settings: ProjectSettings) {
  return {
    projectId: settings.projectId,
    createdAt: settings.createdAt.getTime(),
    updatedAt: settings.updatedAt.getTime(),
  };
}
