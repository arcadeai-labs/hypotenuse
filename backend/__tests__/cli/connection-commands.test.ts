import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { api, config } from "keryx";
import { projectConnections } from "../../schema/project_connections";
import { sandboxJobs } from "../../schema/sandbox_jobs";
import { sandboxes } from "../../schema/sandboxes";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  startConversation,
} from "../agent/harness";
import type { FakeVercel } from "../fakes/vercel/server";
import { startFakeVercel } from "../sandbox/vercel-fake";
import { cliSignIn, HOOK_TIMEOUT, type TestUser } from "../setup";

/**
 * `hypotenuse connection list|view|create|edit|test|delete`, `sandbox
 * ledger|destroy`, `project settings --sandbox-runtime|--sandbox-vcpus|
 * --sandbox-egress`, and `bot edit --require-egress-allowlist`, spawned from
 * source against the booted server, whose Vercel is the in-process fake. The
 * fake's probe only lists, so nothing here runs a container.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");
let stage: AgentStage;
let fake: FakeVercel;
let vercelApiUrl: string;
const homes = new Map<string, string>();

/**
 * Give a person a config directory with a signed-in CLI.
 * @param user - Who.
 */
async function signIn(user: TestUser): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "hyp-connection-"));
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
  vercelApiUrl = config.sandbox.vercelApiUrl;
  fake = await startFakeVercel();
  for (const user of [stage.u.peach, stage.u.toad]) await signIn(user);
}, HOOK_TIMEOUT);

