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
import { sandboxJobEvents } from "../../schema/sandbox_job_events";
import { sandboxJobQuestions } from "../../schema/sandbox_job_questions";
import { sandboxJobs } from "../../schema/sandbox_jobs";
import {
  type AgentStage,
  clearLoopQueues,
  MODEL_KEY,
  runTicks,
  startConversation,
} from "../agent/harness";
import { call, HOOK_TIMEOUT, runAction } from "../setup";
import {
  buildSandboxStage,
  buildTestImage,
  conversation,
  destroyManagedContainers,
  dockerAvailable,
  entries,
  eventually,
  jobRow,
  latestJob,
  liveLedger,
  runStarts,
  surfaceTexts,
} from "./harness";

/**
 * **A job's whole life, in a real container**: a conversation's
 * `sandbox_start`, the claim, provisioning, the real supervisor running the
 * stub CLI, which reports status, asks a question the bot answers, calls a
 * model through the model proxy and memory through our MCP server, submits
 * a `result` — and the parent waking with it. Then the endings: a person's
 * cancel (exit 143 is `cancelled`), a conversation's cancel, a failure, an
 * interactive job's turns. Skipped where no Docker daemon answers.
 */

const describeDocker = dockerAvailable ? describe : describe.skip;
if (!dockerAvailable) {
  console.warn(
    "\n⚠  Skipping __tests__/sandbox/lifecycle.test.ts — no Docker daemon answers here.\n",
  );
}

/** A whole job through a container is seconds, not milliseconds. */
const JOB_TIMEOUT = 120_000;

let stage: AgentStage;
let sandboxDefaults: typeof config.sandbox;

beforeAll(async () => {
  if (!dockerAvailable) return;
  await buildTestImage();
  stage = await buildSandboxStage("allow");
  sandboxDefaults = { ...config.sandbox };
  // The supervisor's heartbeat is written into the sandbox's environment.
  config.sandbox.heartbeatMs = 1_000;
}, JOB_TIMEOUT);

afterEach(async () => {
  if (!dockerAvailable) return;
  await clearLoopQueues();
  stage.models.reset();
});

