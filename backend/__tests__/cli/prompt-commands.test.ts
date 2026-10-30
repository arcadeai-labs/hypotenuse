import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "keryx";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
} from "../agent/harness";
import { cliSignIn, HOOK_TIMEOUT, type TestUser } from "../setup";

/**
 * `hypotenuse prompt …`, `goal …`, `skill …`, and the bot's prompt flags,
 * spawned from source against the booted server and the agent stage (a bot,
 * Toadsworth): every command once, its `--json` answer, what a person reads,
 * and refusals.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");

let stage: AgentStage;
const homes = new Map<string, string>();

/**
 * Give a person a config directory with a signed-in CLI.
 * @param user - Who.
 */
async function signIn(user: TestUser): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "hyp-prompt-"));
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
  for (const user of [stage.u.peach, stage.u.luigi]) await signIn(user);
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

describe("hypotenuse prompt", () => {
  test("list, add, edit, versions, revert, view, preview, remove", async () => {
    const { peach } = stage.u;
    const listed = await json(peach, ["prompt", "list", "--bot", "toadsworth"]);
    expect(listed.promptSections.map((s: { key: string }) => s.key)).toEqual([
      "identity",
      "how-i-work",
      "things-i-have-learned",
    ]);

    const added = await json(
      peach,
      [
        "prompt",
        "add",
        "--bot",
        "toadsworth",
        "--title",
        "Deploys",
        "--contextual",
        "--keyword",
        "deploy",
        "--body",
        "-",
      ],
      "Deploys go through preprod.",
    );
    expect(added.promptSection).toMatchObject({
      key: "deploys",
      loading: "contextual",
      keywords: ["deploy"],
      body: "Deploys go through preprod.",
    });

    const edited = await json(peach, [
      "prompt",
      "edit",
      "deploys",
      "--bot",
      "toadsworth",
      "--body",
      "Deploys go through preprod, then prod.",
      "--base",
      "1",
      "--note",
      "Two stages",
    ]);
    expect(edited.promptSection.currentVersion).toBe(2);
    const stale = await as(peach, [
      "prompt",
      "edit",
      "deploys",
      "--bot",
      "toadsworth",
      "--body",
      "x",
      "--base",
      "1",
    ]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain("changed since version 1");

    const preview = await json(peach, [
      "prompt",
      "preview",
      "--bot",
      "toadsworth",
      "--message",
      "how do we deploy?",
    ]);
    expect(preview.prompt.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(preview.prompt.system).toContain(
      "## Deploys\n\nDeploys go through preprod, then prod.",
    );
    expect(preview.prompt.contextTerms).toContain("deploy");
    const human = await as(peach, [
      "prompt",
      "preview",
      "--bot",
      "toadsworth",
      "--message",
      "hello",
      "--sections",
    ]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("sections  identity@1");
    expect(human.stdout).not.toContain("deploys@");

    const reverted = await json(peach, [
      "prompt",
      "revert",
      "deploys",
      "--bot",
      "toadsworth",
      "--to",
      "1",
    ]);
    expect(reverted.promptSection).toMatchObject({
      currentVersion: 3,
      body: "Deploys go through preprod.",
    });
    const versions = await as(peach, [
      "prompt",
      "versions",
      "deploys",
      "--bot",
      "toadsworth",
    ]);
    expect(versions.stdout).toContain("revert");
    expect(versions.stdout).toContain("Two stages");
    const view = await as(peach, [
      "prompt",
      "view",
      String(added.promptSection.id),
    ]);
    expect(view.stdout).toContain("contextual (deploy)");

    // A project section by key, with no --bot; a viewer cannot add one.
    const denied = await as(stage.u.luigi, [
      "prompt",
      "add",
      "--title",
      "House style",
      "--body",
      "Plain.",
    ]);
    expect(denied.code).toBe(1);
    await json(peach, [
      "prompt",
      "add",
      "--title",
      "House style",
      "--body",
      "Plain.",
    ]);
    expect(
      (await json(peach, ["prompt", "view", "house-style"])).promptSection
        .scope,
    ).toBe("project");

    const unconfirmed = await as(peach, [
      "prompt",
      "remove",
      "deploys",
      "--bot",
      "toadsworth",
    ]);
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.stderr).toContain("--yes");
    await json(peach, [
      "prompt",
      "remove",
      "deploys",
      "--bot",
      "toadsworth",
      "--yes",
    ]);
    const identity = await as(peach, [
      "prompt",
      "remove",
      "identity",
      "--bot",
      "toadsworth",
      "--yes",
    ]);
    expect(identity.code).toBe(1);
    expect(identity.stderr).toContain("cannot be deleted");
  });

  test("bot create and edit take the prompt budget and the agent-section cap", async () => {
    const edited = await json(stage.u.peach, [
      "bot",
      "edit",
      "toadsworth",
      "--prompt-budget",
      "12000",
      "--max-agent-sections",
      "3",
    ]);
    expect(edited.bot).toMatchObject({
      promptBudgetTokens: 12_000,
      maxAgentSections: 3,
    });
    const view = await as(stage.u.peach, ["bot", "view", "toadsworth"]);
    expect(view.stdout).toContain(
      "about 12000 tokens; it may add 3 sections itself",
    );
  });
});

describe("hypotenuse goal", () => {
  test("add, list, view, edit, remove", async () => {
    const { peach } = stage.u;
    const added = await json(peach, [
      "goal",
      "add",
      "--bot",
      "toadsworth",
      "--title",
      "Keep the moat clean",
      "--priority",
      "high",
      "--review-every",
      "7d",
    ]);
    expect(added.goal).toMatchObject({
      priority: "high",
      reviewEverySeconds: 604_800,
      status: "active",
    });
    const id = String(added.goal.id);
    const list = await as(peach, ["goal", "list", "--bot", "toadsworth"]);
    expect(list.stdout).toContain("Keep the moat clean");
    expect(list.stdout).toContain("every 7d");
    const edited = await json(peach, [
      "goal",
      "edit",
      id,
      "--status",
      "achieved",
      "--no-review-every",
    ]);
    expect(edited.goal).toMatchObject({
      status: "achieved",
      reviewEverySeconds: null,
    });
    const bad = await as(peach, ["goal", "edit", id, "--priority", "urgent"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--priority is one of high, medium, low");
    expect((await as(peach, ["goal", "view", id])).stdout).toContain(
      "status    achieved",
    );
    await json(peach, ["goal", "remove", id, "--yes"]);
    expect((await as(peach, ["goal", "view", id])).code).toBe(1);
  });
});

describe("hypotenuse skill", () => {
  test("add, list, view, edit, versions, attach, detach, remove", async () => {
    const { peach } = stage.u;
    const added = await json(peach, [
      "skill",
      "add",
      "release-notes",
      "--description",
      "Write release notes",
      "--arg",
      "since!",
      "--arg",
      "audience=customers",
      "--body",
      "Notes since $since for $audience.",
    ]);
    expect(added.skill.arguments).toEqual([
      { name: "since", required: true },
      { name: "audience", required: false, default: "customers" },
    ]);
    const list = await as(peach, ["skill", "list"]);
    expect(list.stdout).toContain("since!, audience=customers");
    const edited = await json(peach, [
      "skill",
      "edit",
      "release-notes",
      "--body",
      "Short notes since $since.",
      "--note",
      "Shorter",
    ]);
    expect(edited.skill.currentVersion).toBe(2);
    expect(
      (await as(peach, ["skill", "versions", "release-notes"])).stdout,
    ).toContain("Shorter");
    expect(
      (await as(peach, ["skill", "view", "release-notes"])).stdout,
    ).toContain("Short notes since $since.");

    const pinned = await json(peach, [
      "skill",
      "attach",
      "release-notes",
      "--bot",
      "toadsworth",
      "--pin",
      "1",
    ]);
    expect(pinned.botSkill).toMatchObject({ pinnedVersion: 1, version: 1 });
    const attached = await as(peach, ["skill", "list", "--bot", "toadsworth"]);
    expect(attached.stdout).toContain("1 (pinned)");
    const latest = await json(peach, [
      "skill",
      "attach",
      "release-notes",
      "--bot",
      "toadsworth",
    ]);
    expect(latest.botSkill).toMatchObject({ pinnedVersion: null, version: 2 });
    await json(peach, [
      "skill",
      "detach",
      "release-notes",
      "--bot",
      "toadsworth",
    ]);
    expect(
      (await json(peach, ["skill", "list", "--bot", "toadsworth"])).botSkills,
    ).toEqual([]);

    const badArg = await as(peach, [
      "skill",
      "add",
      "x",
      "--description",
      "x",
      "--body",
      "x",
      "--arg",
      "since!=v1",
    ]);
    expect(badArg.code).toBe(1);
    expect(badArg.stderr).toContain("has no default");
    await json(peach, ["skill", "remove", "release-notes", "--yes"]);
    expect(
      (await as(peach, ["skill", "view", "release-notes"])).stderr,
    ).toContain('No skill named "release-notes"');
  });
});
