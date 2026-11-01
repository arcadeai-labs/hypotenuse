import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import { sandboxJobPullRequests } from "../../schema/sandbox_job_pull_requests";
import { triggerEvents } from "../../schema/trigger_events";
import { type AgentStage, drainQueue } from "../agent/harness";
import { SlackFake } from "../fakes/slack/server";
import { buildGitStage, type GitStage } from "../git/repo-harness";
import {
  buildSandboxStage,
  buildTestImage,
  conversation,
  destroyManagedContainers,
  dockerAvailable,
  eventually,
  jobRow,
  latestJob,
  runStarts,
  TEST_IMAGE,
} from "../sandbox/harness";
import { HOOK_TIMEOUT } from "../setup";
import { conversationForThread, installSlack } from "../slack/harness";

/**
 * **A pull request from a Slack thread, end to end.** A person mentions the
 * bot in a Slack thread (the Slack fake) asking for a one-line README change
 * in `acme/api`; the scripted model starts a sandbox job on the repository
 * and waits on it. A real container from the test image clones through the
 * credential helper, commits, pushes a branch under the bot's prefix to the
 * GitHub fake, and opens the pull request over GitHub's REST API with a
 * token the helper handed it for that one command — what `gh pr create`
 * does — then submits its URL as the `pull_request` artifact. The link lands
 * in the Slack thread; the job's ending wakes the bot, which says so in the
 * thread. A review requesting changes, signed and delivered by the GitHub
 * fake to `webhooks:github`, wakes the conversation again, and the bot
 * answers in the thread. Skipped where no Docker daemon answers.
 */

const describeDocker = dockerAvailable ? describe : describe.skip;
if (!dockerAvailable) {
  console.warn(
    "\n⚠  Skipping __tests__/e2e/pr-from-slack.test.ts — no Docker daemon answers here.\n",
  );
}

/** A whole job through a container is seconds, not milliseconds. */
const JOB_TIMEOUT = 120_000;
const CHANNEL = "C0GENERAL";

let stage: AgentStage;
let git: GitStage;
let slack: SlackFake;
let saved: { slackApiUrl: string; sandbox: typeof config.sandbox };

/**
 * Build the test image; when the registry cannot be reached (Docker Hub's
 * pull limit) and the image is already here, run against the one here.
 */
async function ensureTestImage(): Promise<void> {
  try {
    await buildTestImage();
  } catch (e) {
    const probe = Bun.spawn(["docker", "image", "inspect", TEST_IMAGE], {
      stdout: "ignore",
      stderr: "ignore",
    });
    if ((await probe.exited) !== 0) throw e;
    console.warn(
      `\n⚠  Could not rebuild ${TEST_IMAGE}; using the image already here.\n`,
    );
  }
}

beforeAll(async () => {
  if (!dockerAvailable) return;
  await ensureTestImage();
  stage = await buildSandboxStage("allow");
  git = await buildGitStage(stage);
  git.github.webhookUrl = `${stage.u.url}${config.server.web.apiRoute}/webhooks/github`;
  saved = {
    slackApiUrl: config.platforms.slack.apiUrl,
    sandbox: { ...config.sandbox },
  };
  config.sandbox.heartbeatMs = 1_000;
  slack = new SlackFake().start();
  config.platforms.slack.apiUrl = `${slack.url}/api`;
  await installSlack(stage, slack);
}, JOB_TIMEOUT);

