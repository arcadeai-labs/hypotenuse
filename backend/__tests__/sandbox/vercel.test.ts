import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import { api, config } from "keryx";
import {
  buildEgressAllowlist,
  INSTALL_EGRESS_HOSTS,
  planEgress,
  resolveSandboxApiUrl,
  runtimeInstallScript,
} from "../../ops/SandboxProvisionOps";
import { scrubToken } from "../../sandbox/providers/vercel";
import { auditLogs } from "../../schema/audit_logs";
import { projectConnections } from "../../schema/project_connections";
import { sandboxJobs } from "../../schema/sandbox_jobs";
import { sandboxes } from "../../schema/sandboxes";
import {
  type AgentStage,
  clearLoopQueues,
  runTicks,
  startConversation,
} from "../agent/harness";
import type { FakeVercel } from "../fakes/vercel/server";
import { resultsOf } from "../mcp/harness";
import { call, HOOK_TIMEOUT } from "../setup";
import {
  buildSandboxStage,
  buildTestImage,
  conversation,
  dockerAvailable,
  eventually,
  jobRow,
  latestJob,
  runStarts,
} from "./harness";
import { startFakeVercel } from "./vercel-fake";

/**
 * **Vercel as a project's sandbox provider**, against the in-process Vercel
 * fake: connecting an account (probed, sealed, never returned), choosing the
 * provider and its options, the egress decision in every state, a bot that
 * requires an allowlist, the production guard, the ledger's own actions,
 * token scrubbing, and a whole job on Vercel — installed with the install
 * list open, narrowed before its agent starts. Cases that run a container
 * are skipped where no Docker daemon answers.
 *
 * Coverage rows: vercel.probe (connections), vercel.errors.scrubbed (a bad
 * token at save; a failure on a job), vercel.out.network-policy (a job on
 * Vercel).
 */

const describeDocker = dockerAvailable ? describe : describe.skip;
const JOB_TIMEOUT = 120_000;

let stage: AgentStage;
let fake: FakeVercel;
let defaults: typeof config.sandbox;
let base: string;

beforeAll(async () => {
  stage = await buildSandboxStage("allow");
  defaults = { ...config.sandbox };
  base = `/project/${stage.u.projectId}`;
  fake = await startFakeVercel();
  if (dockerAvailable) await buildTestImage();
  config.sandbox.heartbeatMs = 1_000;
}, 300_000);

afterEach(async () => {
  await api.db.db
    .update(sandboxJobs)
    .set({ status: "failed", endedAt: new Date() })
    .where(eq(sandboxJobs.botId, stage.botId));
  await clearLoopQueues();
  await api.resque.queue.delQueue("sandboxes");
  stage.models.reset();
});

