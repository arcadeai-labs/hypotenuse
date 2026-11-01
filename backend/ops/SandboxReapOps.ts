import { and, eq, inArray, isNotNull, lt, sql } from "drizzle-orm";
import { api, config } from "keryx";
// Type-only, purely for the `declare module "keryx"` augmentation inside.
import type {} from "../config/sandbox";
import { SANDBOX_PROVIDER_KINDS, SANDBOX_PROVIDERS } from "../sandbox/registry";
import { conversations } from "../schema/conversations";
import { sandboxJobQuestions } from "../schema/sandbox_job_questions";
import {
  type SandboxJob,
  sandboxJobs,
  TERMINAL_SANDBOX_JOB_STATUSES,
} from "../schema/sandbox_jobs";
import { enqueueTick, lockConversation, wake } from "./ConversationOps";
import {
  expireDueQuestions,
  finalizeSandboxJob,
  type JobEnding,
} from "./SandboxJobOps";
import { destroySandbox, findOrphans, liveExternalIds } from "./SandboxOps";

/**
 * **The reaper** (`sandbox-jobs:reap`): six sweeps over live jobs, each ending
 * a job through `finalizeSandboxJob` with its own `endReason`, plus the
 * invariant sweep that no conversation is left waiting on a job that ended.
 *
 * | Sweep | Finds | Ends it |
 * |---|---|---|
 * | `dead_supervisor` | `running` / `awaiting_input`, heartbeat older than `heartbeatStaleMs` | `failed` |
 * | `stalled_agent` | `running`, no event, status, ask, or check for `activityStaleMs`, and no pending question | `failed` |
 * | `stuck_provisioning` | `provisioning` longer than `provisioningStaleMs` | `failed` |
 * | `over_duration` | live past its `maxDurationMs` | `timed_out` |
 * | `cancel_unacknowledged` | a cancel requested on a `pending` job, or `cancelGraceMs` ago on a live one | `cancelled` |
 * | `idle_interactive` | `awaiting_input` longer than its `idleTimeoutMs` | `expired` |
 *
 * A fresh heartbeat does not save a job whose agent has stalled: the two
 * clocks are read separately.
 */

/** Which sweep ended how many jobs. */
export type ReapCounts = Record<string, number>;

/**
 * End every job a query found.
 * @param jobs - The jobs.
 * @param ending - How each ends.
 * @returns How many this call ended.
 */
async function endAll(
  jobs: Pick<SandboxJob, "id">[],
  ending: JobEnding,
): Promise<number> {
  let ended = 0;
  for (const job of jobs) {
    const result = await finalizeSandboxJob(job.id, ending);
    if (!result.alreadyFinal) ended++;
  }
  return ended;
}

/**
 * A cutoff `ms` before now.
 * @param ms - How long ago.
 * @returns The date.
 */
function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}

/**
 * Run every sweep once.
 * @returns How many jobs each sweep ended, and how many conversations woke.
 */
