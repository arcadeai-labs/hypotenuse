import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { conversations } from "../../schema/conversations";
import { helpRequests } from "../../schema/help_requests";
import { sandboxJobQuestions } from "../../schema/sandbox_job_questions";
import {
  type AgentStage,
  clearLoopQueues,
  runTicks,
  startConversation,
} from "../agent/harness";
import { call, HOOK_TIMEOUT } from "../setup";
import { asJob, buildSandboxStage, conversation, mintJob } from "./harness";

/**
 * **Questions from a sandbox**: ask now, collect later. A blocking question
 * wakes the conversation waiting on the job, and the bot answers it; a person
 * answers one from the dashboard; a check that runs out is `pending` with
 * `timedOut`; the cap holds under concurrent asks; a request for help goes to
 * the Help inbox and its answer back to the job, not the conversation.
 */
let stage: AgentStage;

beforeAll(async () => {
  stage = await buildSandboxStage("allow");
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
});

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * A hibernating conversation, then parked on a job as `sandbox_start` would.
 * @returns The conversation and the job's token.
 */
async function parkedOnJob() {
  stage.models.play([
    { toolCalls: [{ name: "reply_and_wait", input: { text: "Hi." } }] },
  ]);
  const res = await startConversation(stage, "Hello", { channelType: "web" });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  const conversationId = res.body.conversation.id;
  await runTicks();
  const minted = await mintJob(stage, conversationId);
  await api.db.db
    .update(conversations)
    .set({
      state: "waiting",
      waitingOn: { kind: "sandbox", sandboxJobId: minted.job.id },
    })
    .where(eq(conversations.id, conversationId));
  return { conversationId, ...minted };
}

describe("asking the conversation", () => {
  test("a blocking question wakes the waiting bot, which answers it; the agent collects the answer", async () => {
    const { conversationId, job, token } = await parkedOnJob();
    const asked = await asJob<{ questionId: number }>(
      stage.u.url,
      "PUT",
      "/sandbox/job/question",
      token,
      { question: "Which branch?", options: ["main", "dev"] },
    );
    expect(asked.status).toBe(200);
    const woken = await conversation(conversationId);
    expect(woken.state).toBe("working");
    stage.models.play([
      {
        toolCalls: [
          {
            name: "sandbox_message",
            input: {
              jobId: job.id,
              questionId: asked.body.questionId,
              text: "main",
            },
          },
        ],
        expect: { lastMessageIncludes: "Which branch?" },
      },
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Done." } }] },
    ]);
    await runTicks();
    const check = await asJob<{ status: string; answer: string }>(
      stage.u.url,
      "GET",
      `/sandbox/job/question/${asked.body.questionId}`,
      token,
      { waitMs: 0 },
    );
    expect(check.body).toMatchObject({ status: "answered", answer: "main" });
  });

  test("a question not blocking does not wake anyone; a person answers it from the dashboard", async () => {
    const { conversationId, job, token } = await parkedOnJob();
    const asked = await asJob<{ questionId: number }>(
      stage.u.url,
      "PUT",
      "/sandbox/job/question",
      token,
      { question: "Should I also lint?", blocking: false },
    );
    expect(asked.status).toBe(200);
    expect((await conversation(conversationId)).state).toBe("waiting");
    // Toad can read the bot but not write it.
    const locked = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { accessWrite: ["admin"] },
    );
    expect(locked.status).toBe(200);
    const refused = await call(
      stage.u.url,
      stage.u.toad,
      "POST",
      `/project/${stage.u.projectId}/sandbox-job/${job.id}/question/${asked.body.questionId}`,
      { answer: "no" },
    );
    expect(refused.status).toBe(403);
    await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/bot/${stage.botId}`,
      { accessWrite: [] },
    );
    const answered = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/sandbox-job/${job.id}/question/${asked.body.questionId}`,
      { answer: "Yes, lint too." },
    );
    expect(answered.status).toBe(200);
    const again = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/sandbox-job/${job.id}/question/${asked.body.questionId}`,
      { answer: "Changed my mind." },
    );
    expect(again.status).toBe(406);
    const check = await asJob<{ answer: string; answeredBy: string }>(
      stage.u.url,
      "GET",
      `/sandbox/job/question/${asked.body.questionId}`,
      token,
      { waitMs: 0 },
    );
    expect(check.body.answer).toBe("Yes, lint too.");
  });

  test("a check that runs out is pending and timedOut, not an error, and counts as activity", async () => {
    const { job, token } = await parkedOnJob();
    const asked = await asJob<{ questionId: number }>(
      stage.u.url,
      "PUT",
      "/sandbox/job/question",
      token,
      { question: "Anyone there?", blocking: false },
    );
    const before = Date.now();
    const check = await asJob<{ status: string; timedOut: boolean }>(
      stage.u.url,
      "GET",
      `/sandbox/job/question/${asked.body.questionId}`,
      token,
      { waitMs: 600 },
    );
    expect(check.status).toBe(200);
    expect(check.body).toMatchObject({ status: "pending", timedOut: true });
    expect(Date.now() - before).toBeGreaterThanOrEqual(500);
    const view = await call<{ sandboxJob: { lastActivityAt: number } }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/sandbox-job/${job.id}`,
    );
    expect(view.body.sandboxJob.lastActivityAt).toBeGreaterThanOrEqual(before);
  });

  test("five questions per job, held under twenty concurrent asks", async () => {
    const { job, token } = await parkedOnJob();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        asJob(stage.u.url, "PUT", "/sandbox/job/question", token, {
          question: `Question ${i}?`,
          blocking: false,
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(5);
    const refused = results.filter((r) => r.status !== 200);
    expect(refused).toHaveLength(15);
    expect(JSON.stringify(refused[0].body)).toContain("Do not ask again");
    const rows = await api.db.db
      .select()
      .from(sandboxJobQuestions)
      .where(eq(sandboxJobQuestions.jobId, job.id));
    expect(rows).toHaveLength(5);
  });
});

describe("asking the team", () => {
  test("goes to the Help inbox; its answer goes back to the job and the conversation stays asleep", async () => {
    const { conversationId, token } = await parkedOnJob();
    const asked = await asJob<{ questionId: number; helpRequestId: number }>(
      stage.u.url,
      "PUT",
      "/sandbox/job/help",
      token,
      { question: "Who owns the deploy key?", urgency: "high" },
    );
    expect(asked.status).toBe(200);
    const [request] = await api.db.db
      .select()
      .from(helpRequests)
      .where(eq(helpRequests.id, asked.body.helpRequestId));
    expect(request).toMatchObject({
      question: "Who owns the deploy key?",
      sandboxQuestionId: asked.body.questionId,
      entryId: null,
      status: "pending",
    });
    const listed = await call<{ helpRequests: { id: number }[] }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/help`,
    );
    expect(listed.body.helpRequests.map((r) => r.id)).toContain(request.id);
    const answered = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/help/${request.id}`,
      { answer: "Luigi does." },
    );
    expect(answered.status).toBe(200);
    expect((await conversation(conversationId)).state).toBe("waiting");
    const check = await asJob<{ status: string; answer: string }>(
      stage.u.url,
      "GET",
      `/sandbox/job/question/${asked.body.questionId}`,
      token,
      { waitMs: 0 },
    );
    expect(check.body).toMatchObject({
      status: "answered",
      answer: "Luigi does.",
    });
  });
});
