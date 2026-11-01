import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import { startSandboxJob } from "../../ops/SandboxProvisionOps";
import { sandboxJobs } from "../../schema/sandbox_jobs";
import {
  type AgentStage,
  clearLoopQueues,
  runTicks,
  startConversation,
} from "../agent/harness";
import { approvalsOf, resultsOf } from "../mcp/harness";
import { call, HOOK_TIMEOUT } from "../setup";
import { buildSandboxStage, conversation, jobRow, latestJob } from "./harness";

/**
 * **The bot's side**: `sandbox_start` under each sandbox policy, the job it
 * writes and parks on, dispatch within the project's and the bot's
 * concurrency, `sandbox_status` / `sandbox_cancel` / `sandbox_message` on
 * this conversation's jobs only, and the production guard at both places it
 * stands. Nothing here starts a container: claimed jobs are left unstarted.
 */
let stage: AgentStage;

beforeAll(async () => {
  stage = await buildSandboxStage("approve");
}, HOOK_TIMEOUT);

afterEach(async () => {
  // Each test starts with the bot holding no job in flight.
  await api.db.db
    .update(sandboxJobs)
    .set({ status: "failed", endedAt: new Date() })
    .where(eq(sandboxJobs.botId, stage.botId));
  await clearLoopQueues();
  await api.resque.queue.delQueue("sandboxes");
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
});

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Set the bot's sandbox fields.
 * @param fields - `sandboxPolicy`, `sandboxJobTokenBudget`.
 */
async function editBot(fields: Record<string, unknown>): Promise<void> {
  const res = await call(
    stage.u.url,
    stage.u.peach,
    "POST",
    `/project/${stage.u.projectId}/bot/${stage.botId}`,
    fields,
  );
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
}

/**
 * Start a conversation whose first step calls the given tools.
 * @param steps - The scripted steps.
 * @returns The conversation's id.
 */
async function converse(
  steps: Parameters<AgentStage["models"]["play"]>[0],
): Promise<number> {
  stage.models.play(steps);
  const res = await startConversation(stage, "Please run the tests.", {
    channelType: "web",
  });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  await runTicks();
  return res.body.conversation.id;
}

/** A `sandbox_start` step. */
const start = (extra: Record<string, unknown> = {}) => ({
  toolCalls: [
    {
      name: "sandbox_start",
      input: { title: "Run the tests", task: "Run the tests.", ...extra },
    },
  ],
});

/** A step that waits for the job. */
const wait = { toolCalls: [{ name: "sandbox_wait", input: {} }] };

/** A step that ends the turn. */
const reply = (text = "Started.") => ({
  toolCalls: [{ name: "reply_and_wait", input: { text } }],
});