afterAll(async () => {
  Object.assign(config.sandbox, defaults);
  await fake.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Call the API as a user.
 * @param method - The verb.
 * @param path - The path under `/api`.
 * @param body - The body.
 * @param user - Who calls; Peach (an owner) by default.
 * @returns The status and body.
 */
function as(
  method: "GET" | "PUT" | "POST" | "DELETE",
  path: string,
  body: Record<string, unknown> = {},
  user = stage.u.peach,
) {
  return call<Record<string, any>>(
    stage.u.url,
    user,
    method,
    path,
    method === "GET" ? undefined : body,
  );
}

/** The fake's account, as a `connection:create` body. */
const account = () => ({
  kind: "vercel",
  config: { teamId: fake.teamId, projectId: fake.projectId },
  token: fake.token,
});

/**
 * Ensure the project has a Vercel connection to the fake.
 * @returns Its id.
 */
async function ensureConnection(): Promise<number> {
  const [row] = await api.db.db
    .select()
    .from(projectConnections)
    .where(eq(projectConnections.projectId, stage.u.projectId));
  if (row) return row.id;
  const created = await as("PUT", `${base}/connection`, account());
  if (created.status !== 200) throw new Error(JSON.stringify(created.body));
  return created.body.connection.id;
}

/**
 * Set the project's sandbox settings.
 * @param fields - The fields.
 * @returns The answer.
 */
async function settings(fields: Record<string, unknown>) {
  return as("POST", `${base}/settings`, fields);
}

describe("connections", () => {
  test("a bad token is refused at save, with no token in the answer", async () => {
    fake.failNext(403, "bad credentials", true);
    const res = await as("PUT", `${base}/connection`, account());
    expect(res.status).toBe(406);
    const text = JSON.stringify(res.body);
    expect(text).toContain("refused the connection");
    expect(text).not.toContain(fake.token);
  });

  test("a field that is not its kind's shape is refused before any probe", async () => {
    const res = await as("PUT", `${base}/connection`, {
      ...account(),
      config: { teamId: "acme", projectId: fake.projectId },
    });
    expect(res.status).toBe(406);
    expect(JSON.stringify(res.body)).toContain("team_");
  });

  test("create probes, seals, and answers only the last four; the audit row holds no token", async () => {
    const res = await as("PUT", `${base}/connection`, account());
    expect(res.status).toBe(200);
    const c = res.body.connection;
    expect(c).toMatchObject({
      kind: "vercel",
      status: "ok",
      lastFour: fake.token.slice(-4),
      config: { teamId: fake.teamId, projectId: fake.projectId },
    });
    expect(JSON.stringify(res.body)).not.toContain(fake.token);
    const [row] = await api.db.db
      .select()
      .from(projectConnections)
      .where(eq(projectConnections.id, c.id));
    expect(JSON.stringify(row.secret)).not.toContain(fake.token);
    const audits = await api.db.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, "connection:create"));
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(fake.token);

    const again = await as("PUT", `${base}/connection`, account());
    expect(again.status).toBe(406);
    expect(JSON.stringify(again.body)).toContain("already has");
  });

  test("members list and view; only admins create, test, edit, or delete", async () => {
    const id = await ensureConnection();
    const listed = await as("GET", `${base}/connections`, {}, stage.u.luigi);
    expect(listed.status).toBe(200);
    expect(listed.body.connections).toHaveLength(1);
    expect(listed.body.pagination).toMatchObject({ page: 1, total: 1 });
    expect(listed.body.kinds.map((k: { kind: string }) => k.kind)).toEqual([
      "vercel",
    ]);
    expect(
      (await as("GET", `${base}/connection/${id}`, {}, stage.u.luigi)).status,
    ).toBe(200);
    for (const [method, path] of [
      ["POST", `${base}/connection/${id}/test`],
      ["POST", `${base}/connection/${id}`],
      ["DELETE", `${base}/connection/${id}`],
    ] as const) {
      expect((await as(method, path, {}, stage.u.luigi)).status).toBe(403);
    }
  });

  test("test records the probe; a failing replacement token is refused and the old one kept", async () => {
    const id = await ensureConnection();
    const tested = await as("POST", `${base}/connection/${id}/test`);
    expect(tested.status).toBe(200);
    expect(tested.body.connection.status).toBe("ok");

    // Not a 5xx: the SDK retries those.
    fake.failNext(403, "down");
    const failed = await as("POST", `${base}/connection/${id}/test`);
    expect(failed.body.connection.status).toBe("error");
    expect(failed.body.connection.lastError).toContain("down");

    const bad = await as("POST", `${base}/connection/${id}`, {
      token: "vcp_not_the_token",
    });
    expect(bad.status).toBe(406);
    const still = await as("POST", `${base}/connection/${id}/test`);
    expect(still.body.connection.status).toBe("ok");
    expect(still.body.connection.lastFour).toBe(fake.token.slice(-4));
  });
});