afterAll(async () => {
  config.sandbox.vercelApiUrl = vercelApiUrl;
  await fake.stop();
  await clearLoopQueues();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Run the CLI as a person, in the Castle project.
 * @param user - Whose config directory to use.
 * @param args - Arguments after `hypotenuse --project <castle>`.
 * @param options - Standard input, and extra environment variables.
 * @param options.stdin - Written to its standard input.
 * @param options.env - Added to its environment.
 * @returns Exit code and captured output.
 */
async function as(
  user: TestUser,
  args: string[],
  options: { stdin?: string; env?: Record<string, string> } = {},
) {
  const proc = Bun.spawn(
    ["bun", "run", CLI, "--project", String(stage.u.projectId), ...args],
    {
      stdin: options.stdin !== undefined ? new Blob([options.stdin]) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...options.env,
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
 * @param options - Standard input and environment, as for {@link as}.
 * @param options.stdin - Written to its standard input.
 * @param options.env - Added to its environment.
 * @returns The parsed stdout.
 */
// biome-ignore lint/suspicious/noExplicitAny: each test reads the action's own shape.
async function json(
  user: TestUser,
  args: string[],
  options: { stdin?: string; env?: Record<string, string> } = {},
): Promise<any> {
  const out = await as(user, ["--json", ...args], options);
  if (out.code !== 0) {
    throw new Error(`hypotenuse ${args.join(" ")}: ${out.stderr}`);
  }
  return JSON.parse(out.stdout);
}

/** The fake's team and project, as `connection create` flags. */
const accountFlags = () => [
  "--team-id",
  fake.teamId,
  "--vercel-project-id",
  fake.projectId,
];

describe("hypotenuse connection", () => {
  test("create is probed: a wrong token or missing id is refused, a right one saved and never shown", async () => {
    const empty = await as(stage.u.peach, ["connection", "list"]);
    expect(empty.code).toBe(0);
    expect(empty.stdout).toContain("No connections yet.");
    expect(empty.stdout).toContain(
      "kinds: vercel (Vercel: teamId, projectId, and a token)",
    );

    const missing = await as(
      stage.u.peach,
      ["connection", "create", "--team-id", fake.teamId, "--token-stdin"],
      { stdin: fake.token },
    );
    expect(missing.code).not.toBe(0);
    expect(missing.stderr).toContain("--vercel-project-id");

    const wrong = await as(
      stage.u.peach,
      ["connection", "create", ...accountFlags(), "--token-stdin"],
      { stdin: "vcp_not_the_token\n" },
    );
    expect(wrong.code).not.toBe(0);
    expect(wrong.stderr).toContain("Vercel refused the connection");
    expect(wrong.stderr).not.toContain("vcp_not_the_token");

    const noToken = await as(stage.u.peach, [
      "connection",
      "create",
      ...accountFlags(),
    ]);
    expect(noToken.code).not.toBe(0);
    expect(noToken.stderr).toContain("--token-stdin");

    const member = await as(
      stage.u.toad,
      ["connection", "create", ...accountFlags(), "--token-stdin"],
      { stdin: fake.token },
    );
    expect(member.code).not.toBe(0);

    const created = await as(
      stage.u.peach,
      ["connection", "create", ...accountFlags(), "--token-env", "VERCEL_T"],
      { env: { VERCEL_T: fake.token } },
    );
    expect(created.code).toBe(0);
    expect(created.stdout).toContain(`token …${fake.token.slice(-4)}`);
    expect(created.stdout).toContain(
      "hypotenuse project settings --sandbox-provider vercel",
    );

    const listed = await json(stage.u.toad, ["connection", "list"]);
    expect(listed.pagination).toMatchObject({ page: 1, total: 1 });
    expect(listed.connections[0]).toMatchObject({
      kind: "vercel",
      name: "Vercel",
      config: { teamId: fake.teamId, projectId: fake.projectId },
      lastFour: fake.token.slice(-4),
      status: "ok",
    });
    expect(JSON.stringify(listed)).not.toContain(fake.token);

    const view = await as(stage.u.toad, ["connection", "view", "vercel"]);
    expect(view.code).toBe(0);
    expect(view.stdout).toContain(`teamId        ${fake.teamId}`);
    expect(view.stdout).toContain("status        ok");
    expect(view.stdout).not.toContain(fake.token);

    const twice = await as(
      stage.u.peach,
      ["connection", "create", ...accountFlags(), "--token-stdin"],
      { stdin: fake.token },
    );
    expect(twice.code).not.toBe(0);
    expect(twice.stderr).toContain("already has a Vercel connection");
  });

  test("edit renames it; a token that fails its probe is refused and the old one kept", async () => {
    const renamed = await json(stage.u.peach, [
      "connection",
      "edit",
      "vercel",
      "--name",
      "Castle Vercel",
    ]);
    expect(renamed.connection.name).toBe("Castle Vercel");

    const bad = await as(
      stage.u.peach,
      ["connection", "edit", "Castle Vercel", "--token-stdin"],
      { stdin: "vcp_wrong" },
    );
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("Vercel refused the change");

    const badTeam = await as(stage.u.peach, [
      "connection",
      "edit",
      "vercel",
      "--team-id",
      "team_elsewhere",
    ]);
    expect(badTeam.code).not.toBe(0);

    const replaced = await json(
      stage.u.peach,
      ["connection", "edit", "vercel", "--token-stdin"],
      { stdin: `${fake.token}\n` },
    );
    expect(replaced.connection).toMatchObject({
      name: "Castle Vercel",
      config: { teamId: fake.teamId, projectId: fake.projectId },
      lastFour: fake.token.slice(-4),
      status: "ok",
    });

    const nothing = await as(stage.u.peach, ["connection", "edit", "vercel"]);
    expect(nothing.code).not.toBe(0);
    expect(nothing.stderr).toContain("Nothing to change");
  });

  test("test records the probe and exits non-zero when it fails", async () => {
    const ok = await as(stage.u.peach, ["connection", "test", "vercel"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("Castle Vercel: ok — ");

    fake.failNext(403, "token revoked");
    const failed = await as(stage.u.peach, ["connection", "test", "vercel"]);
    expect(failed.code).toBe(1);
    expect(failed.stdout).toContain("Castle Vercel: error");
    const listed = await as(stage.u.peach, ["connection", "list"]);
    expect(listed.stdout).toContain("error:");

    const again = await json(stage.u.peach, ["connection", "test", "vercel"]);
    expect(again.connection.status).toBe("ok");

    const member = await as(stage.u.toad, ["connection", "test", "vercel"]);
    expect(member.code).not.toBe(0);
  });
});

describe("hypotenuse project settings on vercel", () => {
  test("runtime, vCPUs, and egress are set, shown, and checked", async () => {
    const chosen = await json(stage.u.peach, [
      "project",
      "settings",
      "--sandbox-provider",
      "vercel",
      "--sandbox-runtime",
      "node22",
      "--sandbox-vcpus",
      "4",
      "--sandbox-egress",
      "allowlist",
    ]);
    expect(chosen.settings.effectiveSandbox).toMatchObject({
      provider: "vercel",
      runtime: "node22",
      vcpus: 4,
      memoryMiB: 8192,
      egressMode: "allowlist",
      image: null,
    });
    expect(chosen.warnings).toEqual([]);

    const shown = await as(stage.u.toad, ["project", "settings"]);
    expect(shown.code).toBe(0);
    expect(shown.stdout).toContain("provider      vercel\n");
    expect(shown.stdout).toContain("runtime       node22\n");
    expect(shown.stdout).toContain("size          4 vCPUs, 8 GiB memory\n");
    expect(shown.stdout).toContain("egress        allowlist (deny by default)");
    expect(shown.stdout).toContain("vercel (needs a vercel connection");
    expect(shown.stdout).not.toContain("image ");

    const badMode = await as(stage.u.peach, [
      "project",
      "settings",
      "--sandbox-egress",
      "closed",
    ]);
    expect(badMode.code).not.toBe(0);
    expect(badMode.stderr).toContain(
      "--sandbox-egress takes one of open-world, allowlist",
    );

    const tooBig = await as(stage.u.peach, [
      "project",
      "settings",
      "--sandbox-vcpus",
      "9",
    ]);
    expect(tooBig.code).not.toBe(0);
    expect(tooBig.stderr).toContain("sandboxVcpus");

    const inUse = await as(stage.u.peach, [
      "connection",
      "delete",
      "Castle Vercel",
    ]);
    expect(inUse.code).not.toBe(0);
    expect(inUse.stderr).toContain("run on this connection");
  });

  test("a bot that requires an allowlist is warned about on a provider that cannot hold one", async () => {
    const strict = await json(stage.u.peach, [
      "bot",
      "edit",
      "toadsworth",
      "--require-egress-allowlist",
    ]);
    expect(strict.bot.requireEgressAllowlist).toBe(true);
    const view = await as(stage.u.peach, ["bot", "view", "toadsworth"]);
    expect(view.stdout).toContain("only behind an egress allowlist");

    const warned = await as(stage.u.peach, [
      "project",
      "settings",
      "--sandbox-provider",
      "docker",
      "--no-sandbox-egress",
      "--no-sandbox-runtime",
      "--no-sandbox-vcpus",
    ]);
    expect(warned.code).toBe(0);
    expect(warned.stdout).toContain("egress        open-world (default)");
    expect(warned.stdout).toMatch(/warning: .*requires an egress allowlist/);

    const relaxed = await json(stage.u.peach, [
      "bot",
      "edit",
      "toadsworth",
      "--no-require-egress-allowlist",
    ]);
    expect(relaxed.bot.requireEgressAllowlist).toBe(false);
  });
});

describe("hypotenuse sandbox ledger|destroy", () => {
  test("members list the ledger; an admin destroys a leftover, not a running job's sandbox", async () => {
    const conversationId = (
      await startConversation(stage, "Fix the drawbridge")
    ).body.conversation.id;
    const [job] = await api.db.db
      .insert(sandboxJobs)
      .values({
        projectId: stage.u.projectId,
        botId: stage.botId,
        parentConversationId: conversationId,
        maxDurationMs: 1_800_000,
        idleTimeoutMs: 600_000,
        title: "Oil the drawbridge chains",
        task: "Oil them.",
        status: "running",
        provider: "vercel",
        startedAt: new Date(),
      })
      .returning();
    const [held, leftover, gone] = await api.db.db
      .insert(sandboxes)
      .values([
        {
          projectId: stage.u.projectId,
          provider: "vercel",
          jobId: job.id,
          externalId: "sbx_held",
          status: "running",
          resources: {
            vcpus: 4,
            memoryMiB: 8192,
            timeoutMs: 1_800_000,
            image: "node22",
          },
        },
        {
          projectId: stage.u.projectId,
          provider: "vercel",
          externalId: "sbx_leftover",
          status: "running",
          resources: {
            vcpus: 2,
            memoryMiB: 4096,
            timeoutMs: 600_000,
            image: "node24",
          },
        },
        {
          projectId: stage.u.projectId,
          provider: "vercel",
          externalId: "sbx_gone",
          status: "destroyed",
          destroyedAt: new Date(),
        },
      ])
      .returning();

    const all = await json(stage.u.toad, ["sandbox", "ledger"]);
    expect(all.sandboxes.map((s: { id: number }) => s.id)).toEqual([
      gone.id,
      leftover.id,
      held.id,
    ]);
    expect(all.pagination).toMatchObject({ page: 1, total: 3 });
    expect(all.sandboxes[2].job).toMatchObject({
      id: job.id,
      title: "Oil the drawbridge chains",
      status: "running",
    });

    const live = await as(stage.u.toad, ["sandbox", "ledger", "--live"]);
    expect(live.code).toBe(0);
    expect(live.stdout).toContain("sbx_leftover");
    expect(live.stdout).toContain("2 vCPU, 4096 MiB, node24");
    expect(live.stdout).toContain(`${job.id} running Oil the drawbridge`);
    expect(live.stdout).not.toContain("sbx_gone");

    const member = await as(stage.u.toad, [
      "sandbox",
      "destroy",
      String(leftover.id),
    ]);
    expect(member.code).not.toBe(0);

    const refused = await as(stage.u.peach, [
      "sandbox",
      "destroy",
      String(held.id),
    ]);
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("Cancel the job instead");

    const destroyed = await as(stage.u.peach, [
      "sandbox",
      "destroy",
      String(leftover.id),
    ]);
    expect(destroyed.code).toBe(0);
    expect(destroyed.stdout).toContain(
      `Sandbox ${leftover.id} is destroyed (vercel sbx_leftover).`,
    );
    const after = await json(stage.u.toad, ["sandbox", "ledger", "--live"]);
    expect(after.sandboxes.map((s: { id: number }) => s.id)).toEqual([held.id]);

    await api.db.db
      .update(sandboxes)
      .set({ status: "destroyed", destroyedAt: new Date() })
      .where(eq(sandboxes.id, held.id));
    await api.db.db
      .update(sandboxJobs)
      .set({ status: "failed", endedAt: new Date() })
      .where(eq(sandboxJobs.id, job.id));
  });
});

describe("hypotenuse connection delete", () => {
  test("removes a connection the provider no longer runs on", async () => {
    const deleted = await as(stage.u.peach, [
      "connection",
      "delete",
      "Castle Vercel",
    ]);
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toContain("Deleted Castle Vercel");
    const rows = await api.db.db
      .select()
      .from(projectConnections)
      .where(eq(projectConnections.projectId, stage.u.projectId));
    expect(rows).toEqual([]);
    const unknown = await as(stage.u.peach, ["connection", "view", "vercel"]);
    expect(unknown.code).not.toBe(0);
    expect(unknown.stderr).toContain('No connection named "vercel"');
  });
});
