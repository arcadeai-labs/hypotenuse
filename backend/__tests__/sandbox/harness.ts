import { desc, eq } from "drizzle-orm";
import { api, config } from "keryx";
import { generateJobToken, registerJobToken } from "../../ops/SandboxJobOps";
import {
  DockerSandboxProvider,
  isDockerAvailable,
} from "../../sandbox/providers/docker";
import { conversationEntries } from "../../schema/conversation_entries";
import { type Conversation, conversations } from "../../schema/conversations";
import { outboxMessages } from "../../schema/outbox_messages";
import { type SandboxJob, sandboxJobs } from "../../schema/sandbox_jobs";
import { sandboxes } from "../../schema/sandboxes";
import { type AgentStage, buildAgentStage, drainQueue } from "../agent/harness";
import { call } from "../setup";

/**
 * The sandbox suites' stage: the agent stage (a scripted Anthropic model,
 * Toadsworth) with the bot allowed to start sandbox jobs and the project
 * pointed at the stub image. Jobs that need no container are written as rows
 * with a minted token, so the supervisor's half can be driven over HTTP the
 * way a sandbox drives it.
 */

/** The image the suites provision: `oven/bun:1` with the stub CLI. */
export const TEST_IMAGE = "hypotenuse/sandbox:test";

/** Whether a Docker daemon answers here. */
export const dockerAvailable = await isDockerAvailable();

/** Labels the suite's containers carry, so cleanup never touches others. */
export const MANAGED_LABEL = "hypotenuse.managed";

/**
 * Build the stage.
 * @param policy - The bot's sandbox policy.
 * @returns The stage.
 */
export async function buildSandboxStage(
  policy: "allow" | "approve" | "off" = "allow",
): Promise<AgentStage> {
  const stage = await buildAgentStage("anthropic");
  await api.resque.queue.delQueue("sandboxes");
  const bot = await call(
    stage.u.url,
    stage.u.peach,
    "POST",
    `/project/${stage.u.projectId}/bot/${stage.botId}`,
    { sandboxPolicy: policy },
  );
  if (bot.status !== 200) throw new Error(JSON.stringify(bot.body));
  const settings = await call(
    stage.u.url,
    stage.u.peach,
    "POST",
    `/project/${stage.u.projectId}/settings`,
    { sandboxProvider: "docker", sandboxImage: TEST_IMAGE },
  );
  if (settings.status !== 200) throw new Error(JSON.stringify(settings.body));
  return stage;
}

/**
 * Build the stub image, so a checkout with a daemon needs no extra step.
 * @throws {Error} When the build fails.
 */
export async function buildTestImage(): Promise<void> {
  const dir = `${import.meta.dir}/../../sandbox/images`;
  const proc = Bun.spawn(
    ["docker", "build", "-f", `${dir}/Dockerfile.test`, "-t", TEST_IMAGE, dir],
    { stdout: "pipe", stderr: "pipe" },
  );
  if ((await proc.exited) !== 0) {
    throw new Error(
      `could not build ${TEST_IMAGE}: ${await new Response(proc.stderr).text()}`,
    );
  }
}

/**
 * Destroy every container this provider manages.
 * @returns The ids removed.
 */
export async function destroyManagedContainers(): Promise<string[]> {
  if (!dockerAvailable) return [];
  const listings = await new DockerSandboxProvider().list();
  if (listings.length === 0) return [];
  const ids = listings.map((l) => l.id);
  await Bun.spawn(["docker", "rm", "-f", ...ids], {
    stdout: "ignore",
    stderr: "ignore",
  }).exited;
  return ids;
}

/**
 * Wait until a condition holds.
 * @param what - What is awaited, for the error.
 * @param check - The condition; a truthy answer ends the wait.
 * @param timeoutMs - How long to wait.
 * @returns The truthy answer.
 * @throws {Error} When it never holds.
 */
export async function eventually<T>(
  what: string,
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(200);
  }
}

/**
 * Re-read a job.
 * @param jobId - The job.
 * @returns The row.
 */
export async function jobRow(jobId: number): Promise<SandboxJob> {
  const [row] = await api.db.db
    .select()
    .from(sandboxJobs)
    .where(eq(sandboxJobs.id, jobId));
  return row;
}