describe("choosing the provider", () => {
  test("vercel needs the project's connection, probed; its options are checked against it", async () => {
    await api.db.db
      .delete(projectConnections)
      .where(eq(projectConnections.projectId, stage.u.projectId));
    const without = await settings({ sandboxProvider: "vercel" });
    expect(without.status).toBe(406);
    expect(JSON.stringify(without.body)).toContain("add a vercel connection");

    await ensureConnection();
    fake.failNext(401, "token revoked");
    const broken = await settings({ sandboxProvider: "vercel" });
    expect(broken.status).toBe(406);
    expect(JSON.stringify(broken.body)).toContain("does not work");

    const chosen = await settings({
      sandboxProvider: "vercel",
      sandboxRuntime: "node22",
      sandboxVcpus: 4,
      sandboxEgressMode: "allowlist",
    });
    expect(chosen.status).toBe(200);
    expect(chosen.body.settings.effectiveSandbox).toMatchObject({
      provider: "vercel",
      runtime: "node22",
      vcpus: 4,
      memoryMiB: 8192,
      egressMode: "allowlist",
      image: null,
    });
    for (const [fields, key] of [
      [{ sandboxRuntime: "node12" }, "sandboxRuntime"],
      [{ sandboxVcpus: 9 }, "sandboxVcpus"],
      [{ sandboxImage: "hypotenuse/sandbox:dev" }, "sandboxImage"],
    ] as const) {
      const refused = await settings(fields);
      expect(refused.status).toBe(406);
      expect(JSON.stringify(refused.body)).toContain(key);
    }

    const view = await as("GET", `${base}/settings`, {}, stage.u.luigi);
    expect(view.body.defaultProvider).toBe(config.sandbox.defaultProvider);
    expect(
      view.body.providers.map((p: { kind: string }) => p.kind).sort(),
    ).toEqual(["docker", "vercel"]);

    // A connection the provider runs on cannot be removed.
    const id = await ensureConnection();
    const removed = await as("DELETE", `${base}/connection/${id}`);
    expect(removed.status).toBe(406);
    expect(JSON.stringify(removed.body)).toContain("run on this connection");
  });

  test("allowlist mode is refused on a provider that cannot hold one; bots that require one are warned about", async () => {
    await settings({ sandboxProvider: "docker", sandboxEgressMode: null });
    const refused = await settings({ sandboxEgressMode: "allowlist" });
    expect(refused.status).toBe(406);
    expect(JSON.stringify(refused.body)).toContain("cannot enforce");

    await as("POST", `${base}/bot/${stage.botId}`, {
      requireEgressAllowlist: true,
    });
    const warned = await settings({ sandboxConcurrency: 2 });
    expect(warned.status).toBe(200);
    expect(warned.body.warnings.join(" ")).toContain(
      "requires an egress allowlist",
    );
    await as("POST", `${base}/bot/${stage.botId}`, {
      requireEgressAllowlist: false,
    });
  });

  test("the production guard: docker refused, vercel accepted", async () => {
    await ensureConnection();
    const was = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect((await settings({ sandboxProvider: "docker" })).status).toBe(406);
      const ok = await settings({ sandboxProvider: "vercel" });
      expect(ok.status).toBe(200);
      const view = await as("GET", `${base}/settings`);
      const docker = view.body.providers.find(
        (p: { kind: string }) => p.kind === "docker",
      );
      expect(docker.allowedHere).toBe(false);
    } finally {
      process.env.NODE_ENV = was;
    }
    await settings({ sandboxProvider: "docker", sandboxEgressMode: null });
  });
});

describe("a bot that requires an egress allowlist", () => {
  test("turning it on is any writer's; turning it off takes admin standing", async () => {
    const on = await as(
      "POST",
      `${base}/bot/${stage.botId}`,
      { requireEgressAllowlist: true },
      stage.u.mario,
    );
    expect(on.status).toBe(200);
    expect(on.body.bot.requireEgressAllowlist).toBe(true);
    const off = await as(
      "POST",
      `${base}/bot/${stage.botId}`,
      { requireEgressAllowlist: false },
      stage.u.mario,
    );
    expect(off.status).toBe(403);
    const admin = await as("POST", `${base}/bot/${stage.botId}`, {
      requireEgressAllowlist: false,
    });
    expect(admin.status).toBe(200);
  });

  test("on docker, sandbox_start refuses with a sentence the bot can relay", async () => {
    await settings({ sandboxProvider: "docker", sandboxEgressMode: null });
    await as("POST", `${base}/bot/${stage.botId}`, {
      requireEgressAllowlist: true,
    });
    try {
      stage.models.play([
        {
          toolCalls: [
            {
              name: "sandbox_start",
              input: { title: "Run the tests", task: "Run the tests." },
            },
          ],
        },
        {
          toolCalls: [
            { name: "reply_and_wait", input: { text: "It cannot run here." } },
          ],
        },
      ]);
      const res = await startConversation(stage, "Please run the tests.", {
        channelType: "web",
      });
      const conversationId = res.body.conversation.id;
      await runTicks();
      const [refused] = await resultsOf(conversationId, "sandbox_start");
      expect(refused).toMatchObject({
        is_error: true,
        error_type: "sandbox_unavailable",
      });
      expect(JSON.stringify(refused)).toContain(
        "only run sandbox jobs behind an egress allowlist",
      );
      expect(await latestJob(conversationId)).toBeUndefined();
    } finally {
      await as("POST", `${base}/bot/${stage.botId}`, {
        requireEgressAllowlist: false,
      });
    }
  });
});

