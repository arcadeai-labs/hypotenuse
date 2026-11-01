import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { api } from "keryx";
import { buildSandboxProvider } from "../sandbox/registry";
import type { CreateSandboxOptions, Sandbox } from "../sandbox/types";
import { SandboxNotFoundError } from "../sandbox/types";
import {
  sandboxJobs,
  TERMINAL_SANDBOX_JOB_STATUSES,
} from "../schema/sandbox_jobs";
import {
  type SandboxRecord,
  type SandboxStatus,
  sandboxes,
} from "../schema/sandboxes";
import type { DbHandle } from "./DbOps";

/**
 * **The sandbox ledger.** Every sandbox is ledgered *before* the provider is
 * asked for it, and every destroy is a compare-and-swap on the row, so the
 * ledger always says what should exist and `sandbox:orphan-sweep` can collect
 * what should not.
 */

/** The statuses that mean "this sandbox may still be costing money". */
export const LIVE_SANDBOX_STATUSES: SandboxStatus[] = [
  "creating",
  "running",
  "stopped",
];

/**
 * Open a ledger row for a sandbox that is about to be created. Written
 * **before** the provider call: a crash between this insert and the
 * provider's answer leaves a `creating` row with no `externalId`, a truthful
 * record of "we may have started something and stopped watching".
 * @param db - A database handle.
 * @param input - The project, provider, job, and labels.
 * @returns The `creating` row.
 */
export async function recordSandboxCreating(
  db: DbHandle,
  input: {
    projectId: number;
    provider: string;
    jobId?: number | null;
    labels?: Record<string, string>;
  },
): Promise<SandboxRecord> {
  const [row] = await db
    .insert(sandboxes)
    .values({
      projectId: input.projectId,
      provider: input.provider,
      jobId: input.jobId ?? null,
      labels: input.labels ?? {},
      status: "creating",
    })
    .returning();
  return row;
}

/**
 * Stamp a `creating` row with the provider-side id. Only a `creating` row is
 * updated: a release that closed the row while the provider call ran must not
 * be overwritten by a `running` nobody is watching.
 * @param db - A database handle.
 * @param id - The ledger row.
 * @param externalId - The provider-side id.
 * @returns The updated row, or `undefined` if it is no longer `creating`.
 */
export async function recordSandboxCreated(
  db: DbHandle,
  id: number,
  externalId: string,
): Promise<SandboxRecord | undefined> {
  const [row] = await db
    .update(sandboxes)
    .set({ externalId, status: "running" })
    .where(and(eq(sandboxes.id, id), eq(sandboxes.status, "creating")))
    .returning();
  return row;
}

/**
 * Record that a sandbox failed to come up.
 * @param db - A database handle.
 * @param id - The ledger row.
 * @param error - Why.
 * @returns The updated row.
 */
export async function recordSandboxFailed(
  db: DbHandle,
  id: number,
  error: string,
): Promise<SandboxRecord> {
  const [row] = await db
    .update(sandboxes)
    .set({ status: "failed", error, destroyedAt: new Date() })
    .where(eq(sandboxes.id, id))
    .returning();
  return row;
}

/**
 * Stamp a ledger row destroyed.
 * @param db - A database handle.
 * @param id - The ledger row.
 * @returns The updated row.
 */
export async function recordSandboxDestroyed(
  db: DbHandle,
  id: number,
): Promise<SandboxRecord> {
  const [row] = await db
    .update(sandboxes)
    .set({ status: "destroyed", destroyedAt: new Date() })
    .where(eq(sandboxes.id, id))
    .returning();
  return row;
}

/**
 * **The single entry point for bringing a sandbox up**: ledger it, then ask
 * the provider. A provider failure marks the row `failed`; a create whose
 * ledger write lost a race with a release is destroyed again at once.
 * @param input - The project, provider, job, and what to pass the provider.
 * @returns The live sandbox and its ledger row.
 * @throws Whatever the provider threw.
 */
export async function provisionSandbox(input: {
  projectId: number;
  provider: string;
  jobId: number | null;
  options: CreateSandboxOptions;
}): Promise<{ sandbox: Sandbox; record: SandboxRecord }> {
  const provider = buildSandboxProvider(input.provider);
  const labels = {
    ...input.options.labels,
    project: String(input.projectId),
    ...(input.jobId ? { job: String(input.jobId) } : {}),
  };
  const pending = await recordSandboxCreating(api.db.db, {
    projectId: input.projectId,
    provider: input.provider,
    jobId: input.jobId,
    labels,
  });
  let created: Sandbox | undefined;
  try {
    created = await provider.create({ ...input.options, labels });
    const record = await recordSandboxCreated(
      api.db.db,
      pending.id,
      created.id,
    );
    if (!record) {
      throw new Error("the sandbox was released while it was being created");
    }
    return { sandbox: created, record };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (created) {
      // Name the row first, so a crash from here still leaves something to
      // collect; then destroy the sandbox itself. Not `destroySandbox`: a
      // release that closed the row while `create` ran has already stamped
      // it destroyed, and that path would skip the provider.
      await api.db.db
        .update(sandboxes)
        .set({ externalId: created.id })
        .where(eq(sandboxes.id, pending.id));
      try {
        await created.destroy();
        await recordSandboxFailed(api.db.db, pending.id, message);
      } catch (cleanup) {
        // The row keeps naming it, live, for the orphan sweep.
        await api.db.db
          .update(sandboxes)
          .set({ status: "running", destroyedAt: null })
          .where(eq(sandboxes.id, pending.id));
        api.logger.error("could not destroy a half-provisioned sandbox", {
          sandboxId: pending.id,
          error: cleanup instanceof Error ? cleanup.message : String(cleanup),
        });
      }
    } else {
      await recordSandboxFailed(api.db.db, pending.id, message);
    }
    throw e;
  }
}

