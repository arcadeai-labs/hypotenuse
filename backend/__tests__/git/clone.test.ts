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
import { sandboxJobGitTokens } from "../../schema/sandbox_job_git_tokens";
import {
  type AgentStage,
  clearLoopQueues,
  runTicks,
  startConversation,
} from "../agent/harness";
import {
  buildSandboxStage,
  buildTestImage,
  conversation,
  destroyManagedContainers,
  dockerAvailable,
  eventually,
  jobRow,
  latestJob,
  liveLedger,
  runStarts,
} from "../sandbox/harness";
import { HOOK_TIMEOUT } from "../setup";
import { buildGitStage, type GitStage } from "./repo-harness";

/**
 * **A repository job in a real container**: provisioning writes the
 * credential helper and the managed `gh`, configures git, and clones a
 * granted repository through the helper; the stub CLI, working in the
 * checkout, commits and pushes a branch under the bot's prefix; the fake's
 * bare repository has it; the agent's environment holds no GitHub token
 * between commands; and the job's ending revokes every token it was handed.
 * A clone GitHub refuses fails the job with git's words. Skipped where no
 * Docker daemon answers.
 */

const describeDocker = dockerAvailable ? describe : describe.skip;
if (!dockerAvailable) {
  console.warn(
    "\n⚠  Skipping __tests__/git/clone.test.ts — no Docker daemon answers here.\n",
  );
}

/** A whole job through a container is seconds, not milliseconds. */
const JOB_TIMEOUT = 120_000;

let stage: AgentStage;
let git: GitStage;
let sandboxDefaults: typeof config.sandbox;