afterAll(async () => {
  if (!dockerAvailable || !stage) return;
  config.platforms.slack.apiUrl = saved.slackApiUrl;
  Object.assign(config.sandbox, saved.sandbox);
  await destroyManagedContainers();
  await slack.stop();
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

/** Process deliveries, run ticks, and deliver the outbox until nothing is left. */
async function pump(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const ran = [
      ...(await drainQueue("ingress")),
      ...(await drainQueue("agents", { only: "agent:tick" })),
      ...(await drainQueue("outbox")),
    ];
    if (ran.length === 0) return;
  }
}

/** The bot's messages in a thread, as text. */
function botTexts(threadTs: string): string[] {
  return slack.botMessages(CHANNEL, threadTs).map((m) => m.text);
}

describeDocker("a pull request from a Slack thread", () => {
  test(
    "the job pushes and opens a PR, its link lands in the thread, and a review requesting changes wakes the bot there",
    async () => {
      const branch = `hypotenuse/${git.botSlug}/readme-line`;
      // The fake numbers pull requests per repository; this is acme/api's first.
      const prUrl = `${git.github.url}/acme/api/pull/1`;
      const openPr = [
        `TOKEN=$(printf 'url=%s\\n\\n' "$(git remote get-url origin)" | GIT_TERMINAL_PROMPT=0 git credential fill | sed -n 's/^password=//p')`,
        `curl -sf -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"title":"Add a line to the README","head":"${branch}","base":"main","body":"One line, as asked in Slack."}' '${git.github.url}/repos/acme/api/pulls' | sed -n 's/.*"html_url":"\\([^"]*\\/pull\\/[0-9]*\\)".*/\\1/p'`,
      ].join(" && ");
      const task = scenario(
        {
          op: "sh",
          command: `git checkout -q -b ${branch} && echo 'Run bun test before you push.' >> README.md && git commit -qam 'Add a line to the README' && git push -q -u origin ${branch}`,
        },
        { op: "sh", command: openPr },
        { op: "artifact", name: "pull_request", content: prUrl },
        { op: "sleep", ms: 2_000 },
        { op: "result", text: `Opened ${prUrl}.` },
      );

      // A person asks in Slack; the bot starts a job on the repository and waits.
      stage.models.play([
        {
          toolCalls: [
            {
              name: "sandbox_start",
              input: {
                title: "Add a line to the README",
                task,
                repository: "acme/api",
              },
            },
          ],
          expect: { lastMessageIncludes: "README" },
        },
        { toolCalls: [{ name: "sandbox_wait", input: {} }] },
      ]);
      const said = await slack.say({
        channel: CHANNEL,
        text: "Please add a line to the README in acme/api saying to run bun test before pushing.",
        mention: true,
      });
      await pump();
      const convo = await conversationForThread(said.ts);
      expect(convo).toBeDefined();
      const job = await eventually(
        "sandbox_start to write a job",
        async () => {
          await pump();
          return latestJob(convo.id);
        },
        10_000,
      );
      expect(job.repository).toMatchObject({ owner: "acme", name: "api" });
      expect((await conversation(convo.id)).waitingOn).toMatchObject({
        kind: "sandbox",
        sandboxJobId: job.id,
      });

      // A real container clones, pushes, and opens the pull request.
      expect(await runStarts()).toEqual(["sandbox-job:start"]);
      const running = await jobRow(job.id);
      expect(running.status, running.error ?? "").toBe("running");
      const recorded = await eventually(
        "the pull request to be recorded",
        async () => {
          const [row] = await api.db.db
            .select()
            .from(sandboxJobPullRequests)
            .where(eq(sandboxJobPullRequests.jobId, job.id));
          return row;
        },
        JOB_TIMEOUT,
      );
      expect(recorded).toMatchObject({
        conversationId: convo.id,
        owner: "acme",
        name: "api",
        number: 1,
        url: prUrl,
        title: "Add a line to the README",
        headRef: branch,
      });
      const [pr] = git.github.pulls;
      expect(pr).toMatchObject({ number: 1, head: branch, base: "main" });
      expect(
        await git.github.gitIn("acme", "api", ["show", `${branch}:README.md`]),
      ).toContain("Run bun test before you push.");

      // The link lands in the thread.
      await drainQueue("outbox");
      expect(botTexts(said.ts)).toContain(
        `<${prUrl}|Pull Request: Add a line to the README>`,
      );

      // The job ends; the bot is woken and says so in the thread.
      stage.models.play([
        {
          toolCalls: [
            {
              name: "reply_and_wait",
              input: { text: "I opened a pull request for the README line." },
            },
          ],
          expect: { lastMessageIncludes: "Pull requests it opened" },
        },
      ]);
      const done = await eventually(
        "the job to end",
        async () => {
          const row = await jobRow(job.id);
          return row.endedAt ? row : null;
        },
        JOB_TIMEOUT,
      );
      expect(done.status, done.error ?? "").toBe("succeeded");
      await eventually(
        "the bot to rest",
        async () => {
          await pump();
          return (await conversation(convo.id)).state === "hibernating";
        },
        10_000,
      );
      expect(botTexts(said.ts)).toContain(
        "I opened a pull request for the README line.",
      );

      // A reviewer requests changes; GitHub tells the App; the bot wakes.
      const delivered = await git.github.review(
        pr,
        "changes_requested",
        "Please say why: CI rejects unformatted code.",
      );
      expect(delivered.status).toBe(200);
      stage.models.play([
        {
          toolCalls: [
            {
              name: "reply_and_wait",
              input: {
                text: "The reviewer asked for a reason; I'll update the pull request.",
              },
            },
          ],
          expect: { lastMessageIncludes: "requested changes" },
        },
      ]);
      await drainQueue("ingress");
      // Deliver the wake's status before the tick's answer supersedes it.
      await drainQueue("outbox");
      const [event] = await api.db.db
        .select()
        .from(triggerEvents)
        .where(eq(triggerEvents.externalEventId, delivered.deliveryId));
      expect(event).toMatchObject({
        type: "github",
        status: "processed",
        outcome: "changes_requested",
      });
      expect((await conversation(convo.id)).state).toBe("working");
      await pump();
      expect((await conversation(convo.id)).state).toBe("hibernating");
      expect(botTexts(said.ts)).toContain(
        "The reviewer asked for a reason; I'll update the pull request.",
      );
      expect(slack.statuses).toContainEqual(
        expect.objectContaining({
          threadTs: said.ts,
          status: "Changes requested on Add a line to the README",
        }),
      );
      expect(stage.models.expectationFailures).toEqual([]);
      expect(slack.requests.filter((r) => !r.valid)).toEqual([]);
    },
    JOB_TIMEOUT * 3,
  );
});