afterAll(async () => {
  if (!dockerAvailable) return;
  Object.assign(config.sandbox, sandboxDefaults);
  await destroyManagedContainers();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * A stub scenario, one directive per line.
 * @param directives - The directives.
 * @returns The task text.
 */
function scenario(...directives: Record<string, unknown>[]): string {
  return [
    "Do the work described below.",
    ...directives.map((d) => `STUB ${JSON.stringify(d)}`),
  ].join("\n");
}

/**
 * Start a conversation whose first step starts a job, and bring the job up.
 * @param task - The job's task.
 * @param extra - More `sandbox_start` inputs.
 * @returns The conversation and job ids.
 */
async function startJob(
  task: string,
  extra: Record<string, unknown> = {},
): Promise<{ conversationId: number; jobId: number }> {
  stage.models.play([
    {
      toolCalls: [
        {
          name: "sandbox_start",
          input: { title: "Run the tests", task, ...extra },
        },
      ],
    },
    { toolCalls: [{ name: "sandbox_wait", input: {} }] },
  ]);
  const res = await startConversation(stage, "Please run the tests.", {
    channelType: "web",
  });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  const conversationId = res.body.conversation.id;
  await runTicks();
  const job = await latestJob(conversationId);
  if (!job) throw new Error("no job was started");
  expect(await runStarts()).toEqual(["sandbox-job:start"]);
  return { conversationId, jobId: job.id };
}

/**
 * Wait for a job to end.
 * @param jobId - The job.
 * @returns The ended job.
 */
async function ended(jobId: number) {
  return eventually(
    `job ${jobId} to end`,
    async () => {
      const job = await jobRow(jobId);
      return job.endedAt ? job : null;
    },
    JOB_TIMEOUT,
  );
}

/**
 * The id of a job's container.
 * @param jobId - The job.
 * @returns The container id.
 */
async function containerOf(jobId: number): Promise<string> {
  const [row] = await liveLedger(jobId);
  if (!row?.externalId) throw new Error(`job ${jobId} has no sandbox`);
  return row.externalId;
}

/**
 * Run a command in a container.
 * @param id - The container.
 * @param cmd - The command.
 * @returns Its stdout.
 */
async function dockerExec(id: string, cmd: string): Promise<string> {
  const proc = Bun.spawn(["docker", "exec", id, "/bin/sh", "-c", cmd], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

describeDocker("a job, end to end", () => {
  test(
    "start → provision → status, a question the bot answers, a model call, memory, a result → the parent wakes with it, and nothing is left running",
    async () => {
      stage.models.script("The tests look fine.");
      const { conversationId, jobId } = await startJob(
        scenario(
          { op: "status", state: "testing", message: "Running the tests" },
          { op: "ask", question: "Which branch?", waitSeconds: 90 },
          { op: "model", prompt: "Summarize the run" },
          { op: "memory", query: "castle" },
          {
            op: "artifact",
            name: "result",
            content: "All 12 tests pass on {{answer}}",
          },
          { op: "result", text: "Ran the tests on {{answer}}." },
        ),
      );
      const waiting = await conversation(conversationId);
      expect(waiting.state).toBe("waiting");
      expect(waiting.waitingOn).toEqual({
        kind: "sandbox",
        sandboxJobId: jobId,
      });
      const running = await jobRow(jobId);
      expect(running.status).toBe("running");
      expect(running.briefing).toContain("## The task: Run the tests");
      expect(running.briefing).toContain("Which branch?");

      // The blocking question wakes the bot, which answers it.
      const question = await eventually("the question", async () => {
        const [q] = await api.db.db
          .select()
          .from(sandboxJobQuestions)
          .where(eq(sandboxJobQuestions.jobId, jobId));
        return q;
      });
      expect(question.question).toBe("Which branch?");
      await eventually(
        "the parent to wake",
        async () => (await conversation(conversationId)).state === "working",
      );
      stage.models.play([
        {
          toolCalls: [
            {
              name: "sandbox_message",
              input: { jobId, questionId: question.id, text: "main" },
            },
          ],
          expect: { lastMessageIncludes: "Which branch?" },
        },
        {
          toolCalls: [
            { name: "reply_and_wait", input: { text: "Told it: main." } },
          ],
        },
      ]);
      await runTicks();
      expect((await conversation(conversationId)).state).toBe("hibernating");

      // The job ends, and its result wakes the parent.
      const job = await ended(jobId);
      expect(job.status).toBe("succeeded");
      expect(job.endReason).toBe("complete");
      expect(job.closingText).toBe("Ran the tests on main.");
      expect(job.artifacts.result.content).toBe("All 12 tests pass on main");
      expect(job.reportedStatus).toBe("testing");
      expect(job.usage.requests).toBe(1);
      expect(job.exitCode).toBe(0);

      stage.models.play([
        {
          toolCalls: [
            {
              name: "reply_and_wait",
              input: { text: "All 12 tests pass on main." },
            },
          ],
          expect: { lastMessageIncludes: "All 12 tests pass on main" },
        },
      ]);
      await eventually(
        "the parent to wake with the result",
        async () => (await conversation(conversationId)).state === "working",
      );
      await runTicks();
      expect(stage.models.expectationFailures).toEqual([]);

      // The model proxy signed the agent's call with the real key; the
      // sandbox only ever sent its job token.
      const proxied = stage.models.requests.filter((r) => {
        if (!r.path.endsWith("/messages")) return false;
        const body = JSON.parse(r.body || "{}") as {
          messages?: { content?: unknown }[];
        };
        return body.messages?.[0]?.content === "Summarize the run";
      });
      expect(proxied).toHaveLength(1);
      expect(proxied[0].headers["x-api-key"]).toBe(MODEL_KEY);
      expect(proxied[0].headers.authorization).toBeUndefined();

      // People saw the work where they asked.
      const surface = await surfaceTexts(conversationId);
      expect(surface).toContain("Working in a sandbox: Run the tests");
      expect(surface).toContain("Run the tests: Running the tests");
      expect(surface).toContain(
        'The sandbox working on "Run the tests" has a question.',
      );
      expect(surface).toContain(
        'The sandbox working on "Run the tests" finished.',
      );
      // The transcript records the status for people, and the job's events
      // are its own transcript.
      const notes = (await entries(conversationId))
        .filter((e) => e.kind === "status_change")
        .map((e) => String((e.content as { text?: string }).text));
      expect(notes).toContain(
        "sandbox job #" +
          jobId +
          ' ("Run the tests") reports testing: Running the tests',
      );
      const events = await api.db.db
        .select()
        .from(sandboxJobEvents)
        .where(eq(sandboxJobEvents.jobId, jobId));
      expect(events.some((e) => e.kind === "init")).toBe(true);
      expect(
        events.some(
          (e) =>
            e.kind === "tool_use" &&
            e.toolName === "mcp__hypotenuse__sandbox-report-status",
        ),
      ).toBe(true);
      expect(events.some((e) => e.kind === "result")).toBe(true);

      // Nothing is left: the ledger is closed and the container is gone.
      await eventually(
        "the ledger to close",
        async () => (await liveLedger(jobId)).length === 0,
      );
      expect(
        (
          await new (
            await import("../../sandbox/providers/docker")
          ).DockerSandboxProvider().list({ job: String(jobId) })
        ).length,
      ).toBe(0);
    },
    JOB_TIMEOUT * 2,
  );
});

describeDocker("the only credential in a sandbox is its job token", () => {
  test(
    "its environment and /work hold the token and no key; its MCP config holds only a reference",
    async () => {
      const { jobId } = await startJob(scenario({ op: "hang" }));
      const id = await containerOf(jobId);
      const env = (await dockerExec(id, "env"))
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const eq = line.indexOf("=");
          return [line.slice(0, eq), line.slice(eq + 1)] as const;
        });
      const tokenVars = env.filter(([, v]) => v.startsWith("hyp_job_"));
      expect(tokenVars.map(([k]) => k).sort()).toEqual([
        "ANTHROPIC_AUTH_TOKEN",
        "HYPOTENUSE_JOB_TOKEN",
      ]);
      const token = tokenVars[0][1];
      expect(new Set(tokenVars.map(([, v]) => v)).size).toBe(1);
      // Nothing credential-shaped besides the token.
      const credentialShaped = env.filter(
        ([k, v]) =>
          v !== token &&
          (/(KEY|SECRET|PASSWORD|CREDENTIAL)/i.test(k) ||
            /^(sk-|hyp_cli_|xox[abp]-|lin_|Bearer )/.test(v)),
      );
      expect(credentialShaped).toEqual([]);
      expect(env.some(([, v]) => v.includes(MODEL_KEY))).toBe(false);
      // On disk: the model key nowhere, and the token not even in the MCP
      // config, which names it as `${HYPOTENUSE_JOB_TOKEN}`.
      expect(
        await dockerExec(id, `grep -rl '${MODEL_KEY}' /work || true`),
      ).toBe("");
      expect(await dockerExec(id, `grep -rl '${token}' /work || true`)).toBe(
        "",
      );
      const mcp = await dockerExec(id, "cat /work/.hypotenuse/mcp.json");
      expect(mcp).toContain("${HYPOTENUSE_JOB_TOKEN}");
      expect(await dockerExec(id, "id -un")).toBe("agent\n");

      // A person stops it: SIGTERM at the next heartbeat, exit 143 is
      // `cancelled`, and the parent waiting on it wakes.
      const res = await call(
        stage.u.url,
        stage.u.peach,
        "POST",
        `/project/${stage.u.projectId}/sandbox-job/${jobId}/cancel`,
      );
      expect(res.status).toBe(200);
      const job = await ended(jobId);
      expect(job.status).toBe("cancelled");
      expect(job.endReason).toBe("person");
      expect(job.exitCode).toBe(143);
      const parent = await conversation(job.parentConversationId);
      expect(parent.state).toBe("working");
      await eventually(
        "the ledger to close",
        async () => (await liveLedger(jobId)).length === 0,
      );
    },
    JOB_TIMEOUT,
  );
});

describeDocker("endings", () => {
  test(
    "cancelling the conversation stops its job, and the ended conversation stays ended",
    async () => {
      const { conversationId, jobId } = await startJob(
        scenario({ op: "hang" }),
      );
      await eventually(
        "a heartbeat",
        async () => (await jobRow(jobId)).lastHeartbeatAt !== null,
      );
      const res = await call(
        stage.u.url,
        stage.u.peach,
        "POST",
        `/project/${stage.u.projectId}/conversation/${conversationId}/cancel`,
      );
      expect(res.status).toBe(200);
      const job = await ended(jobId);
      expect(job.status).toBe("cancelled");
      expect(job.endReason).toBe("conversation_cancelled");
      const after = await conversation(conversationId);
      expect(after.state).toBe("ended");
      expect(after.outcome).toBe("cancelled");
    },
    JOB_TIMEOUT,
  );

  test(
    "a failed run ends the job failed, and the parent wakes told why",
    async () => {
      const { conversationId, jobId } = await startJob(
        scenario({ op: "fail", message: "the build is broken" }),
      );
      const job = await ended(jobId);
      expect(job.status).toBe("failed");
      expect(job.error).toBe("the build is broken");
      expect(job.exitCode).toBe(2);
      stage.models.play([
        {
          toolCalls: [
            { name: "reply_and_wait", input: { text: "It failed." } },
          ],
          expect: { lastMessageIncludes: "the build is broken" },
        },
      ]);
      await eventually(
        "the parent to wake",
        async () => (await conversation(conversationId)).state === "working",
      );
      await runTicks();
      expect(stage.models.expectationFailures).toEqual([]);
    },
    JOB_TIMEOUT,
  );

  test(
    "an interactive job waits between turns, takes a follow-up by heartbeat, and expires when nobody comes back",
    async () => {
      const { conversationId, jobId } = await startJob(
        scenario({ op: "result", text: "First turn done." }),
        { interactive: true },
      );
      await eventually(
        "the first turn to end",
        async () => (await jobRow(jobId)).status === "awaiting_input",
      );
      expect((await jobRow(jobId)).closingText).toBe("First turn done.");
      // The turn's end wakes the parent, which sends the next instruction.
      await eventually(
        "the parent to wake",
        async () => (await conversation(conversationId)).state === "working",
      );
      stage.models.play([
        {
          toolCalls: [
            {
              name: "sandbox_message",
              input: { jobId, text: "Now run the linter." },
            },
          ],
          expect: { lastMessageIncludes: "waiting for its next instruction" },
        },
        {
          toolCalls: [
            { name: "reply_and_wait", input: { text: "Asked it to lint." } },
          ],
        },
      ]);
      await runTicks();
      await eventually("the second turn to end", async () => {
        const job = await jobRow(jobId);
        return (
          job.status === "awaiting_input" &&
          job.closingText === "follow-up done: Now run the linter."
        );
      });
      // Nobody comes back: the idle sweep ends it `expired`.
      await api.db.db
        .update(sandboxJobs)
        .set({ idleTimeoutMs: 1 })
        .where(eq(sandboxJobs.id, jobId));
      await Bun.sleep(20);
      await runAction("sandbox-jobs:reap");
      const job = await jobRow(jobId);
      expect(job.status).toBe("expired");
      expect(job.endReason).toBe("idle_interactive");
      await eventually(
        "the ledger to close",
        async () => (await liveLedger(jobId)).length === 0,
      );
    },
    JOB_TIMEOUT,
  );
});
