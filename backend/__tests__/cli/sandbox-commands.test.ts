import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import { sandboxJobEvents } from "../../schema/sandbox_job_events";
import { sandboxJobQuestions } from "../../schema/sandbox_job_questions";
import { sandboxJobs } from "../../schema/sandbox_jobs";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  startConversation,
} from "../agent/harness";
import { cliSignIn, HOOK_TIMEOUT, type TestUser } from "../setup";

/**
 * `hypotenuse sandbox list|view|events|answer|cancel`, `project settings`,
 * and `bot edit --sandbox`, spawned from source against the booted server.
 * The jobs are rows written straight to the database for a conversation
 * started over HTTP, so no sandbox provider runs: what is under test is the
 * operator surface over them.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");
let stage: AgentStage;
const homes = new Map<string, string>();
let conversationId: number;
let runningJobId: number;
let pendingJobId: number;
let questionId: number;

/**
 * Give a person a config directory with a signed-in CLI.
 * @param user - Who.
 */
async function signIn(user: TestUser): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "hyp-sandbox-"));
  const url = stage.u.url;
  const { token, cliTokenId } = await cliSignIn(url, user, `${user.name}-cli`);
  mkdirSync(join(home, "hypotenuse"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, "hypotenuse", "credentials.json"),
    JSON.stringify({
      version: 1,
      current: url,
      servers: {
        [url]: {
          login: { token, cliTokenId, device: `${user.name}-cli` },
          organization: null,
          project: null,
        },
      },
    }),
    { mode: 0o600 },
  );
  homes.set(user.email, home);
}

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
  for (const user of [stage.u.peach, stage.u.toad]) await signIn(user);
  conversationId = (await startConversation(stage, "Fix the drawbridge")).body
    .conversation.id;
  const base = {
    projectId: stage.u.projectId,
    botId: stage.botId,
    parentConversationId: conversationId,
    maxDurationMs: 1_800_000,
    idleTimeoutMs: 600_000,
  };
  const [running] = await api.db.db
    .insert(sandboxJobs)
    .values({
      ...base,
      title: "Oil the drawbridge chains",
      task: "Find why the drawbridge sticks and fix it.",
      status: "running",
      provider: "docker",
      reportedStatus: "working",
      statusMessage: "reading the winch code",
      usage: { inputTokens: 1200, outputTokens: 300, requests: 4 },
      startedAt: new Date(),
    })
    .returning();
  const [pending] = await api.db.db
    .insert(sandboxJobs)
    .values({
      ...base,
      title: "Repaint the moat sign",
      task: "Repaint it.",
      status: "pending",
    })
    .returning();
  runningJobId = (running as { id: number }).id;
  pendingJobId = (pending as { id: number }).id;
  const [question] = await api.db.db
    .insert(sandboxJobQuestions)
    .values({
      jobId: runningJobId,
      kind: "conversation",
      question: "Which chain grease should I use?",
      options: ["lithium", "graphite"],
      expiresAt: new Date(Date.now() + 3_600_000),
    })
    .returning();
  questionId = (question as { id: number }).id;
  await api.db.db.insert(sandboxJobEvents).values(
    [
      { kind: "text", text: "Looking at the winch." },
      { kind: "tool_use", toolName: "Bash", text: "grep -rn winch src" },
      { kind: "text", text: "Found it." },
    ].map((e, i) => ({ ...e, jobId: runningJobId, seq: i + 1 })),
  );
}, HOOK_TIMEOUT);

