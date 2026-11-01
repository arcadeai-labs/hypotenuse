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
import { sandboxJobs } from "../../schema/sandbox_jobs";
import { READ_JOB_MAX_DURATION_MS } from "../../tools/sandbox-start";
import {
  type AgentStage,
  clearLoopQueues,
  runTicks,
  startConversation,
} from "../agent/harness";
import { approvalsOf, resultsOf } from "../mcp/harness";
import { buildSandboxStage, conversation, latestJob } from "../sandbox/harness";
import { call, HOOK_TIMEOUT } from "../setup";
import { buildGitStage, type GitStage } from "./repo-harness";

/**
 * **`sandbox_start` with a repository**: the bot must hold a grant for it,
 * `write` mode needs a push grant, and `read` mode is the cheap profile —
 * no approval under the `approve` policy, a capped duration — while `write`
 * still parks for a person. Nothing here starts a container.
 */
let stage: AgentStage;
let git: GitStage;

beforeAll(async () => {
  stage = await buildSandboxStage("approve");
  git = await buildGitStage(stage);
}, HOOK_TIMEOUT);

afterEach(async () => {
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
  await git.restore();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Set the bot's sandbox policy.
 * @param sandboxPolicy - The policy.
 */
async function policy(sandboxPolicy: "allow" | "approve"): Promise<void> {
  const res = await call(
    stage.u.url,
    stage.u.peach,
    "POST",
    `/project/${stage.u.projectId}/bot/${stage.botId}`,
    { sandboxPolicy },
  );
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
}

/**
 * A conversation whose first step calls `sandbox_start` with these inputs,
 * then ends its turn.
 * @param extra - The repository inputs.
 * @returns The conversation's id.
 */
async function start(extra: Record<string, unknown>): Promise<number> {
  stage.models.play([
    {
      toolCalls: [
        {
          name: "sandbox_start",
          input: { title: "Look", task: "Look at the code.", ...extra },
        },
      ],
    },
    { toolCalls: [{ name: "reply_and_wait", input: { text: "On it." } }] },
  ]);
  const res = await startConversation(stage, "How does auth work?", {
    channelType: "web",
  });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  await runTicks();
  return res.body.conversation.id;
}

describe("sandbox_start with a repository", () => {
  test("a repository the bot holds no grant for is refused, naming it and who can grant it, and no approval is asked", async () => {
    await policy("approve");
    const id = await start({ repository: "acme/secret" });
    const [result] = await resultsOf(id, "sandbox_start");
    expect(result).toMatchObject({
      is_error: true,
      error_type: "repository_not_granted",
    });
    expect(JSON.stringify(result)).toContain("acme/secret");
    expect(JSON.stringify(result)).toContain("Repositories");
    expect(await approvalsOf(id)).toEqual([]);
    expect(await latestJob(id)).toBeUndefined();
  });

  test("write mode on a read grant is refused, pointing at mode read", async () => {
    await policy("allow");
    const id = await start({ repository: "acme/lib" });
    const [result] = await resultsOf(id, "sandbox_start");
    expect(result).toMatchObject({
      is_error: true,
      error_type: "repository_read_only",
    });
    expect(JSON.stringify(result)).toContain('mode \\"read\\"');
    expect(await latestJob(id)).toBeUndefined();
  });

  test("read mode on an approve bot runs without an approval, with a capped duration", async () => {
    await policy("approve");
    const id = await start({
      repository: "https://github.com/Acme/Lib.git",
      mode: "read",
      ref: "main",
    });
    expect(await approvalsOf(id)).toEqual([]);
    const job = await latestJob(id);
    expect(job?.repository).toEqual({
      host: "github.com",
      owner: "acme",
      name: "lib",
      ref: "main",
      mode: "read",
    });
    expect(job?.maxDurationMs).toBe(READ_JOB_MAX_DURATION_MS);
    expect((await conversation(id)).state).toBe("hibernating");
  });

  test("write mode on an approve bot still parks for a person", async () => {
    await policy("approve");
    const id = await start({ repository: "acme/api" });
    expect((await conversation(id)).waitingOn?.kind).toBe("approval");
    const [approval] = await approvalsOf(id);
    expect(approval).toMatchObject({ server: "sandbox", tool: "start" });
    expect(await latestJob(id)).toBeUndefined();
    const decided = await call(
      stage.u.url,
      stage.u.peach,
      "POST",
      `/project/${stage.u.projectId}/approval/${approval.id}`,
      { decision: "approve" },
    );
    expect(decided.status).toBe(200);
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Started." } }] },
    ]);
    await runTicks();
    const job = await latestJob(id);
    expect(job?.repository).toMatchObject({
      owner: "acme",
      name: "api",
      mode: "write",
    });
    expect(job?.maxDurationMs).toBeGreaterThan(READ_JOB_MAX_DURATION_MS);
  });

  test("mode or ref without a repository is refused", async () => {
    await policy("allow");
    const id = await start({ mode: "read" });
    const [result] = await resultsOf(id, "sandbox_start");
    expect(result).toMatchObject({
      is_error: true,
      error_type: "invalid_input",
    });
  });
});