describe("sandbox policy", () => {
  test("approve: the job waits for a person; approved, it is written and the conversation parks on it", async () => {
    await editBot({ sandboxPolicy: "approve", sandboxJobTokenBudget: 50_000 });
    const conversationId = await converse([start()]);
    expect((await conversation(conversationId)).waitingOn?.kind).toBe(
      "approval",
    );
    expect(await latestJob(conversationId)).toBeUndefined();
    const [approval] = await approvalsOf(conversationId);
    expect(approval).toMatchObject({ server: "sandbox", tool: "start" });
    const decided = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/approval/${approval.id}`,
      { decision: "approve" },
    );
    expect(decided.status).toBe(200);
    stage.models.play([wait]);
    await runTicks();
    const job = await latestJob(conversationId);
    expect(job).toMatchObject({
      title: "Run the tests",
      status: "provisioning",
      budgetTokens: 50_000,
    });
    expect(job?.triggeredByUserId).not.toBeNull();
    expect((await conversation(conversationId)).waitingOn).toEqual({
      kind: "sandbox",
      sandboxJobId: job?.id ?? 0,
    });
  });

  test("off: the bot is not offered sandbox_start", async () => {
    await editBot({ sandboxPolicy: "off" });
    stage.models.play([
      {
        toolCalls: [{ name: "reply_and_wait", input: { text: "Hi." } }],
        expect: { toolsOffered: undefined },
      },
    ]);
    const res = await startConversation(stage, "Hi", { channelType: "web" });
    await runTicks();
    const request = stage.models.requests.at(-1);
    expect(request?.body).not.toContain('"sandbox_start"');
    expect(res.status).toBe(200);
  });

  test("allow: the job starts at once, and the bot may end its turn without waiting", async () => {
    await editBot({ sandboxPolicy: "allow" });
    const conversationId = await converse([start(), reply()]);
    expect((await conversation(conversationId)).state).toBe("hibernating");
    const [result] = await resultsOf(conversationId, "sandbox_start");
    expect(result).toMatchObject({ status: "pending" });
    expect((await latestJob(conversationId))?.status).toBe("provisioning");
  });
});

describe("dispatch", () => {
  test("one job per bot in flight; the next waits pending", async () => {
    await editBot({ sandboxPolicy: "allow" });
    const first = await converse([start(), wait]);
    const second = await converse([start(), wait]);
    expect((await latestJob(first))?.status).toBe("provisioning");
    expect((await latestJob(second))?.status).toBe("pending");
    const queued = await api.resque.queue.length("sandboxes");
    expect(queued).toBe(1);
  });
});

describe("the other sandbox tools", () => {
  test("status lists this conversation's jobs only; cancel stops a job still provisioning", async () => {
    await editBot({ sandboxPolicy: "allow" });
    const conversationId = await converse([start(), reply()]);
    const job = await latestJob(conversationId);
    if (!job) throw new Error("no job");
    stage.models.play([
      {
        toolCalls: [
          { name: "sandbox_status", input: {} },
          { name: "sandbox_cancel", input: { jobId: job.id } },
          { name: "sandbox_status", input: { jobId: job.id + 9999 } },
        ],
      },
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Stopped." } }] },
    ]);
    const sent = await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/conversation/${conversationId}/message`,
      { text: "Never mind." },
    );
    expect(sent.status).toBe(200);
    await runTicks();
    // Parallel-safe calls run together, so their results land in any order.
    const statuses = await resultsOf(conversationId, "sandbox_status");
    const listed = statuses.find((r) => Array.isArray(r.jobs));
    const missing = statuses.find((r) => r.is_error);
    expect(JSON.stringify(listed)).toContain(`"jobId":${job.id}`);
    expect(missing).toMatchObject({ is_error: true, error_type: "not_found" });
    // Claimed but not yet up: the cancel is a flag, and provisioning stops
    // at its next step.
    const [cancelled] = await resultsOf(conversationId, "sandbox_cancel");
    expect(cancelled).toMatchObject({ status: "provisioning" });
    expect((await jobRow(job.id)).cancelRequested).toBe(true);
    expect(await startSandboxJob(job.id)).toBe("cancelled");
    expect(await jobRow(job.id)).toMatchObject({
      status: "cancelled",
      endReason: "bot",
    });
  });
});

describe("sandbox_wait", () => {
  test("parks on the latest job; a person's message wakes it; a job already ended is refused", async () => {
    await editBot({ sandboxPolicy: "allow" });
    const conversationId = await converse([start(), wait]);
    const job = await latestJob(conversationId);
    if (!job) throw new Error("no job");
    expect((await conversation(conversationId)).waitingOn).toEqual({
      kind: "sandbox",
      sandboxJobId: job.id,
    });
    await api.db.db
      .update(sandboxJobs)
      .set({ status: "succeeded", endedAt: new Date() })
      .where(eq(sandboxJobs.id, job.id));
    stage.models.play([wait, reply("It is done.")]);
    const sent = await call(
      stage.u.url,
      stage.u.peach,
      "PUT",
      `/project/${stage.u.projectId}/conversation/${conversationId}/message`,
      { text: "How is it going?" },
    );
    expect(sent.status).toBe(200);
    await runTicks();
    const [refused] = await resultsOf(conversationId, "sandbox_wait").then(
      (r) => r.slice(1),
    );
    expect(refused).toMatchObject({ is_error: true, error_type: "job_ended" });
    expect((await conversation(conversationId)).state).toBe("hibernating");
  });
});

describe("the production guard", () => {
  test("docker is refused in production, both when chosen and when a job starts", async () => {
    await editBot({ sandboxPolicy: "allow" });
    const conversationId = await converse([start(), reply()]);
    const job = await latestJob(conversationId);
    if (!job) throw new Error("no job");
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const chosen = await call(
        stage.u.url,
        stage.u.peach,
        "POST",
        `/project/${stage.u.projectId}/settings`,
        { sandboxProvider: "docker" },
      );
      expect(chosen.status).toBe(406);
      expect(JSON.stringify(chosen.body)).toContain("development only");
      await api.db.db
        .update(sandboxJobs)
        .set({ status: "provisioning" })
        .where(eq(sandboxJobs.id, job.id));
      expect(await startSandboxJob(job.id)).toBe("failed");
    } finally {
      process.env.NODE_ENV = was;
    }
    const failed = await jobRow(job.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("development only");
    expect(config.sandbox.defaultProvider).toBe("docker");
  });
});
