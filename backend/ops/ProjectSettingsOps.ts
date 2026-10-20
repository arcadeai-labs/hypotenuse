import { eq } from "drizzle-orm";
import type { api } from "keryx";
import {
  type ProjectSettings,
  projectSettings,
} from "../schema/project_settings";
import type { TxHandle } from "./ProjectOps";

/**
 * Read a project's settings, creating the row if it has none.
 *
 * Every project gets its row from `createProjectForOwner`, so the insert here is
 * a backstop rather than the normal path: a project whose row went missing still
 * reads the defaults instead of failing a request that only asked to look.
 *
 * The insert uses `onConflictDoNothing` followed by a re-read, because two
 * concurrent first-reads of the same project genuinely race — the unique index
 * on `projectId` decides, and the loser reads the winner's row.
 * @param db - A transaction handle, or the shared `api.db.db`.
 * @param projectId - The project whose settings to read.
 * @returns The project's settings row.
 */
export async function getOrCreateSettings(
  db: TxHandle | typeof api.db.db,
  projectId: number,
): Promise<ProjectSettings> {
  const [existing] = await db
    .select()
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId))
    .limit(1);
  if (existing) return existing;

  await db.insert(projectSettings).values({ projectId }).onConflictDoNothing();

  const [settings] = await db
    .select()
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId))
    .limit(1);
  return settings;
}

/**
 * Shape a settings row into the API-safe object returned by actions. Timestamps
 * are emitted as epoch milliseconds.
 *
 * A straight projection today. It exists anyway, because a serializer is the one
 * place a future secret-bearing column can be dropped without auditing every
 * call site.
 * @param settings - The settings row from the database.
 * @returns The serialized settings.
 */
export function serializeProjectSettings(settings: ProjectSettings) {
  return {
    id: settings.id,
    projectId: settings.projectId,
    createdAt: settings.createdAt.getTime(),
    updatedAt: settings.updatedAt.getTime(),
  };
}
