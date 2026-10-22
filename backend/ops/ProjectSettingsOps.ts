import { eq } from "drizzle-orm";
import type { api } from "keryx";
import { z } from "zod";
import {
  type ManagerSettings,
  type ProjectSettings,
  projectSettings,
  type RoutingSettings,
} from "../schema/project_settings";
import type { TxHandle } from "./ProjectOps";

/** Work routing's defaults, for every key a project has not set. */
export const ROUTING_DEFAULTS: RoutingSettings = {
  queueTimeoutMs: 30 * 60 * 1000,
  stickyTimeoutMs: 10 * 60 * 1000,
  offerTtlMs: 10_000,
  repositoryConfidence: 0.7,
  stopGraceMs: 30_000,
  maxReviewRounds: 3,
};

/** What manager sessions may do, for every key a project has not set. */
export const MANAGER_DEFAULTS: ManagerSettings = {
  canCompleteIssues: false,
  maxParallelDispatch: 3,
};

/** One hour in ms, the most any routing timer waits but the queue timeout. */
const HOUR_MS = 60 * 60 * 1000;

/** Each routing setting's bounds: a typo cannot park work for a year or offer it for a millisecond. */
const routingFields = {
  queueTimeoutMs: z
    .number()
    .int()
    .min(60_000)
    .max(24 * HOUR_MS)
    .describe("A turn no runner takes within this long expires (ms)"),
  stickyTimeoutMs: z
    .number()
    .int()
    .min(0)
    .max(24 * HOUR_MS)
    .describe(
      "How long a follow-up waits for the runner holding its worktree (ms); 0 never waits",
    ),
  offerTtlMs: z
    .number()
    .int()
    .min(2_000)
    .max(5 * 60_000)
    .describe("How long an offer stands before it goes elsewhere (ms)"),
  repositoryConfidence: z
    .number()
    .min(0)
    .max(1)
    .describe("The confidence Linear's top repository suggestion needs (0-1)"),
  stopGraceMs: z
    .number()
    .int()
    .min(1_000)
    .max(HOUR_MS)
    .describe("How long a stopped turn's runner has to confirm (ms)"),
  maxReviewRounds: z
    .number()
    .int()
    .min(0)
    .max(20)
    .describe("How many review rounds a manager runs on one dispatch"),
};

/**
 * The `routing` section a settings edit may change: a key left out keeps its
 * value, and `null` returns it to its default.
 */
export const RoutingSettingsEditInput = z.strictObject({
  queueTimeoutMs: routingFields.queueTimeoutMs.nullable().optional(),
  stickyTimeoutMs: routingFields.stickyTimeoutMs.nullable().optional(),
  offerTtlMs: routingFields.offerTtlMs.nullable().optional(),
  repositoryConfidence: routingFields.repositoryConfidence
    .nullable()
    .optional(),
  stopGraceMs: routingFields.stopGraceMs.nullable().optional(),
  maxReviewRounds: routingFields.maxReviewRounds.nullable().optional(),
});

/**
 * The `manager` section a settings edit may change, the same way as
 * {@link RoutingSettingsEditInput}.
 */
export const ManagerSettingsEditInput = z.strictObject({
  canCompleteIssues: z
    .boolean()
    .nullable()
    .optional()
    .describe(
      "Whether a manager session may move an issue to a completed or canceled state",
    ),
  maxParallelDispatch: z
    .number()
    .int()
    .min(1)
    .max(20)
    .nullable()
    .optional()
    .describe(
      "How many dispatched worker sessions one manager session may have under way",
    ),
});

/**
 * A sparse settings section with an edit applied: a key left out keeps its
 * value, and `null` removes it so it takes its default.
 * @param stored - The stored section.
 * @param edit - The edit.
 * @returns The new section.
 */
export function applySectionEdit(
  stored: Record<string, unknown>,
  edit: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...stored };
  for (const [key, value] of Object.entries(edit ?? {})) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next;
}

/**
 * A project's manager settings, every key filled in.
 * @param settings - The settings row (or just its `manager` column).
 * @returns The stored values over the defaults.
 */
export function resolveManagerSettings(
  settings: Pick<ProjectSettings, "manager"> | null | undefined,
): ManagerSettings {
  return { ...MANAGER_DEFAULTS, ...(settings?.manager ?? {}) };
}

/**
 * Read a project's manager settings.
 * @param db - A transaction or the shared handle.
 * @param projectId - The project.
 * @returns Its settings over the defaults.
 */
export async function getManagerSettings(
  db: TxHandle | typeof api.db.db,
  projectId: number,
): Promise<ManagerSettings> {
  const [row] = await db
    .select({ manager: projectSettings.manager })
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId))
    .limit(1);
  return resolveManagerSettings(row);
}

/**
 * A project's routing settings, every key filled in.
 * @param settings - The settings row (or just its `routing` column).
 * @returns The stored values over the defaults.
 */
export function resolveRoutingSettings(
  settings: Pick<ProjectSettings, "routing"> | null | undefined,
): RoutingSettings {
  return { ...ROUTING_DEFAULTS, ...(settings?.routing ?? {}) };
}

/**
 * Read a project's routing settings.
 * @param db - A transaction or the shared handle.
 * @param projectId - The project.
 * @returns Its settings over the defaults.
 */
export async function getRoutingSettings(
  db: TxHandle | typeof api.db.db,
  projectId: number,
): Promise<RoutingSettings> {
  const [row] = await db
    .select({ routing: projectSettings.routing })
    .from(projectSettings)
    .where(eq(projectSettings.projectId, projectId))
    .limit(1);
  return resolveRoutingSettings(row);
}

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
 * `routing` and `manager` are answered resolved — every key, defaults filled
 * in — because a client deciding what a turn will wait for must not guess a
 * default.
 * @param settings - The settings row from the database.
 * @returns The serialized settings.
 */
export function serializeProjectSettings(settings: ProjectSettings) {
  return {
    id: settings.id,
    projectId: settings.projectId,
    routing: resolveRoutingSettings(settings),
    manager: resolveManagerSettings(settings),
    createdAt: settings.createdAt.getTime(),
    updatedAt: settings.updatedAt.getTime(),
  };
}
