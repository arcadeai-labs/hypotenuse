import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import { sweepOrphans } from "../../ops/SandboxReapOps";
import { DockerSandboxProvider } from "../../sandbox/providers/docker";
import { conversations } from "../../schema/conversations";
import { sandboxJobQuestions } from "../../schema/sandbox_job_questions";
import { sandboxJobs } from "../../schema/sandbox_jobs";
import { sandboxes } from "../../schema/sandboxes";
import { type AgentStage, startConversation } from "../agent/harness";
import { HOOK_TIMEOUT, runAction } from "../setup";
import {
  buildSandboxStage,
  conversation,
  dockerAvailable,
  jobRow,
  mintJob,
  TEST_IMAGE,
} from "./harness";

/**
 * **The reaper**: each of its six sweeps on its own, the two clocks read
 * separately (a fresh heartbeat does not save a stalled agent; a job waiting
 * on a person is not stalled), the invariant that no conversation waits on an
 * ended job, and the orphan sweep over the ledger and the provider.
 */
let stage: AgentStage;

beforeAll(async () => {
  stage = await buildSandboxStage("allow");
}, HOOK_TIMEOUT);

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/** A time `ms` ago. */
const ago = (ms: number) => new Date(Date.now() - ms);

/**
 * A job on a fresh conversation, with columns set.
 * @param extra - Columns.
 * @returns The job.
 */
async function job(extra: Partial<typeof sandboxJobs.$inferInsert> = {}) {
  const res = await startConversation(stage, "Hello", { channelType: "web" });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return (await mintJob(stage, res.body.conversation.id, extra)).job;
}

/**
 * Run the reaper once.
 * @returns How many each sweep ended.
 */
async function reap(): Promise<Record<string, number>> {
  return (
    await runAction<{ reaped: Record<string, number> }>("sandbox-jobs:reap")
  ).reaped;
}