/**
 * The newest job of a conversation.
 * @param conversationId - The conversation.
 * @returns The job, if any.
 */
export async function latestJob(
  conversationId: number,
): Promise<SandboxJob | undefined> {
  const [row] = await api.db.db
    .select()
    .from(sandboxJobs)
    .where(eq(sandboxJobs.parentConversationId, conversationId))
    .orderBy(desc(sandboxJobs.id))
    .limit(1);
  return row;
}

/**
 * Re-read a conversation.
 * @param id - The conversation.
 * @returns The row.
 */
export async function conversation(id: number): Promise<Conversation> {
  const [row] = await api.db.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id));
  return row;
}

/**
 * The status rows the conversation's surface was given, oldest first.
 * @param conversationId - The conversation.
 * @returns Their texts.
 */
export async function surfaceTexts(conversationId: number): Promise<string[]> {
  const rows = await api.db.db
    .select()
    .from(outboxMessages)
    .where(eq(outboxMessages.conversationId, conversationId))
    .orderBy(outboxMessages.id);
  return rows.map((r) => String((r.payload as { text?: string }).text ?? ""));
}

/**
 * Every transcript entry of a conversation, oldest first.
 * @param conversationId - The conversation.
 * @returns The rows.
 */
export async function entries(conversationId: number) {
  return api.db.db
    .select()
    .from(conversationEntries)
    .where(eq(conversationEntries.conversationId, conversationId))
    .orderBy(conversationEntries.seq);
}

/**
 * The live ledger rows of a job.
 * @param jobId - The job.
 * @returns The rows not yet destroyed.
 */
export async function liveLedger(jobId: number) {
  const rows = await api.db.db
    .select()
    .from(sandboxes)
    .where(eq(sandboxes.jobId, jobId));
  return rows.filter((r) => r.destroyedAt === null);
}

/**
 * Write a job row for a conversation and mint its token, as `sandbox-job:start`
 * does — for the suites that drive the supervisor's half over HTTP with no
 * container.
 * @param stage - The stage.
 * @param conversationId - The parent conversation.
 * @param extra - Columns to set.
 * @returns The job and its plaintext token.
 */
export async function mintJob(
  stage: AgentStage,
  conversationId: number,
  extra: Partial<typeof sandboxJobs.$inferInsert> = {},
): Promise<{ job: SandboxJob; token: string }> {
  const { token, tokenHash } = generateJobToken();
  const now = new Date();
  const [job] = await api.db.db
    .insert(sandboxJobs)
    .values({
      projectId: stage.u.projectId,
      botId: stage.botId,
      parentConversationId: conversationId,
      title: "Run the tests",
      task: "Run the tests.",
      status: "running",
      provider: "docker",
      maxDurationMs: config.sandbox.maxDurationMs,
      idleTimeoutMs: config.sandbox.idleTimeoutMs,
      tokenHash,
      startedAt: now,
      lastHeartbeatAt: now,
      lastActivityAt: now,
      ...extra,
    })
    .returning();
  await registerJobToken(job.id, token, 60 * 60 * 1000);
  return { job, token };
}

/**
 * Run the queued `sandbox-job:start` jobs.
 * @returns The jobs run.
 */
export async function runStarts(): Promise<string[]> {
  return drainQueue("sandboxes", { only: "sandbox-job:start" });
}

/**
 * Call an endpoint with a job token in the body, as the supervisor does.
 * @param url - The server.
 * @param method - The verb.
 * @param path - The path under `/api`.
 * @param token - The job token.
 * @param body - The rest of the body.
 * @returns The status and parsed body.
 */
export async function asJob<T = Record<string, unknown>>(
  url: string,
  method: string,
  path: string,
  token: string,
  body: Record<string, unknown> = {},
): Promise<{ status: number; body: T }> {
  // A GET carries the token as a bearer, the way the coding CLI's MCP
  // client and the proxies' callers do; the supervisor posts it in a body.
  const isGet = method === "GET";
  const query = isGet
    ? `?${new URLSearchParams(
        Object.entries(body).map(([k, v]): [string, string] => [k, String(v)]),
      )}`
    : "";
  const res = await fetch(`${url}/api${path}${query}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(isGet ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(isGet ? {} : { body: JSON.stringify({ ...body, token }) }),
  });
  return { status: res.status, body: (await res.json()) as T };
}
