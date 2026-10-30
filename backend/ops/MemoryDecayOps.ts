import { and, eq, lt, sql } from "drizzle-orm";
import { api, config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/memory";
import { bots } from "../schema/bots";
import { memoryDocuments } from "../schema/memory_documents";
import { enqueueEmbed, lockDocument, writeVersion } from "./MemoryOps";

/**
 * **The decay clock's work.** Ranking already weighs every memory by how
 * much it has faded; this is what happens past ranking:
 *
 * | Document | What the clock does |
 * |---|---|
 * | channel, current, unpinned, read fewer than 3 times, decay below 0.05 | tombstoned, `changeNote = "faded"` (its history kept) |
 * | channel, pinned or read often, or still above 0.05 | nothing |
 * | project, any | nothing — a person forgets project memory |
 * | any non-current version older than the retention window, not cited by a promotion | deleted, with its chunks |
 * | any current version | never deleted |
 * | chunks without a current vector | `memory:embed` enqueued, retrying a run that failed |
 *
 * A machine writer on the closed unaudited list: its record is the
 * tombstone's `changeNote` and `sourceType = "decay"`.
 */

/**
 * The projects that have any memory, for the clock to fan out over.
 * @returns Their ids.
 */
export async function projectsWithMemory(): Promise<number[]> {
  const rows = await api.db.db
    .selectDistinct({ projectId: memoryDocuments.projectId })
    .from(memoryDocuments);
  return rows.map((r) => r.projectId);
}

/** What one project's decay run did. */
export interface DecayResult {
  faded: string[];
  pruned: number;
}

/**
 * Fade and prune one project's memory.
 * @param projectId - The project.
 * @returns The paths tombstoned, and how many old versions were deleted.
 */
export async function decayProject(projectId: number): Promise<DecayResult> {
  // decay = exp(−ln 2 · age / halfLife), age from the newer of the version and
  // its last use, half-life from the bot whose channel memory it is.
  const ageSeconds = sql`extract(epoch from (now() - greatest(${memoryDocuments.createdAt}, coalesce(${memoryDocuments.lastAccessedAt}, ${memoryDocuments.createdAt}))))`;
  const decay = sql`exp(-ln(2) * ${ageSeconds} / (greatest(${bots.memoryChannelHalfLifeDays}, 1) * 86400.0))`;
  const faded = await api.db.db
    .select({
      id: memoryDocuments.id,
      botId: memoryDocuments.botId,
      channelId: memoryDocuments.channelId,
      path: memoryDocuments.logicalPath,
    })
    .from(memoryDocuments)
    .innerJoin(bots, eq(bots.id, memoryDocuments.botId))
    .where(
      and(
        eq(memoryDocuments.projectId, projectId),
        eq(memoryDocuments.scope, "channel"),
        eq(memoryDocuments.isCurrent, true),
        eq(memoryDocuments.tombstone, false),
        eq(memoryDocuments.pinned, false),
        lt(memoryDocuments.accessCount, config.memory.fadeMinAccessCount),
        sql`${decay} < ${config.memory.fadeThreshold}`,
      ),
    )
    .limit(500);

  const tombstoned: string[] = [];
  for (const doc of faded) {
    await api.db.db.transaction(async (tx) => {
      const key = {
        projectId,
        scope: "channel" as const,
        botId: doc.botId,
        channelId: doc.channelId,
        path: doc.path,
      };
      // The document's advisory lock before any row lock, as every writer
      // takes them: a pin holding it while waiting on this row would deadlock.
      await lockDocument(tx, key);
      // Re-check under the lock: a read or a write since the select keeps it.
      const [still] = await tx
        .select({ id: memoryDocuments.id })
        .from(memoryDocuments)
        .innerJoin(bots, eq(bots.id, memoryDocuments.botId))
        .where(
          and(
            eq(memoryDocuments.id, doc.id),
            eq(memoryDocuments.isCurrent, true),
            eq(memoryDocuments.pinned, false),
            lt(memoryDocuments.accessCount, config.memory.fadeMinAccessCount),
            sql`${decay} < ${config.memory.fadeThreshold}`,
          ),
        )
        .for("update", { of: memoryDocuments });
      if (!still) return;
      await writeVersion(tx, key, {
        content: "",
        tombstone: true,
        changeNote: "faded",
        sourceType: "decay",
        sourceRef: {},
      });
      tombstoned.push(`${doc.botId}/${doc.channelId}/${doc.path}`);
    });
  }

  const cited = sql`select (${memoryDocuments.sourceRef}->>'promotedFromId')::int from ${memoryDocuments} where ${memoryDocuments.sourceType} = 'promotion' and ${memoryDocuments.sourceRef} ? 'promotedFromId'`;
  const pruned = await api.db.db
    .delete(memoryDocuments)
    .where(
      and(
        eq(memoryDocuments.projectId, projectId),
        eq(memoryDocuments.isCurrent, false),
        sql`${memoryDocuments.createdAt} < now() - make_interval(days => ${config.memory.versionRetentionDays})`,
        sql`${memoryDocuments.id} not in (${cited})`,
      ),
    )
    .returning({ id: memoryDocuments.id });

  // The hourly retry for embedding: a failed `memory:embed` run is not
  // rescheduled by itself, and one with nothing stale returns at once.
  await enqueueEmbed(projectId);
  return { faded: tombstoned, pruned: pruned.length };
}