beforeAll(async () => {
  if (!dockerAvailable) return;
  await buildTestImage();
  stage = await buildSandboxStage("allow");
  git = await buildGitStage(stage);
  sandboxDefaults = { ...config.sandbox };
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
  await git.restore();
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
 * Start a conversation whose bot starts a job on a repository, and claim it
 * (provisioning is left to the caller).
 * @param task - The job's task.
 * @param repository - `owner/name`.
 * @returns The job's and the conversation's ids.
 */
async function startJob(
  task: string,
  repository: string,
): Promise<{ jobId: number; conversationId: number }> {
  stage.models.play([
    {
      toolCalls: [
        {
          name: "sandbox_start",
          input: { title: "Fix the readme", task, repository },
        },
      ],
    },
    { toolCalls: [{ name: "sandbox_wait", input: {} }] },
  ]);
  const res = await startConversation(stage, "Fix the readme.", {
    channelType: "web",
  });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  const job = await eventually(
    "sandbox_start to write a job",
    async () => {
      await runTicks();
      return latestJob(res.body.conversation.id);
    },
    10_000,
  );
  return { jobId: job.id, conversationId: res.body.conversation.id };
}

/**
 * Run a woken conversation's tick to rest, so its scripted step is not
 * answered by the next test's.
 * @param conversationId - The conversation.
 */
async function settle(conversationId: number): Promise<void> {
  await eventually(
    `conversation ${conversationId} to rest`,
    async () => {
      await runTicks();
      return (await conversation(conversationId)).state === "hibernating";
    },
    10_000,
  );
}

/**
 * Wait for a job to end.
 * @param jobId - The job.
 * @returns The ended job.
 */
function ended(jobId: number) {
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

describeDocker("a job on a repository", () => {
  test(
    "clones through the helper, pushes a branch under its prefix, holds no GitHub token between commands, and is revoked at the end",
    async () => {
      const branch = `hypotenuse/${git.botSlug}/readme`;
      const mintedBefore = git.github.tokens.length;
      const { jobId, conversationId } = await startJob(
        scenario(
          { op: "sh", command: "pwd; git remote get-url origin" },
          {
            op: "sh",
            command: "printf 'ghs in env: %s\\n' $(env | grep -c ghs_)",
          },
          { op: "sh", command: "command -v gh" },
          {
            op: "sh",
            command: `git checkout -q -b ${branch} && echo fixed >> README.md && git commit -qam 'Fix the readme' && git push -q -u origin ${branch} && git log -1 --format='%an <%ae>'`,
          },
          {
            op: "sh",
            command: "printf 'ghs in env: %s\\n' $(env | grep -c ghs_)",
          },
          { op: "sleep", ms: 4_000 },
          { op: "result", text: "Pushed the fix." },
        ),
        "acme/api",
      );
      expect(await runStarts()).toEqual(["sandbox-job:start"]);
      const running = await jobRow(jobId);
      expect(running.status, running.error ?? "").toBe("running");
      expect(running.briefing).toContain("`acme/api` is cloned at `/work/api`");
      expect(running.briefing).toContain(`\`hypotenuse/${git.botSlug}/\``);

      // From outside, while the job runs: the container's environment and
      // the files provisioning wrote hold no GitHub token.
      const [ledger] = await liveLedger(jobId);
      const containerId = ledger?.externalId ?? "";
      await eventually(
        "the push",
        async () =>
          (
            await git.github
              .gitIn("acme", "api", ["rev-parse", "--verify", branch])
              .catch(() => "")
          ).length > 0,
        JOB_TIMEOUT,
      );
      expect(await dockerExec(containerId, "env")).not.toContain("ghs_");
      expect(
        await dockerExec(
          containerId,
          "cat ~/.gitconfig /work/.hypotenuse/bin/* 2>/dev/null; ls -a ~",
        ),
      ).not.toContain("ghs_");
      expect(
        await dockerExec(containerId, "ls -l /work/.hypotenuse/bin"),
      ).toContain("-rwxr-xr-x");

      // The job's ending wakes the bot, which replies and rests.
      stage.models.play([
        { toolCalls: [{ name: "reply_and_wait", input: { text: "Done." } }] },
      ]);
      const done = await ended(jobId);
      expect(done.status, done.error ?? "").toBe("succeeded");
      await settle(conversationId);

      const said = (
        await api.db.db
          .select()
          .from(sandboxJobEvents)
          .where(eq(sandboxJobEvents.jobId, jobId))
      )
        .map((e) => e.text ?? "")
        .join("\n");
      expect(said).toContain("/work/api");
      expect(said).toContain(`${git.github.url}/acme/api.git`);
      expect(said).toContain("/work/.hypotenuse/bin/gh");
      // Commits are authored as the bot.
      expect(said).toMatch(
        new RegExp(
          `\\(Hypotenuse\\) <${git.botSlug}@users\\.noreply\\.hypotenuse>`,
        ),
      );
      expect(said.match(/ghs in env: (\d+)/g)).toEqual([
        "ghs in env: 0",
        "ghs in env: 0",
      ]);

      // The fake has the branch, with the commit the agent made.
      expect(
        await git.github.gitIn("acme", "api", [
          "log",
          "-1",
          "--format=%s",
          branch,
        ]),
      ).toBe("Fix the readme");

      // Every token this job was handed was revoked when it ended.
      const minted = git.github.tokens.slice(mintedBefore);
      expect(minted.length).toBeGreaterThan(0);
      for (const t of minted) {
        expect(git.github.revocations).toContain(t.token);
      }
      const handouts = await api.db.db
        .select()
        .from(sandboxJobGitTokens)
        .where(eq(sandboxJobGitTokens.jobId, jobId));
      expect(handouts.some((h) => h.outcome === "issued")).toBe(true);
      for (const h of handouts.filter((h) => h.outcome === "issued")) {
        expect(h.revokedAt).not.toBeNull();
      }
    },
    JOB_TIMEOUT * 2,
  );

  test(
    "a clone GitHub refuses fails the job with git's words, and no token",
    async () => {
      const { jobId } = await startJob(
        scenario({ op: "result", text: "Never runs." }),
        "acme/other",
      );
      // GitHub no longer lets the installation reach acme/other: the mint
      // is refused, so the helper answers nothing and git says why.
      git.github.install({
        id: "7001",
        login: "acme",
        repositories: ["api", "lib", "secret"],
      });
      try {
        expect(await runStarts()).toEqual(["sandbox-job:start"]);
      } finally {
        git.github.install({
          id: "7001",
          login: "acme",
          repositories: ["api", "other", "lib", "secret"],
        });
      }
      const failed = await jobRow(jobId);
      expect(failed.status).toBe("failed");
      expect(failed.error).toContain("cloning acme/other failed");
      expect(failed.error).toContain("hypotenuse: no git credential");
      expect(failed.error).not.toContain("ghs_");
      expect(await liveLedger(jobId)).toEqual([]);
    },
    JOB_TIMEOUT,
  );
});