export async function reapSandboxJobs(): Promise<ReapCounts> {
  const db = api.db.db;
  const s = config.sandbox;
  const counts: ReapCounts = {};
  const select = () => db.select({ id: sandboxJobs.id }).from(sandboxJobs);

  counts.cancel_unacknowledged =
    (await endAll(
      await select().where(
        and(
          eq(sandboxJobs.cancelRequested, true),
          eq(sandboxJobs.status, "pending"),
        ),
      ),
      { status: "cancelled", reason: "cancelled" },
    )) +
    (await endAll(
      await select().where(
        and(
          eq(sandboxJobs.cancelRequested, true),
          inArray(sandboxJobs.status, [
            "provisioning",
            "running",
            "awaiting_input",
          ]),
          lt(sandboxJobs.cancelRequestedAt, ago(s.cancelGraceMs)),
        ),
      ),
      {
        status: "cancelled",
        reason: "cancel_unacknowledged",
        error:
          "The sandbox did not acknowledge the cancel in time, so it was stopped.",
      },
    ));

  counts.stuck_provisioning = await endAll(
    await select().where(
      and(
        eq(sandboxJobs.status, "provisioning"),
        lt(sandboxJobs.startedAt, ago(s.provisioningStaleMs)),
      ),
    ),
    {
      status: "failed",
      reason: "stuck_provisioning",
      error: "The sandbox did not finish starting in time.",
    },
  );

  counts.over_duration = await endAll(
    await select().where(
      and(
        inArray(sandboxJobs.status, [
          "provisioning",
          "running",
          "awaiting_input",
        ]),
        sql`${sandboxJobs.startedAt} < now() - (${sandboxJobs.maxDurationMs} * interval '1 millisecond')`,
      ),
    ),
    {
      status: "timed_out",
      reason: "over_duration",
      error: "The job ran past its time limit.",
    },
  );

  counts.dead_supervisor = await endAll(
    await select().where(
      and(
        inArray(sandboxJobs.status, ["running", "awaiting_input"]),
        lt(sandboxJobs.lastHeartbeatAt, ago(s.heartbeatStaleMs)),
      ),
    ),
    {
      status: "failed",
      reason: "dead_supervisor",
      error: "The sandbox stopped reporting: its supervisor is gone.",
    },
  );

  counts.stalled_agent = await endAll(
    await select().where(
      and(
        eq(sandboxJobs.status, "running"),
        lt(sandboxJobs.lastActivityAt, ago(s.activityStaleMs)),
        sql`not exists (select 1 from ${sandboxJobQuestions} q where q.job_id = ${sandboxJobs.id} and q.status = 'pending')`,
      ),
    ),
    {
      status: "failed",
      reason: "stalled_agent",
      error: "The coding agent stopped making progress.",
    },
  );

  counts.idle_interactive = await endAll(
    await select().where(
      and(
        eq(sandboxJobs.status, "awaiting_input"),
        sql`${sandboxJobs.awaitingInputSince} < now() - (${sandboxJobs.idleTimeoutMs} * interval '1 millisecond')`,
      ),
    ),
    { status: "expired", reason: "idle_interactive" },
  );

  counts.questions_expired = await expireDueQuestions();
  counts.parents_woken = await wakeParentsOfEndedJobs();
  return counts;
}

/**
 * **The parent is never left waiting on a dead job.** Every ending wakes a
 * conversation waiting on its job; this sweep catches the one case that
 * cannot: a job that ended before its conversation finished parking on it.
 * @returns How many conversations woke.
 */
export async function wakeParentsOfEndedJobs(): Promise<number> {
  const waiting = await api.db.db
    .select({ id: conversations.id })
    .from(conversations)
    .innerJoin(
      sandboxJobs,
      sql`${sandboxJobs.id} = (${conversations.waitingOn}->>'sandboxJobId')::int`,
    )
    .where(
      and(
        eq(conversations.state, "waiting"),
        sql`${conversations.waitingOn}->>'kind' = 'sandbox'`,
        inArray(sandboxJobs.status, TERMINAL_SANDBOX_JOB_STATUSES),
        isNotNull(sandboxJobs.endedAt),
      ),
    );
  let woke = 0;
  for (const { id } of waiting) {
    const woken = await api.db.db.transaction(async (tx) => {
      const locked = await lockConversation(tx, id);
      const c = locked?.conversation;
      if (c?.state !== "waiting" || c.waitingOn?.kind !== "sandbox")
        return null;
      return wake(tx, c, "sandbox");
    });
    if (woken) {
      woke++;
      await enqueueTick(woken);
    }
  }
  return woke;
}

/**
 * **`sandbox:orphan-sweep`**: destroy ledger rows attached to no live job,
 * and provider sandboxes the ledger has never heard of (older than the
 * grace, so one mid-provisioning is not mistaken for a leak). A provider this
 * deployment may not use is not listed.
 * @returns How many ledger rows were closed and provider sandboxes destroyed.
 */
export async function sweepOrphans(): Promise<{
  ledger: number;
  provider: number;
}> {
  const grace = config.sandbox.orphanGraceMs;
  let ledger = 0;
  for (const row of await findOrphans(grace)) {
    if (await destroySandbox(row)) ledger++;
  }
  let provider = 0;
  for (const kind of SANDBOX_PROVIDER_KINDS) {
    const definition = SANDBOX_PROVIDERS[kind];
    if (
      !definition.productionAllowed &&
      process.env.NODE_ENV === "production"
    ) {
      continue;
    }
    try {
      const instance = definition.build();
      const known = await liveExternalIds(kind);
      const cutoff = Date.now() - grace;
      for (const listing of await instance.list()) {
        if (known.has(listing.id)) continue;
        if (listing.createdAt && listing.createdAt.getTime() > cutoff) continue;
        const sandbox = await instance.connect(listing.id);
        await sandbox.destroy();
        provider++;
      }
    } catch (e) {
      api.logger.warn("could not sweep a sandbox provider", {
        provider: kind,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { ledger, provider };
}