describe("the egress decision", () => {
  const github = {
    webUrl: "https://github.com",
    apiUrl: "https://api.github.com",
  };
  const input = {
    providerLabel: "P",
    botName: "Toadsworth",
    apiUrl: "https://api.hypotenuse.cloud",
    github,
  };

  test("every row of the table", () => {
    const run = {
      mode: "deny-all" as const,
      allowDomains: ["api.hypotenuse.cloud", "github.com", "api.github.com"],
    };
    // wanted, cannot narrow → refuse (the bot's reason, then the mode's)
    expect(
      planEgress({
        ...input,
        canNarrow: false,
        egressMode: "open-world",
        botRequires: true,
        hasRepository: false,
      }),
    ).toMatchObject({
      kind: "refuse",
      reason: expect.stringContaining("Toadsworth"),
    });
    expect(
      planEgress({
        ...input,
        canNarrow: false,
        egressMode: "allowlist",
        botRequires: false,
        hasRepository: true,
      }),
    ).toMatchObject({
      kind: "refuse",
      reason: expect.stringContaining('"allowlist"'),
    });
    // wanted, can narrow → install list at create, run list after
    const wanted = planEgress({
      ...input,
      canNarrow: true,
      egressMode: "allowlist",
      botRequires: false,
      hasRepository: true,
    });
    expect(wanted).toEqual({
      kind: "narrow",
      create: {
        mode: "deny-all",
        allowDomains: [...run.allowDomains, ...INSTALL_EGRESS_HOSTS].filter(
          (h, i, all) => all.indexOf(h) === i,
        ),
      },
      run,
    });
    // not wanted, can narrow, repository → provider default, then run list
    expect(
      planEgress({
        ...input,
        canNarrow: true,
        egressMode: "open-world",
        botRequires: false,
        hasRepository: true,
      }),
    ).toEqual({ kind: "narrow", create: null, run });
    // not wanted, no repository, or cannot narrow → leave
    for (const [canNarrow, hasRepository] of [
      [true, false],
      [false, true],
      [false, false],
    ] as const) {
      expect(
        planEgress({
          ...input,
          canNarrow,
          egressMode: "open-world",
          botRequires: false,
          hasRepository,
        }),
      ).toEqual({ kind: "leave" });
    }
  });

  test("the install list is the run list plus the registries; a job without a repository runs on our host alone", () => {
    const lists = buildEgressAllowlist(
      "https://api.hypotenuse.cloud",
      false,
      github,
    );
    expect(lists.run).toEqual(["api.hypotenuse.cloud"]);
    expect(lists.install).toEqual([
      "api.hypotenuse.cloud",
      ...INSTALL_EGRESS_HOSTS,
    ]);
  });

  test("the runtime install skips what is there, and installs the GitHub CLI only for a repository job", () => {
    const plain = runtimeInstallScript({ githubCli: false });
    expect(plain).toContain("command -v bun");
    expect(plain).toContain("command -v claude");
    expect(plain).not.toContain("gh-real");
    expect(runtimeInstallScript({ githubCli: true })).toContain(
      "/usr/local/lib/hypotenuse/gh-real",
    );
  });

  test("the GitHub CLI version matches the one Dockerfile.dev bakes", async () => {
    const dockerfile = await Bun.file(
      `${import.meta.dir}/../../sandbox/images/Dockerfile.dev`,
    ).text();
    const baked = dockerfile.match(/ARG GH_VERSION=(\S+)/)?.[1];
    expect(runtimeInstallScript({ githubCli: true })).toContain(`v=${baked}`);
  });

  test("scrubToken removes the plaintext and any bearer credential", () => {
    expect(
      scrubToken(
        "failed: vcp_secret123 (Bearer vcp_secret123)",
        "vcp_secret123",
      ),
    ).toBe("failed: [redacted] (Bearer [redacted])");
  });
});