/**
 * Destroy a ledgered sandbox at its provider and stamp the row. A sandbox the
 * provider already collected still closes its row; any other provider
 * failure leaves the row live and answers `null`, so the next sweep tries
 * again — the ledger must never say a sandbox is gone while it runs.
 * @param record - The ledger row (re-read here: the caller's is a snapshot).
 * @returns The closed row, or `null` if the provider could not be reached.
 */
export async function destroySandbox(
  record: SandboxRecord,
): Promise<SandboxRecord | null> {
  const [latest] = await api.db.db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, record.id))
    .limit(1);
  const current = latest ?? record;
  if (current.destroyedAt) return current;
  if (current.externalId) {
    try {
      const provider = buildSandboxProvider(current.provider);
      const sandbox = await provider.connect(current.externalId);
      await sandbox.destroy();
    } catch (e) {
      if (!(e instanceof SandboxNotFoundError)) {
        api.logger.warn("could not destroy a sandbox at its provider", {
          sandboxId: current.id,
          provider: current.provider,
          error: e instanceof Error ? e.message : String(e),
        });
        return null;
      }
    }
    return recordSandboxDestroyed(api.db.db, current.id);
  }
  // Unnamed: close it only if it is *still* unnamed, so a create that named
  // it meanwhile is not closed without a provider call.
  const [closed] = await api.db.db
    .update(sandboxes)
    .set({ status: "destroyed", destroyedAt: new Date() })
    .where(
      and(
        eq(sandboxes.id, current.id),
        isNull(sandboxes.externalId),
        inArray(sandboxes.status, LIVE_SANDBOX_STATUSES),
      ),
    )
    .returning();
  if (closed) return closed;
  const [again] = await api.db.db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.id, current.id))
    .limit(1);
  if (!again || again.destroyedAt) return again ?? null;
  return destroySandbox(again);
}

/**
 * Destroy every live sandbox a job holds. Never throws: a provider that
 * cannot be reached leaves the row for the orphan sweep.
 * @param jobId - The job.
 * @returns How many were destroyed.
 */
export async function releaseJobSandboxes(jobId: number): Promise<number> {
  const rows = await api.db.db
    .select()
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.jobId, jobId),
        inArray(sandboxes.status, LIVE_SANDBOX_STATUSES),
      ),
    );
  let destroyed = 0;
  for (const row of rows) {
    try {
      if (await destroySandbox(row)) destroyed++;
    } catch (e) {
      api.logger.warn("could not release a job's sandbox", {
        jobId,
        sandboxId: row.id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return destroyed;
}

/**
 * Ledger rows that look leaked: live, older than the grace, and attached to
 * no live job (none at all, or one that has ended).
 * @param graceMs - How long a row may be unattached before it counts.
 * @returns The suspect rows, oldest first.
 */
export async function findOrphans(graceMs: number): Promise<SandboxRecord[]> {
  const cutoff = new Date(Date.now() - graceMs);
  const rows = await api.db.db
    .select({ sandbox: sandboxes })
    .from(sandboxes)
    .leftJoin(sandboxJobs, eq(sandboxJobs.id, sandboxes.jobId))
    .where(
      and(
        inArray(sandboxes.status, LIVE_SANDBOX_STATUSES),
        lt(sandboxes.createdAt, cutoff),
        or(
          isNull(sandboxes.jobId),
          isNull(sandboxJobs.id),
          inArray(sandboxJobs.status, TERMINAL_SANDBOX_JOB_STATUSES),
        ),
      ),
    )
    .orderBy(asc(sandboxes.createdAt));
  return rows.map((r) => r.sandbox);
}

/**
 * The provider-side ids of every sandbox the ledger believes is live, across
 * every project — narrowing it would turn the orphan sweep into a
 * cross-tenant destroy loop.
 * @param provider - The provider.
 * @returns The live external ids.
 */
export async function liveExternalIds(provider: string): Promise<Set<string>> {
  const rows = await api.db.db
    .select({ externalId: sandboxes.externalId })
    .from(sandboxes)
    .where(
      and(
        eq(sandboxes.provider, provider),
        inArray(sandboxes.status, LIVE_SANDBOX_STATUSES),
      ),
    );
  return new Set(
    rows.map((r) => r.externalId).filter((id): id is string => id !== null),
  );
}

/**
 * Shape a ledger row for any answer.
 * @param r - The row.
 * @returns The serialized row.
 */
export function serializeSandbox(r: SandboxRecord) {
  return {
    id: r.id,
    projectId: r.projectId,
    jobId: r.jobId,
    provider: r.provider,
    externalId: r.externalId,
    status: r.status,
    error: r.error,
    createdAt: r.createdAt.getTime(),
    destroyedAt: r.destroyedAt?.getTime() ?? null,
  };
}