afterAll(async () => {
  await clearLoopQueues();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Run the CLI as a person, in the Castle project.
 * @param user - Whose config directory to use.
 * @param args - Arguments after `hypotenuse --project <castle>`.
 * @param stdin - Written to its standard input.
 * @returns Exit code and captured output.
 */
async function as(user: TestUser, args: string[], stdin?: string) {
  const proc = Bun.spawn(
    ["bun", "run", CLI, "--project", String(stage.u.projectId), ...args],
    {
      stdin: stdin !== undefined ? new Blob([stdin]) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        XDG_CONFIG_HOME: homes.get(user.email),
        BROWSER: "none",
        NO_COLOR: "1",
        HYPOTENUSE_NO_UPDATE_CHECK: "1",
        HYPOTENUSE_URL: undefined,
        HYPOTENUSE_ORG: undefined,
        HYPOTENUSE_PROJECT: undefined,
      },
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

/**
 * Run a command with `--json` that must succeed, and parse its answer.
 * @param user - Who.
 * @param args - Arguments after `hypotenuse --json`.
 * @param stdin - Standard input.
 * @returns The parsed stdout.
 */
// biome-ignore lint/suspicious/noExplicitAny: each test reads the action's own shape.
async function json(
  user: TestUser,
  args: string[],
  stdin?: string,
): Promise<any> {
  const out = await as(user, ["--json", ...args], stdin);
  if (out.code !== 0) {
    throw new Error(`hypotenuse ${args.join(" ")}: ${out.stderr}`);
  }
  return JSON.parse(out.stdout);
}

describe("hypotenuse sandbox", () => {
  test("list, narrowed by bot, conversation, and status", async () => {
    const all = await json(stage.u.peach, ["sandbox", "list"]);
    expect(all.sandboxJobs.map((j: { id: number }) => j.id)).toEqual([
      pendingJobId,
      runningJobId,
    ]);
    expect(all.pagination).toMatchObject({ page: 1, total: 2 });
    expect(JSON.stringify(all)).not.toContain("tokenHash");

    const running = await json(stage.u.peach, [
      "sandbox",
      "list",
      "--bot",
      "toadsworth",
      "--conversation",
      String(conversationId),
      "--status",
      "running",
    ]);
    expect(running.sandboxJobs).toHaveLength(1);
    expect(running.sandboxJobs[0]).toMatchObject({
      id: runningJobId,
      bot: { slug: "toadsworth" },
      usage: { inputTokens: 1200, outputTokens: 300, requests: 4 },
    });

    const people = await as(stage.u.peach, ["sandbox", "list"]);
    expect(people.code).toBe(0);
    expect(people.stdout).toContain("Oil the drawbridge chains");
    expect(people.stdout).toContain("running");
    expect(people.stdout).toContain("1500");

    const bad = await as(stage.u.peach, ["sandbox", "list", "--status", "x"]);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("--status takes one of pending");
  });

  test("view prints the job, its question, and how to answer it", async () => {
    const view = await as(stage.u.peach, [
      "sandbox",
      "view",
      String(runningJobId),
    ]);
    expect(view.code).toBe(0);
    expect(view.stdout).toContain(
      `sandbox job ${runningJobId} — Oil the drawbridge chains`,
    );
    expect(view.stdout).toContain("reported      working: reading the winch");
    expect(view.stdout).toContain("1200 in / 300 out over 4 requests");
    expect(view.stdout).toContain(
      `${questionId}. [pending] Which chain grease should I use?`,
    );
    expect(view.stdout).toContain("options: lithium | graphite");
    expect(view.stdout).toContain(
      `hypotenuse sandbox answer ${runningJobId} ${questionId}`,
    );
    expect(view.stdout).toContain("read, answer, and cancel it");

    const answer = await json(stage.u.peach, [
      "sandbox",
      "view",
      String(runningJobId),
    ]);
    expect(answer.canWrite).toBe(true);
    expect(answer.questions).toHaveLength(1);

    const missing = await as(stage.u.peach, ["sandbox", "view", "999999"]);
    expect(missing.code).not.toBe(0);
  });

  test("events prints the transcript, and --after only what is new", async () => {
    const all = await as(stage.u.peach, [
      "sandbox",
      "events",
      String(runningJobId),
    ]);
    expect(all.code).toBe(0);
    const lines = all.stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("tool_use Bash grep -rn winch src");

    const after = await json(stage.u.peach, [
      "sandbox",
      "events",
      String(runningJobId),
      "--after",
      "2",
    ]);
    expect(after.events.map((e: { seq: number }) => e.seq)).toEqual([3]);
    expect(after.events[0].text).toBe("Found it.");

    const empty = await as(stage.u.peach, [
      "sandbox",
      "events",
      String(pendingJobId),
    ]);
    expect(empty.stdout.trim()).toBe("No events yet.");
  });

  test("answer gives the agent an answer once, from an argument or stdin", async () => {
    const answered = await as(
      stage.u.peach,
      ["sandbox", "answer", String(runningJobId), String(questionId), "-"],
      "graphite, sparingly\n",
    );
    expect(answered.code).toBe(0);
    expect(answered.stdout).toContain(
      `Answered question ${questionId} of sandbox job ${runningJobId}`,
    );
    const [row] = await api.db.db
      .select()
      .from(sandboxJobQuestions)
      .where(eq(sandboxJobQuestions.id, questionId));
    expect(row).toMatchObject({ status: "answered" });
    expect(row?.answer?.trim()).toBe("graphite, sparingly");
    expect(row?.answeredBy).toMatchObject({ kind: "user", name: "Peach" });

    const again = await as(stage.u.peach, [
      "sandbox",
      "answer",
      String(runningJobId),
      String(questionId),
      "lithium",
    ]);
    expect(again.code).not.toBe(0);
    expect(again.stderr).toContain("already answered");

    const view = await as(stage.u.peach, [
      "sandbox",
      "view",
      String(runningJobId),
    ]);
    expect(view.stdout).toContain("answer (Peach): graphite, sparingly");
  });

  test("cancel ends a pending job at once and flags a running one", async () => {
    const pending = await as(stage.u.peach, [
      "sandbox",
      "cancel",
      String(pendingJobId),
    ]);
    expect(pending.code).toBe(0);
    expect(pending.stdout).toContain("it had not started");
    const ended = await json(stage.u.peach, [
      "sandbox",
      "list",
      "--status",
      "cancelled",
    ]);
    expect(ended.sandboxJobs.map((j: { id: number }) => j.id)).toEqual([
      pendingJobId,
    ]);

    const running = await json(stage.u.peach, [
      "sandbox",
      "cancel",
      String(runningJobId),
    ]);
    expect(running.sandboxJob).toMatchObject({
      status: "running",
      cancelRequested: true,
      endReason: "person",
    });
    const view = await as(stage.u.peach, [
      "sandbox",
      "view",
      String(runningJobId),
    ]);
    expect(view.stdout).toContain("running (stopping) — person");

    const twice = await as(stage.u.peach, [
      "sandbox",
      "cancel",
      String(pendingJobId),
    ]);
    expect(twice.code).not.toBe(0);
    expect(twice.stderr).toContain("already ended (cancelled)");
  });
});

describe("hypotenuse project settings", () => {
  test("shows the defaults, changes them as an admin, and goes back", async () => {
    const before = await as(stage.u.toad, ["project", "settings"]);
    expect(before.code).toBe(0);
    expect(before.stdout).toContain("(default)");

    const changed = await json(stage.u.peach, [
      "project",
      "settings",
      "--sandbox-provider",
      "docker",
      "--sandbox-image",
      "ghcr.io/castle/agent:1",
      "--sandbox-concurrency",
      "2",
      "--sandbox-max-duration",
      "20m",
    ]);
    expect(changed.settings).toMatchObject({
      sandboxProvider: "docker",
      sandboxConfig: { image: "ghcr.io/castle/agent:1" },
      sandboxConcurrency: 2,
      sandboxMaxDurationMs: 1_200_000,
      effectiveSandbox: {
        provider: "docker",
        image: "ghcr.io/castle/agent:1",
        concurrency: 2,
        maxDurationMs: 1_200_000,
      },
    });
    const shown = await as(stage.u.peach, ["project", "settings"]);
    expect(shown.stdout).toContain("at once       2\n");
    expect(shown.stdout).toContain("longest       20m\n");

    const reset = await json(stage.u.peach, [
      "project",
      "settings",
      "--no-sandbox-image",
      "--no-sandbox-concurrency",
    ]);
    expect(reset.settings).toMatchObject({
      sandboxProvider: "docker",
      sandboxConfig: {},
      sandboxConcurrency: null,
    });

    const unknown = await as(stage.u.peach, [
      "project",
      "settings",
      "--sandbox-provider",
      "mainframe",
    ]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain("is not a sandbox provider");

    const member = await as(stage.u.toad, [
      "project",
      "settings",
      "--sandbox-concurrency",
      "5",
    ]);
    expect(member.code).not.toBe(0);
  });
});

describe("hypotenuse bot edit --sandbox", () => {
  test("sets the policy and the per-job token budget, and view shows them", async () => {
    const edited = await json(stage.u.peach, [
      "bot",
      "edit",
      "toadsworth",
      "--sandbox",
      "allow",
      "--sandbox-token-budget",
      "50000",
    ]);
    expect(edited.bot).toMatchObject({
      sandboxPolicy: "allow",
      sandboxJobTokenBudget: 50_000,
    });
    const view = await as(stage.u.peach, ["bot", "view", "toadsworth"]);
    expect(view.stdout).toContain(
      "sandbox jobs  allow; at most 50000 tokens a job",
    );

    const cleared = await json(stage.u.peach, [
      "bot",
      "edit",
      "toadsworth",
      "--sandbox",
      "approve",
      "--no-sandbox-token-budget",
    ]);
    expect(cleared.bot).toMatchObject({
      sandboxPolicy: "approve",
      sandboxJobTokenBudget: null,
    });

    const bad = await as(stage.u.peach, [
      "bot",
      "edit",
      "toadsworth",
      "--sandbox",
      "sometimes",
    ]);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("--sandbox takes one of off, approve, allow");
  });
});