describeDocker("a job on Vercel", () => {
  /**
   * Start a conversation whose first step starts a job and parks on it.
   * @param task - The job's task.
   * @returns The conversation and job ids.
   */
  async function startJob(task: string) {
    stage.models.play([
      {
        toolCalls: [
          { name: "sandbox_start", input: { title: "Run the tests", task } },
        ],
      },
      { toolCalls: [{ name: "sandbox_wait", input: {} }] },
    ]);
    const res = await startConversation(stage, "Please run the tests.", {
      channelType: "web",
    });
    const conversationId = res.body.conversation.id;
    const job = await eventually("a job", async () => {
      await runTicks();
      return latestJob(conversationId);
    });
    return { conversationId, jobId: job.id };
  }

  test(
    "created on docker, started on vercel: installed with the install list open, narrowed before the supervisor, run to the end, sandbox deleted",
    async () => {
      await settings({ sandboxProvider: "docker", sandboxEgressMode: null });
      await ensureConnection();
      const { conversationId, jobId } = await startJob(
        [
          "Do the work described below.",
          `STUB ${JSON.stringify({ op: "status", state: "testing", message: "Running" })}`,
          `STUB ${JSON.stringify({ op: "result", text: "Ran on Vercel." })}`,
        ].join("\n"),
      );
      expect((await jobRow(jobId)).provider).toBe("docker");
      // The admin switches providers before the job starts.
      const switched = await settings({
        sandboxProvider: "vercel",
        sandboxVcpus: 1,
        sandboxRuntime: "node24",
        sandboxEgressMode: "allowlist",
      });
      expect(switched.status).toBe(200);
      expect(await runStarts()).toEqual(["sandbox-job:start"]);
      stage.models.play([
        {
          toolCalls: [
            { name: "reply_and_wait", input: { text: "Ran on Vercel." } },
          ],
        },
      ]);
      const job = await eventually(
        "the job to end",
        async () => {
          const j = await jobRow(jobId);
          return j.endedAt ? j : null;
        },
        JOB_TIMEOUT,
      );
      expect(job.error).toBeNull();
      expect(job.status).toBe("succeeded");
      expect(job.provider).toBe("vercel");
      expect(job.closingText).toBe("Ran on Vercel.");

      const [ledger] = await api.db.db
        .select()
        .from(sandboxes)
        .where(eq(sandboxes.jobId, jobId));
      expect(ledger.provider).toBe("vercel");
      expect(ledger.resources).toMatchObject({
        vcpus: 1,
        memoryMiB: 2048,
        image: "node24",
      });
      expect(ledger.labels).toMatchObject({
        project: String(stage.u.projectId),
        job: String(jobId),
      });
      const sandbox = fake.sandbox(ledger.externalId ?? "");
      expect(sandbox.tags.managed).toBe(config.sandbox.managedTag);
      expect(fake.deleted.has(sandbox.name)).toBe(true);

      // Created on the install list, narrowed to the run list.
      const host = new URL(resolveSandboxApiUrl("vercel")).hostname;
      expect(sandbox.policies).toEqual([
        { allow: [host, ...INSTALL_EGRESS_HOSTS] },
        { allow: [host] },
      ]);
      const install = sandbox.commandLog.find((c) =>
        c.args.join(" ").includes("command -v claude"),
      );
      const supervisor = sandbox.commandLog.find((c) => c.command === "bun");
      expect(install?.policy).toEqual({
        allow: [host, ...INSTALL_EGRESS_HOSTS],
      });
      expect(supervisor?.policy).toEqual({ allow: [host] });

      await eventually("the parent to settle", async () => {
        await runTicks();
        return (await conversation(conversationId)).state === "hibernating";
      });
      await settings({ sandboxProvider: "docker", sandboxEgressMode: null });
    },
    JOB_TIMEOUT + 30_000,
  );

  test(
    "a provider failure that echoes the token is recorded without it",
    async () => {
      await ensureConnection();
      await settings({ sandboxProvider: "docker", sandboxEgressMode: null });
      const { jobId } = await startJob("Run the tests.");
      await settings({ sandboxProvider: "vercel" });
      fake.failNext(401, "bad token", true);
      expect(await runStarts()).toEqual(["sandbox-job:start"]);
      const job = await jobRow(jobId);
      expect(job.status).toBe("failed");
      expect(job.error).toContain("Vercel sandbox create failed");
      expect(job.error).toContain("Settings → Sandboxes");
      expect(job.error).not.toContain(fake.token);
      const [ledger] = await api.db.db
        .select()
        .from(sandboxes)
        .where(eq(sandboxes.jobId, jobId));
      expect(ledger.status).toBe("failed");
      expect(ledger.error).not.toContain(fake.token);
      await settings({ sandboxProvider: "docker" });
    },
    JOB_TIMEOUT,
  );

  test(
    "the ledger: members list it; an admin destroys a leftover, not a running job's",
    async () => {
      await ensureConnection();
      await settings({ sandboxProvider: "vercel" });
      // A leftover: ledgered, its job long over.
      const provider = (await import("../../ops/SandboxCredentialOps"))
        .providerForProject;
      const instance = await provider(api.db.db, stage.u.projectId, "vercel");
      const created = await instance.create({
        timeoutMs: 600_000,
        image: "node24",
        labels: { project: String(stage.u.projectId) },
      });
      const [row] = await api.db.db
        .insert(sandboxes)
        .values({
          projectId: stage.u.projectId,
          provider: "vercel",
          externalId: created.id,
          status: "running",
          resources: {
            vcpus: 2,
            memoryMiB: 4096,
            timeoutMs: 600_000,
            image: "node24",
          },
        })
        .returning();
      const listed = await as(
        "GET",
        `${base}/sandboxes?live=true`,
        {},
        stage.u.luigi,
      );
      expect(listed.status).toBe(200);
      expect(listed.body.sandboxes.map((s: { id: number }) => s.id)).toContain(
        row.id,
      );
      expect(listed.body.pagination.page).toBe(1);
      expect(
        listed.body.sandboxes.find((s: { id: number }) => s.id === row.id)
          .destroyable,
      ).toBe(true);
      expect(
        (await as("DELETE", `${base}/sandbox/${row.id}`, {}, stage.u.luigi))
          .status,
      ).toBe(403);
      const destroyed = await as("DELETE", `${base}/sandbox/${row.id}`);
      expect(destroyed.status).toBe(200);
      expect(destroyed.body.sandbox.status).toBe("destroyed");
      expect(fake.deleted.has(created.id)).toBe(true);

      // A running job's sandbox is the job's to end.
      const [job] = await api.db.db
        .update(sandboxJobs)
        .set({ status: "running", endedAt: null })
        .where(eq(sandboxJobs.botId, stage.botId))
        .returning();
      if (job) {
        const [held] = await api.db.db
          .insert(sandboxes)
          .values({
            projectId: stage.u.projectId,
            provider: "vercel",
            jobId: job.id,
            externalId: "sbx_held",
            status: "running",
          })
          .returning();
        const refused = await as("DELETE", `${base}/sandbox/${held.id}`);
        expect(refused.status).toBe(406);
        expect(JSON.stringify(refused.body)).toContain("Cancel the job");
        await api.db.db
          .update(sandboxes)
          .set({ status: "destroyed", destroyedAt: new Date() })
          .where(and(eq(sandboxes.id, held.id)));
      }
      await settings({ sandboxProvider: "docker" });
    },
    JOB_TIMEOUT,
  );
});
