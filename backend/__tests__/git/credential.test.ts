import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { api } from "keryx";
import {
  GITHUB_CLI_PATH_PROFILE_MARK,
  gitCredentialHelperScript,
  gitCredentialUrl,
  githubCliWrapperScript,
  gitSandboxConfigCommands,
  persistGithubCliPathScript,
} from "../../ops/GitAccessOps";
import { finalizeSandboxJob } from "../../ops/SandboxJobOps";
import {
  JOB_TOKEN_ENV,
  renderBriefing,
  sandboxEgressHosts,
} from "../../ops/SandboxProvisionOps";
import { sandboxJobGitTokens } from "../../schema/sandbox_job_git_tokens";
import { sandboxJobs } from "../../schema/sandbox_jobs";
import { type AgentStage, startConversation } from "../agent/harness";
import { tryGit } from "../fakes/github/server";
import { asJob, buildSandboxStage, mintJob } from "../sandbox/harness";
import { call, HOOK_TIMEOUT } from "../setup";
import {
  buildGitStage,
  type GitStage,
  repositoryColumn,
  stageGitHome,
} from "./repo-harness";

/**
 * **`sandbox:git-credential`, and the in-sandbox scripts that call it.** A
 * job token trades for a GitHub App installation token scoped to one granted
 * repository, at `write` only for the repository a write-mode job was
 * started on with a push grant; a job reuses its own token and never
 * another's; finishing a job revokes exactly its tokens; every handout and
 * refusal is a ledger row holding only a hash. Then the helper and the
 * managed `gh`, against the live endpoint and the GitHub fake — whose git
 * smart HTTP enforces a token's repository and permission as GitHub does.
 */

type Credential = {
  credential: {
    username: string;
    password: string;
    expiresAtMs: number;
    repository: string;
    permission: "read" | "write";
  };
  error?: { message: string };
};

let stage: AgentStage;
let git: GitStage;

beforeAll(async () => {
  stage = await buildSandboxStage("allow");
  git = await buildGitStage(stage);
}, HOOK_TIMEOUT);

