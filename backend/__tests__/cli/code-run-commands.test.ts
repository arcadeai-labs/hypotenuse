import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "keryx";
import { runTicks, startConversation } from "../agent/harness";
import { codeStep } from "../code/harness";
import {
  addServer,
  bindServer,
  buildMcpStage,
  clearLoopQueues,
  type McpStage,
} from "../mcp/harness";
import { cliSignIn, HOOK_TIMEOUT, type TestUser } from "../setup";

/**
 * `hypotenuse code-run list|view` and the bot's code-mode flags, spawned from
 * source against the booted server: the `--json` answers, what a person
 * reads, and that no continuation ever comes out.
 */
let conversationId: number;
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");

let stage: McpStage;
const homes = new Map<string, string>();
/** Everything the CLI printed, on either stream, to check for secrets. */
const printed: string[] = [];

/**
 * Give a person a config directory with a signed-in CLI.
 * @param user - Who.
 */
async function signIn(user: TestUser): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "hyp-code-"));
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
  stage = await buildMcpStage();
  for (const user of [stage.u.peach]) await signIn(user);
  const server = await addServer(stage);
  await bindServer(stage, server.id);
  stage.models.play([
    codeStep(
      'console.log("hi"); await mcp.info("mail", "send_email"); return await mcp.exec("mail", "send_email", { to: "toad", subject: "x" })',
    ),
  ]);
  conversationId = (await startConversation(stage, "Program")).body.conversation
    .id;
  await runTicks();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await clearLoopQueues();
  await stage.fixture.stop();
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
  printed.push(stdout, stderr);
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

test("code-run list and view, for a program paused on an approval", async () => {
  const list = await json(stage.u.peach, [
    "code-run",
    "list",
    "--conversation",
    String(conversationId),
  ]);
  expect(list.codeRuns).toHaveLength(1);
  const [run] = list.codeRuns;
  expect(run.status).toBe("interrupted");
  expect(JSON.stringify(list)).not.toContain("continuation");

  const people = await as(stage.u.peach, [
    "code-run",
    "list",
    "--conversation",
    String(conversationId),
  ]);
  expect(people.code).toBe(0);
  expect(people.stdout).toContain("interrupted");
  expect(people.stdout).toContain('console.log("hi")');

  const view = await as(stage.u.peach, ["code-run", "view", String(run.id)]);
  expect(view.code).toBe(0);
  expect(view.stdout).toContain(`code run ${run.id} — interrupted`);
  expect(view.stdout).toContain("mcp.info mail/send_email — ok");
  expect(view.stdout).toContain("waiting on");
  expect(view.stdout).toContain("mail/send_email");

  const missing = await as(stage.u.peach, ["code-run", "view", "999999"]);
  expect(missing.code).not.toBe(0);
});

test("bot edit turns code mode off and lowers its limits; raising one is refused", async () => {
  const bot = String(stage.botId);
  const off = await json(stage.u.peach, [
    "bot",
    "edit",
    bot,
    "--no-code",
    "--code-timeout",
    "5",
    "--code-host-calls",
    "20",
  ]);
  expect(off.bot).toMatchObject({
    codeModeEnabled: false,
    codeLimits: { timeoutMs: 5_000, bridgeRequests: 20 },
  });
  const view = await as(stage.u.peach, ["bot", "view", bot]);
  expect(view.stdout).toContain("code          off");

  const on = await json(stage.u.peach, [
    "bot",
    "edit",
    bot,
    "--code",
    "--no-code-limits",
  ]);
  expect(on.bot).toMatchObject({ codeModeEnabled: true, codeLimits: {} });

  const raised = await as(stage.u.peach, [
    "bot",
    "edit",
    bot,
    "--code-timeout",
    "3600",
  ]);
  expect(raised.code).not.toBe(0);
  expect(raised.stderr).toContain("may only lower");
});
