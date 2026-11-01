import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, config } from "keryx";
import { FakeGitHub } from "../fakes/github/server";
import { attachInstallation, useFakeGitHub } from "../git/repositories-harness";
import {
  buildTestUniverse,
  call,
  cliSignIn,
  HOOK_TIMEOUT,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * `hypotenuse repo install|installations|detach|grants|grant|grant-edit|
 * revoke|view`, `bot repos`, and `bot edit --github-wake`, spawned from
 * source against the booted server, whose GitHub is the in-process fake.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");
const github = new FakeGitHub();
const homes = new Map<string, string>();
let u: TestUniverse;
let restore: () => void;
let installationId: number;

/**
 * Give a person a config directory with a signed-in CLI.
 * @param user - Who.
 */
async function signIn(user: TestUser): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "hyp-repo-"));
  const { token, cliTokenId } = await cliSignIn(
    u.url,
    user,
    `${user.name}-cli`,
  );
  mkdirSync(join(home, "hypotenuse"), { recursive: true, mode: 0o700 });
  writeFileSync(
    join(home, "hypotenuse", "credentials.json"),
    JSON.stringify({
      version: 1,
      current: u.url,
      servers: {
        [u.url]: {
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

/**
 * Run the CLI as a person, in the Castle project.
 * @param user - Whose config directory to use.
 * @param args - Arguments after `hypotenuse --project <castle>`.
 * @returns Exit code and captured output.
 */
async function as(user: TestUser, args: string[]) {
  const proc = Bun.spawn(
    ["bun", "run", CLI, "--project", String(u.projectId), ...args],
    {
      stdin: "ignore",
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
 * @returns The parsed stdout.
 */
// biome-ignore lint/suspicious/noExplicitAny: each test reads the action's own shape.
async function json(user: TestUser, args: string[]): Promise<any> {
  const out = await as(user, ["--json", ...args]);
  if (out.code !== 0) {
    throw new Error(`hypotenuse ${args.join(" ")}: ${out.stderr}`);
  }
  return JSON.parse(out.stdout);
}

beforeAll(async () => {
  u = await buildTestUniverse();
  await github.start();
  restore = useFakeGitHub(github);
  github.install({ id: "7001", login: "acme", repositories: ["api", "web"] });
  for (const user of [u.peach, u.toad]) await signIn(user);
  const bot = await call(u.url, u.peach, "PUT", `/project/${u.projectId}/bot`, {
    name: "Toadsworth",
    persona: "You keep the castle.",
  });
  if (bot.status !== 200) throw new Error(JSON.stringify(bot.body));
}, HOOK_TIMEOUT);

afterAll(async () => {
  restore();
  await github.stop();
  await api.stop();
}, HOOK_TIMEOUT);

describe("hypotenuse repo", () => {
  test("install prints the App's install link, or what the deployment lacks", async () => {
    const out = await as(u.peach, ["repo", "install"]);
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toStartWith(
      `${github.url}/apps/${github.appSlug}/installations/new?state=`,
    );
    expect(out.stderr).toContain("ten minutes");

    const saved = { ...config.github };
    Object.assign(config.github, { appSlug: "" });
    try {
      const missing = await as(u.peach, ["repo", "install"]);
      expect(missing.code).not.toBe(0);
      expect(missing.stderr).toContain("GITHUB_APP_SLUG");
    } finally {
      Object.assign(config.github, saved);
    }

    const toad = await as(u.toad, ["repo", "install"]);
    expect(toad.code).not.toBe(0);
    expect(toad.stderr).toContain("admin");
  });

  test("installations lists what is attached", async () => {
    installationId = await attachInstallation(
      u.url,
      github,
      u.peach,
      u.projectId,
      "7001",
    );
    const list = await json(u.toad, ["repo", "installations"]);
    expect(list.installations).toHaveLength(1);
    expect(list.installations[0]).toMatchObject({
      id: installationId,
      accountLogin: "acme",
      status: "active",
    });
    const people = await as(u.toad, ["repo", "installations"]);
    expect(people.stdout).toContain("acme (Organization)");
    expect(people.stdout).toContain("active");
  });

  test("grant, grants, view, grant-edit, revoke, and bot repos", async () => {
    const granted = await as(u.peach, [
      "repo",
      "grant",
      "acme/api",
      "--installation",
      String(installationId),
      "--push",
      "--bot",
      "toadsworth",
    ]);
    expect(granted.code).toBe(0);
    expect(granted.stdout).toContain("Granted acme/api (read and push)");
    expect(granted.stderr).toContain("no branch prefix");

    const web = await json(u.peach, [
      "repo",
      "grant",
      "acme/web",
      "--installation",
      String(installationId),
    ]);
    expect(web.repositoryGrant).toMatchObject({
      fullName: "acme/web",
      push: false,
      allBots: true,
    });
    expect(web.warnings).toEqual([]);

    const unseen = await as(u.peach, [
      "repo",
      "grant",
      "acme/vault",
      "--installation",
      String(installationId),
    ]);
    expect(unseen.code).not.toBe(0);
    expect(unseen.stderr).toContain("Add the repository");

    const grants = await json(u.toad, ["repo", "grants"]);
    expect(
      grants.repositoryGrants.map((g: { fullName: string }) => g.fullName),
    ).toEqual(["acme/api", "acme/web"]);
    const apiId = grants.repositoryGrants[0].id as number;

    const edited = await as(u.peach, [
      "repo",
      "grant-edit",
      String(apiId),
      "--branch-prefix",
      "hypotenuse/toadsworth/",
    ]);
    expect(edited.code).toBe(0);
    expect(edited.stdout).toContain("branch prefix hypotenuse/toadsworth/");
    expect(edited.stdout).toContain("refs/heads/hypotenuse/toadsworth/**");
    expect(edited.stderr).not.toContain("no branch prefix");

    const nothing = await as(u.peach, ["repo", "grant-edit", String(apiId)]);
    expect(nothing.code).not.toBe(0);
    expect(nothing.stderr).toContain("Nothing to change");

    const view = await as(u.toad, ["repo", "view", String(apiId)]);
    expect(view.stdout).toContain("read and push");

    const repos = await as(u.toad, ["bot", "repos", "toadsworth"]);
    expect(repos.code).toBe(0);
    expect(repos.stdout).toContain("acme/api");
    expect(repos.stdout).toContain("push");
    expect(repos.stdout).toContain("acme/web");

    const denied = await as(u.toad, ["repo", "revoke", String(apiId), "--yes"]);
    expect(denied.code).not.toBe(0);
    const unconfirmed = await as(u.peach, ["repo", "revoke", String(apiId)]);
    expect(unconfirmed.code).not.toBe(0);
    expect(unconfirmed.stderr).toContain("--yes");
    const revoked = await as(u.peach, [
      "repo",
      "revoke",
      String(apiId),
      "--yes",
    ]);
    expect(revoked.stdout).toContain("Revoked the grant for acme/api");
    const after = await json(u.toad, ["bot", "repos", "toadsworth"]);
    expect(
      after.repositories.map((r: { fullName: string }) => r.fullName),
    ).toEqual(["acme/web"]);
  });

  test("detach takes its grants with it", async () => {
    const out = await as(u.peach, [
      "repo",
      "detach",
      String(installationId),
      "--yes",
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(
      "Detached acme; removed the grants for acme/web",
    );
    expect((await json(u.toad, ["repo", "grants"])).repositoryGrants).toEqual(
      [],
    );
  });
});

describe("hypotenuse bot edit --github-wake", () => {
  test("sets which pull-request events wake the bot, and view shows them", async () => {
    const edited = await json(u.peach, [
      "bot",
      "edit",
      "toadsworth",
      "--github-wake",
      "check_failed,merged",
    ]);
    expect(edited.bot.githubWakeEvents).toEqual(["check_failed", "merged"]);
    const view = await as(u.peach, ["bot", "view", "toadsworth"]);
    expect(view.stdout).toContain("PR wakes it   check_failed, merged");

    const none = await json(u.peach, [
      "bot",
      "edit",
      "toadsworth",
      "--github-wake",
      "none",
    ]);
    expect(none.bot.githubWakeEvents).toEqual([]);

    const bad = await as(u.peach, [
      "bot",
      "edit",
      "toadsworth",
      "--github-wake",
      "pushed",
    ]);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("--github-wake takes");
  });
});