afterAll(async () => {
  await git.restore();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * A running job on a repository.
 * @param name - The repository on `acme`; `null` for none.
 * @param mode - What it was started to do.
 * @returns The job and its token.
 */
async function job(name: string | null = "api", mode?: "read" | "write") {
  const res = await startConversation(stage, "Fix it", { channelType: "web" });
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return mintJob(stage, res.body.conversation.id, {
    repository: name ? repositoryColumn(name, mode) : null,
  });
}

/**
 * Ask the endpoint for a credential, as the helper does.
 * @param token - The job token.
 * @param repository - What git sent as `path`.
 * @returns The status and body.
 */
function ask(token: string, repository: string) {
  return asJob<Credential>(
    stage.u.url,
    "GET",
    "/sandbox/git-credential",
    token,
    { repository },
  );
}

/**
 * The URL git reaches a repository on the fake at.
 * @param name - The repository on `acme`.
 * @returns The URL.
 */
const repoUrl = (name: string) => `${git.github.url}/acme/${name}.git`;

/**
 * A URL with a token in it, for proving what a token can do without a helper.
 * @param name - The repository on `acme`.
 * @param token - The token.
 * @returns The URL.
 */
const withToken = (name: string, token: string) =>
  repoUrl(name).replace("http://", `http://x-access-token:${token}@`);

describe("the endpoint", () => {
  test("a granted repository on a write job is a write token for that one repository", async () => {
    const { token } = await job("api");
    const res = await ask(token, "acme/api.git");
    expect(res.status).toBe(200);
    expect(res.body.credential).toMatchObject({
      username: "x-access-token",
      repository: "acme/api",
      permission: "write",
    });
    expect(res.body.credential.password).toMatch(/^ghs_/);
    expect(res.body.credential.expiresAtMs).toBeGreaterThan(Date.now());
    const minted = git.github.tokens.find(
      (t) => t.token === res.body.credential.password,
    );
    expect(minted?.repositories).toEqual(["api"]);
    expect(minted?.permissions.contents).toBe("write");
    expect(minted?.permissions.administration).toBeUndefined();
    // The token reaches acme/api and nothing else on the installation.
    const tmp = mkdtempSync(join(tmpdir(), "hypotenuse-scope-"));
    expect(
      (
        await tryGit(
          ["ls-remote", withToken("api", res.body.credential.password)],
          tmp,
        )
      ).code,
    ).toBe(0);
    const other = await tryGit(
      ["ls-remote", withToken("other", res.body.credential.password)],
      tmp,
    );
    expect(other.code).not.toBe(0);
    expect(other.stderr).toContain("403");
  });

  test("a job reuses its own token for one repository", async () => {
    const { job: j, token } = await job("api");
    const first = await ask(token, "acme/api");
    const second = await ask(token, "/acme/api.git");
    expect(second.body.credential.password).toBe(
      first.body.credential.password,
    );
    const rows = await api.db.db
      .select()
      .from(sandboxJobGitTokens)
      .where(eq(sandboxJobGitTokens.jobId, j.id))
      .orderBy(sandboxJobGitTokens.id);
    expect(rows.map((r) => r.outcome)).toEqual(["issued", "reused"]);
  });

  test("two jobs on one repository hold independent tokens; finishing one revokes only its own", async () => {
    const a = await job("api");
    const b = await job("api");
    const tokenA = (await ask(a.token, "acme/api")).body.credential.password;
    const tokenB = (await ask(b.token, "acme/api")).body.credential.password;
    expect(tokenA).not.toBe(tokenB);

    await finalizeSandboxJob(a.job.id, { status: "succeeded", reason: "test" });
    expect(git.github.revocations).toContain(tokenA);
    expect(git.github.revocations).not.toContain(tokenB);

    const tmp = mkdtempSync(join(tmpdir(), "hypotenuse-two-jobs-"));
    expect(
      (await tryGit(["clone", "--quiet", withToken("api", tokenB), "b"], tmp))
        .code,
    ).toBe(0);
    const revoked = await tryGit(
      ["clone", "--quiet", withToken("api", tokenA), "a"],
      tmp,
    );
    expect(revoked.code).not.toBe(0);

    const [row] = await api.db.db
      .select()
      .from(sandboxJobGitTokens)
      .where(eq(sandboxJobGitTokens.jobId, a.job.id));
    expect(row.revokedAt).not.toBeNull();
  });

  test("a repository whose grant does not name this bot is refused with a sentence, before GitHub is asked", async () => {
    const { token } = await job("api");
    const mints = git.github.tokens.length;
    const res = await ask(token, "acme/secret");
    expect(res.status).toBe(403);
    expect(res.body.error?.message).toContain(
      "this bot has no access to acme/secret",
    );
    expect(res.body.error?.message).toContain("under Repositories");
    expect(git.github.tokens.length).toBe(mints);
  });

  test("a read grant is a read token, even on a write job started on it", async () => {
    const { token } = await job("lib", "write");
    const res = await ask(token, "acme/lib");
    expect(res.body.credential.permission).toBe("read");
    const minted = git.github.tokens.find(
      (t) => t.token === res.body.credential.password,
    );
    expect(minted?.permissions.contents).toBe("read");
  });

  test("a write job reads another granted repository, and only reads it", async () => {
    const { token } = await job("api", "write");
    const res = await ask(token, "acme/other");
    expect(res.status).toBe(200);
    expect(res.body.credential.permission).toBe("read");
  });

  test("a read job's own repository is read, though its grant allows a push", async () => {
    const { token } = await job("api", "read");
    expect((await ask(token, "acme/api")).body.credential.permission).toBe(
      "read",
    );
  });

  test("anything that is not owner/repo is a 406", async () => {
    const { token } = await job("api");
    for (const bad of ["acme", "acme/api/extra", "../api", "acme/.."]) {
      expect((await ask(token, bad)).status).toBe(406);
    }
  });

  test("a person's session is 403, and no token is 401", async () => {
    const asPerson = await call(
      stage.u.url,
      stage.u.peach,
      "GET",
      "/sandbox/git-credential?repository=acme/api",
    );
    expect(asPerson.status).toBe(403);
    const none = await fetch(
      `${stage.u.url}/api/sandbox/git-credential?repository=acme/api`,
    );
    expect(none.status).toBe(401);
  });

  test("an ended job's token is refused", async () => {
    const { job: j, token } = await job("api");
    await finalizeSandboxJob(j.id, { status: "failed", reason: "test" });
    expect((await ask(token, "acme/api")).status).toBe(401);
  });

  test("every handout and refusal is a ledger row the job page lists, and no row holds a token", async () => {
    const { job: j, token } = await job("api");
    const issued = (await ask(token, "acme/api")).body.credential.password;
    await ask(token, "acme/api");
    await ask(token, "acme/secret");
    const view = await call<{
      gitHandouts: {
        repository: string;
        outcome: string;
        permission: string | null;
        reason: string | null;
      }[];
    }>(
      stage.u.url,
      stage.u.peach,
      "GET",
      `/project/${stage.u.projectId}/sandbox-job/${j.id}`,
    );
    expect(view.status).toBe(200);
    expect(view.body.gitHandouts).toMatchObject([
      { repository: "acme/api", outcome: "issued", permission: "write" },
      { repository: "acme/api", outcome: "reused", permission: "write" },
      { repository: "acme/secret", outcome: "refused" },
    ]);
    expect(view.body.gitHandouts[2].reason).toContain("no access");
    expect(JSON.stringify(view.body)).not.toContain("ghs_");

    const rows = await api.db.db.select().from(sandboxJobGitTokens);
    expect(JSON.stringify(rows)).not.toContain("ghs_");
    const mine = rows.find((r) => r.jobId === j.id && r.outcome === "issued");
    expect(mine?.tokenHash).toBe(
      createHash("sha256").update(issued).digest("hex"),
    );
    const jobs = await api.db.db.select().from(sandboxJobs);
    expect(JSON.stringify(jobs)).not.toContain("ghs_");
  });
});

/**
 * Run a command and collect everything it said.
 * @param argv - The command.
 * @param options - Where, with what environment and stdin.
 * @param options.cwd - The working directory.
 * @param options.env - The environment.
 * @param options.stdin - What to write to its stdin.
 * @returns The exit code and both streams.
 */
async function run(
  argv: string[],
  options: { cwd: string; env: Record<string, string>; stdin?: string },
) {
  const proc = Bun.spawn(argv, {
    cwd: options.cwd,
    env: options.env,
    stdin:
      options.stdin === undefined
        ? "ignore"
        : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("the credential helper, against the live endpoint", () => {
  /**
   * git, as a sandbox runs it: the staged HOME and the job token.
   * @param home - The HOME.
   * @param token - The job token.
   * @returns The environment.
   */
  const gitEnv = (home: string, token: string) => ({
    ...(process.env as Record<string, string>),
    HOME: home,
    [JOB_TOKEN_ENV]: token,
    GIT_TERMINAL_PROMPT: "0",
  });

  test("a write grant clones and pushes a branch; the fake has it", async () => {
    const { token } = await job("api");
    const { home } = await stageGitHome(stage.u.url, git.github.url);
    const env = gitEnv(home, token);
    const clone = await run(
      ["git", "clone", "--quiet", repoUrl("api"), "api"],
      {
        cwd: home,
        env,
      },
    );
    expect(clone.code, clone.stderr).toBe(0);
    const dir = join(home, "api");
    const branch = `hypotenuse/${git.botSlug}/readme`;
    for (const argv of [
      ["git", "checkout", "--quiet", "-b", branch],
      ["sh", "-c", "echo more >> README.md"],
      ["git", "commit", "--quiet", "-am", "More readme"],
      ["git", "push", "--quiet", "-u", "origin", branch],
    ]) {
      const out = await run(argv, { cwd: dir, env });
      expect(out.code, `${argv.join(" ")}: ${out.stderr}`).toBe(0);
    }
    const local = (await run(["git", "rev-parse", "HEAD"], { cwd: dir, env }))
      .stdout;
    expect(await git.github.gitIn("acme", "api", ["rev-parse", branch])).toBe(
      local.trim(),
    );
    // Nothing git was handed is left on disk.
    const config = readFileSync(join(home, ".gitconfig"), "utf8");
    expect(config).not.toContain("ghs_");
    expect(existsSync(join(home, ".git-credentials"))).toBe(false);
  });

  test("a read grant clones, and GitHub refuses its push with a 403", async () => {
    const { token } = await job("lib", "read");
    const { home } = await stageGitHome(stage.u.url, git.github.url);
    const env = gitEnv(home, token);
    expect(
      (
        await run(["git", "clone", "--quiet", repoUrl("lib"), "lib"], {
          cwd: home,
          env,
        })
      ).code,
    ).toBe(0);
    const dir = join(home, "lib");
    await run(["git", "checkout", "--quiet", "-b", "x"], { cwd: dir, env });
    await run(["git", "commit", "--quiet", "--allow-empty", "-m", "x"], {
      cwd: dir,
      env,
    });
    const push = await run(["git", "push", "origin", "x"], { cwd: dir, env });
    expect(push.code).not.toBe(0);
    expect(push.stderr).toContain("403");
  });

  test("an ungranted repository does not clone, and git's stderr carries why", async () => {
    const { token } = await job("api");
    const { home } = await stageGitHome(stage.u.url, git.github.url);
    const clone = await run(
      ["git", "clone", "--quiet", repoUrl("secret"), "secret"],
      { cwd: home, env: gitEnv(home, token) },
    );
    expect(clone.code).not.toBe(0);
    expect(clone.stderr).toContain("this bot has no access to acme/secret");
  });

  test("a helper that is not executable answers nothing", async () => {
    const { token } = await job("api");
    const { home, helperPath } = await stageGitHome(
      stage.u.url,
      git.github.url,
    );
    chmodSync(helperPath, 0o644);
    const fill = await run(["git", "credential", "fill"], {
      cwd: home,
      env: gitEnv(home, token),
      stdin: `protocol=http\nhost=${new URL(git.github.url).host}\npath=acme/api.git\n\n`,
    });
    expect(fill.code).not.toBe(0);
    expect(fill.stdout).not.toContain("password=");
    chmodSync(helperPath, 0o755);
    const again = await run(["git", "credential", "fill"], {
      cwd: home,
      env: gitEnv(home, token),
      stdin: `protocol=http\nhost=${new URL(git.github.url).host}\npath=acme/api.git\n\n`,
    });
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toMatch(/password=ghs_/);
  });

  test.each([
    ["compact", (body: unknown) => JSON.stringify(body)],
    ["pretty-printed", (body: unknown) => JSON.stringify(body, null, 2)],
  ] as const)("reads a %s answer", async (_label, render) => {
    const asked: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        asked.push(
          `${request.headers.get("authorization")} ${url.searchParams.get("repository")}`,
        );
        return new Response(
          render({
            credential: {
              username: "x-access-token",
              password: "ghs_from_the_endpoint",
              expiresAtMs: Date.now() + 3_600_000,
              repository: "acme/widget",
              permission: "write",
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    try {
      const home = mkdtempSync(join(tmpdir(), "hypotenuse-git-canned-"));
      const helperPath = join(home, "git-credential-hypotenuse");
      await Bun.write(
        helperPath,
        gitCredentialHelperScript(
          gitCredentialUrl(`http://127.0.0.1:${server.port}`),
          JOB_TOKEN_ENV,
        ),
      );
      chmodSync(helperPath, 0o755);
      const env = gitEnv(home, "hyp_job_canned");
      for (const argv of gitSandboxConfigCommands(helperPath)) {
        expect((await run(argv, { cwd: home, env })).code).toBe(0);
      }
      const filled = await run(["git", "credential", "fill"], {
        cwd: home,
        env,
        stdin: "protocol=https\nhost=github.com\npath=acme/widget.git\n\n",
      });
      expect(filled.code, filled.stderr).toBe(0);
      expect(filled.stdout).toContain("username=x-access-token");
      expect(filled.stdout).toContain("password=ghs_from_the_endpoint");
      expect(asked).toEqual(["Bearer hyp_job_canned acme/widget.git"]);
    } finally {
      server.stop(true);
    }
  });
});

describe("the managed gh, against the live endpoint", () => {
  /**
   * Stage the wrapper beside a stand-in `gh-real` that says whether it got
   * a token and which arguments.
   * @returns The directory and the wrapper's path.
   */
  async function stageGh(): Promise<{ dir: string; wrapper: string }> {
    const dir = mkdtempSync(join(tmpdir(), "hypotenuse-gh-"));
    const real = join(dir, "gh-real");
    await Bun.write(
      real,
      '#!/bin/sh\ncase "$GH_TOKEN" in ghs_*) t=set ;; *) t=unset ;; esac\nprintf \'token=%s host=%s args=%s\\n\' "$t" "$GH_HOST" "$*"\n',
    );
    chmodSync(real, 0o755);
    const wrapper = join(dir, "gh");
    await Bun.write(
      wrapper,
      githubCliWrapperScript(
        gitCredentialUrl(stage.u.url),
        JOB_TOKEN_ENV,
        real,
        git.github.url,
      ),
    );
    chmodSync(wrapper, 0o755);
    return { dir, wrapper };
  }

  test("an explicit --repo gets that repository's token, handed only to gh", async () => {
    const { job: j, token } = await job("api");
    const { dir, wrapper } = await stageGh();
    const out = await run([wrapper, "pr", "create", "--repo", "acme/api"], {
      cwd: dir,
      env: {
        ...(process.env as Record<string, string>),
        [JOB_TOKEN_ENV]: token,
        GH_TOKEN: "user-supplied",
      },
    });
    expect(out.code, out.stderr).toBe(0);
    expect(out.stdout).toContain(
      `token=set host=${new URL(git.github.url).host} args=pr create --repo acme/api`,
    );
    const [row] = await api.db.db
      .select()
      .from(sandboxJobGitTokens)
      .where(eq(sandboxJobGitTokens.jobId, j.id));
    expect(row).toMatchObject({ repository: "acme/api", permission: "write" });
    const script = await Bun.file(wrapper).text();
    expect(script).toContain(`$${JOB_TOKEN_ENV}`);
    expect(script).not.toContain(token);
  });

  test("inside a checkout it infers origin; outside one it refuses to guess; an ungranted --repo is refused", async () => {
    const { token } = await job("api");
    const { dir, wrapper } = await stageGh();
    const env = {
      ...(process.env as Record<string, string>),
      [JOB_TOKEN_ENV]: token,
    };
    const checkout = join(dir, "api");
    await run(["git", "init", "--quiet", checkout], { cwd: dir, env });
    await run(["git", "remote", "add", "origin", repoUrl("api")], {
      cwd: checkout,
      env,
    });
    const inferred = await run([wrapper, "pr", "list"], { cwd: checkout, env });
    expect(inferred.code, inferred.stderr).toBe(0);
    expect(inferred.stdout).toContain("token=set");

    const outside = await run([wrapper, "pr", "list"], { cwd: dir, env });
    expect(outside.code).toBe(2);
    expect(outside.stderr).toContain("could not determine a GitHub repository");

    const ungranted = await run([wrapper, "pr", "list", "-R", "acme/secret"], {
      cwd: dir,
      env,
    });
    expect(ungranted.code).toBe(1);
    expect(ungranted.stderr).toContain("this bot has no access to acme/secret");
    expect(ungranted.stdout).not.toContain("token=");
  });
});

describe("the managed gh on PATH", () => {
  test("a login shell (sh -lc) finds the wrapper after the persist script runs, and a second run changes nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "hypotenuse-gh-path-"));
    const wrapperDir = join(home, "wrapper");
    const stockDir = join(home, "stock");
    mkdirSync(wrapperDir);
    mkdirSync(stockDir);
    await Bun.write(join(wrapperDir, "gh"), "#!/bin/sh\nprintf WRAPPER\\n");
    await Bun.write(join(stockDir, "gh"), "#!/bin/sh\nprintf STOCK\\n");
    chmodSync(join(wrapperDir, "gh"), 0o755);
    chmodSync(join(stockDir, "gh"), 0o755);
    const script = persistGithubCliPathScript(wrapperDir, {
      profileDDir: join(home, "no-profile.d"),
      localBinDir: join(home, "no-local-bin"),
    });
    const env = { HOME: home, PATH: `${stockDir}:/usr/bin:/bin` };
    const first = await run(["sh", "-c", script], { cwd: home, env });
    expect(first.code, first.stderr).toBe(0);
    const profile = readFileSync(join(home, ".profile"), "utf8");
    expect(profile).toContain(GITHUB_CLI_PATH_PROFILE_MARK);
    expect(existsSync(join(home, ".bash_profile"))).toBe(false);
    await run(["sh", "-c", script], { cwd: home, env });
    expect(readFileSync(join(home, ".profile"), "utf8")).toBe(profile);

    const login = await run(["sh", "-lc", "command -v gh; gh"], {
      cwd: home,
      env: { ...env, SHELL: "/bin/sh" },
    });
    expect(login.code, login.stderr).toBe(0);
    expect(login.stdout).toContain(join(wrapperDir, "gh"));
    expect(login.stdout).toContain("WRAPPER");
    expect(login.stdout).not.toContain("STOCK");
  });
});

describe("provisioning's pure parts", () => {
  test("egress: our host always; GitHub's two hosts only for a repository job", () => {
    const github = {
      webUrl: "https://github.com",
      apiUrl: "https://api.github.com",
    };
    expect(
      sandboxEgressHosts("https://api.hypotenuse.cloud", false, github),
    ).toEqual(["api.hypotenuse.cloud"]);
    expect(
      sandboxEgressHosts("https://api.hypotenuse.cloud:8443/", true, github),
    ).toEqual(["api.hypotenuse.cloud", "github.com", "api.github.com"]);
    expect(
      sandboxEgressHosts("http://127.0.0.1:1", true, {
        webUrl: "http://127.0.0.1:2",
        apiUrl: "http://127.0.0.1:2",
      }),
    ).toEqual(["127.0.0.1"]);
  });

  test("the briefing names the repository, the mode, the branch prefix, and how to report a pull request", () => {
    const ctx = {
      botName: "Toadsworth",
      platform: "slack",
      channel: "#eng",
      requester: "Peach",
      servers: [],
    };
    const repository = {
      fullName: "acme/api",
      dir: "/work/api",
      ref: null,
      mode: "write" as const,
      branchPrefix: "hypotenuse/toadsworth/",
      identity: "Toadsworth (Hypotenuse) <toadsworth@users.noreply.hypotenuse>",
      coAuthor: "Peach <peach@example.com>",
      webOrigin: "https://github.com",
    };
    const job = { title: "Fix it", task: "Fix the flaky test." };
    const write = renderBriefing(job, { ...ctx, repository });
    expect(write).toContain("`acme/api` is cloned at `/work/api`");
    expect(write).toContain("Your working directory is `/work/api`");
    expect(write).toContain("`hypotenuse/toadsworth/`");
    expect(write).toContain("gh pr create --repo acme/api");
    expect(write).toContain("`pull_request`");
    expect(write).toContain("Co-authored-by: Peach <peach@example.com>");
    expect(write).not.toMatch(/\{\{\w+\}\}/);
    expect(write).not.toMatch(/\n{3,}/);

    const read = renderBriefing(job, {
      ...ctx,
      repository: { ...repository, mode: "read", coAuthor: null },
    });
    expect(read).toContain("read-only");
    expect(read).not.toContain("gh pr create");
    expect(read).not.toContain("Co-authored-by");

    const none = renderBriefing(job, ctx);
    expect(none).not.toContain("## The repository");
    expect(none).toContain("Your working directory is `/work`");
    expect(none).not.toMatch(/\n{3,}/);
  });
});