describe("each sweep", () => {
  test("dead supervisor: a stale heartbeat ends the job failed", async () => {
    const j = await job({
      lastHeartbeatAt: ago(config.sandbox.heartbeatStaleMs + 1_000),
    });
    const counts = await reap();
    expect(counts.dead_supervisor).toBeGreaterThanOrEqual(1);
    expect(await jobRow(j.id)).toMatchObject({
      status: "failed",
      endReason: "dead_supervisor",
    });
  });

  test("stalled agent: a fresh heartbeat does not save a job doing nothing", async () => {
    const j = await job({
      lastHeartbeatAt: new Date(),
      lastActivityAt: ago(config.sandbox.activityStaleMs + 1_000),
    });
    await reap();
    expect(await jobRow(j.id)).toMatchObject({
      status: "failed",
      endReason: "stalled_agent",
    });
  });

  test("a job waiting on a person's answer is not stalled", async () => {
    const j = await job({
      lastActivityAt: ago(config.sandbox.activityStaleMs + 1_000),
    });
    await api.db.db.insert(sandboxJobQuestions).values({
      jobId: j.id,
      kind: "conversation",
      question: "Which branch?",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await reap();
    expect((await jobRow(j.id)).status).toBe("running");
  });

  test("stuck provisioning", async () => {
    const j = await job({
      status: "provisioning",
      startedAt: ago(config.sandbox.provisioningStaleMs + 1_000),
    });
    await reap();
    expect(await jobRow(j.id)).toMatchObject({
      status: "failed",
      endReason: "stuck_provisioning",
    });
  });

  test("over duration ends it timed_out", async () => {
    const j = await job({ maxDurationMs: 1_000, startedAt: ago(5_000) });
    await reap();
    expect(await jobRow(j.id)).toMatchObject({
      status: "timed_out",
      endReason: "over_duration",
    });
  });

  test("a cancel nobody acknowledged is forced; a pending job's cancel ends it at once", async () => {
    const live = await job({
      cancelRequested: true,
      cancelRequestedAt: ago(config.sandbox.cancelGraceMs + 1_000),
    });
    const pending = await job({ status: "pending", cancelRequested: true });
    const fresh = await job({
      cancelRequested: true,
      cancelRequestedAt: new Date(),
    });
    await reap();
    expect(await jobRow(live.id)).toMatchObject({
      status: "cancelled",
      endReason: "cancel_unacknowledged",
    });
    expect((await jobRow(pending.id)).status).toBe("cancelled");
    expect((await jobRow(fresh.id)).status).toBe("running");
  });

  test("an interactive job idle past its timeout expires", async () => {
    const j = await job({
      interactive: true,
      status: "awaiting_input",
      awaitingInputSince: ago(5_000),
      idleTimeoutMs: 1_000,
    });
    await reap();
    expect(await jobRow(j.id)).toMatchObject({
      status: "expired",
      endReason: "idle_interactive",
    });
  });

  test("a healthy job is left alone", async () => {
    const j = await job();
    await reap();
    expect((await jobRow(j.id)).status).toBe("running");
  });
});

describe("the parent is never left waiting on a dead job", () => {
  test("a reaped job wakes the conversation waiting on it", async () => {
    const j = await job({
      lastHeartbeatAt: ago(config.sandbox.heartbeatStaleMs + 1_000),
    });
    await api.db.db
      .update(conversations)
      .set({
        state: "waiting",
        waitingOn: { kind: "sandbox", sandboxJobId: j.id },
      })
      .where(eq(conversations.id, j.parentConversationId));
    await reap();
    const parent = await conversation(j.parentConversationId);
    expect(parent.state).toBe("working");
  });

  test("a conversation that parked on a job already ended is woken by the sweep", async () => {
    const j = await job({ status: "succeeded", endedAt: new Date() });
    await api.db.db
      .update(conversations)
      .set({
        state: "waiting",
        waitingOn: { kind: "sandbox", sandboxJobId: j.id },
      })
      .where(eq(conversations.id, j.parentConversationId));
    const counts = await reap();
    expect(counts.parents_woken).toBeGreaterThanOrEqual(1);
    expect((await conversation(j.parentConversationId)).state).toBe("working");
  });
});

describe("the orphan sweep", () => {
  test("closes a live ledger row whose job ended, and one with no job", async () => {
    const ended = await job({ status: "failed", endedAt: new Date() });
    const old = ago(config.sandbox.orphanGraceMs + 1_000);
    const [attached] = await api.db.db
      .insert(sandboxes)
      .values({
        projectId: stage.u.projectId,
        jobId: ended.id,
        provider: "docker",
        status: "creating",
        createdAt: old,
      })
      .returning();
    const [unattached] = await api.db.db
      .insert(sandboxes)
      .values({
        projectId: stage.u.projectId,
        provider: "docker",
        status: "creating",
        createdAt: old,
      })
      .returning();
    const [young] = await api.db.db
      .insert(sandboxes)
      .values({
        projectId: stage.u.projectId,
        provider: "docker",
        status: "creating",
      })
      .returning();
    const result = await sweepOrphans();
    expect(result.ledger).toBeGreaterThanOrEqual(2);
    const rows = await api.db.db.select().from(sandboxes);
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get(attached.id)?.status).toBe("destroyed");
    expect(byId.get(unattached.id)?.status).toBe("destroyed");
    expect(byId.get(young.id)?.status).toBe("creating");
  });

  (dockerAvailable ? test : test.skip)(
    "destroys a container it manages that the ledger never heard of",
    async () => {
      const provider = new DockerSandboxProvider();
      const stray = await provider.create({
        image: TEST_IMAGE,
        timeoutMs: 60_000,
        labels: { job: "999999" },
      });
      const grace = config.sandbox.orphanGraceMs;
      config.sandbox.orphanGraceMs = 0;
      try {
        await Bun.sleep(1_100);
        const result = await sweepOrphans();
        expect(result.provider).toBeGreaterThanOrEqual(1);
      } finally {
        config.sandbox.orphanGraceMs = grace;
      }
      expect((await provider.list()).some((l) => l.id === stray.id)).toBe(
        false,
      );
    },
    60_000,
  );
});
