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
 * `hypotenuse schedule …`, spawned from source against the booted server and
 * the agent stage (a bot, Toadsworth): every command once, its `--json`
 * answer, what a person reads, and refusals.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");

let stage: AgentStage;
const homes = new Map<string, string>();

/**
 * Give a person a config directory with a signed-in CLI.
 * @param user - Who.
 */
async function signIn(user: TestUser): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "hyp-schedule-"));
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

describe("hypotenuse schedule", () => {
  test("add, list, view, edit, disable, enable, run, runs, and remove", async () => {
    const { peach, luigi } = stage.u;
    const added = await json(peach, [
      "schedule",
      "add",
      "--bot",
      "toadsworth",
      "--name",
      "Moat check",
      "--cron",
      "0 9 * * 1-5",
      "--tz",
      "Europe/Berlin",
      "--instruction",
      "Check the moat.",
      "--guard",
      "only if it rained",
    ]);
    expect(added.schedule).toMatchObject({
      name: "Moat check",
      targetType: "none",
      timeZone: "Europe/Berlin",
      description: "Weekdays at 09:00",
      guard: "only if it rained",
      enabled: true,
    });
    expect(added.schedule.nextSlots).toHaveLength(5);
    const id = String(added.schedule.id);

    const list = await as(peach, ["schedule", "list", "--bot", "toadsworth"]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("Moat check");
    expect(list.stdout).toContain("Weekdays at 09:00 (Europe/Berlin)");

    const view = await as(peach, ["schedule", "view", id]);
    expect(view.stdout).toContain("guard     only if it rained");
    expect(view.stdout).toContain("Next slots:");

    const edited = await json(peach, [
      "schedule",
      "edit",
      id,
      "--no-guard",
      "--cron",
      "0 17 * * 5",
    ]);
    expect(edited.schedule).toMatchObject({
      guard: null,
      description: "Fridays at 17:00",
    });

    const off = await as(peach, ["schedule", "disable", id]);
    expect(off.stdout).toContain('Disabled "Moat check"');
    const on = await as(peach, ["schedule", "enable", id]);
    expect(on.stdout).toContain('Enabled "Moat check" — next');

    const run = await json(peach, ["schedule", "run", id]);
    expect(run.run.trigger).toBe("manual");
    const runs = await json(peach, ["schedule", "runs", id]);
    expect(runs.pagination.total).toBe(1);

    const bad = await as(peach, [
      "schedule",
      "edit",
      id,
      "--cron",
      "* * * * *",
    ]);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("5 minutes apart");
    const refused = await as(peach, ["schedule", "add", "--bot", "toadsworth"]);
    expect(refused.stderr).toContain("--name");

    // Luigi may read the bot's schedules; the default write list lets him
    // write too, so only the confirmation stops a careless remove.
    expect((await as(luigi, ["schedule", "view", id])).code).toBe(0);
    const unconfirmed = await as(peach, ["schedule", "remove", id]);
    expect(unconfirmed.code).not.toBe(0);
    expect(unconfirmed.stderr).toContain("--yes");
    const removed = await as(peach, ["schedule", "remove", id, "--yes"]);
    expect(removed.stdout).toContain('Deleted schedule "Moat check"');
  });
});
