import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "keryx";
import {
  type AgentStage,
  buildAgentStage,
  conversationRow,
  runTicks,
} from "../agent/harness";
import { cliSignIn, HOOK_TIMEOUT, type TestUser } from "../setup";

/**
 * `hypotenuse conversation …` and `hypotenuse bot callback-secret`, spawned
 * from source against the booted server, a bot whose models are the scripted
 * model server, and ticks run the way a worker runs them — off the Redis
 * queue — while the CLI polls. Every command once, its `--json` answer, what a
 * person reads when following, and a refusal on stderr.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");

let stage: AgentStage;
const homes = new Map<string, string>();

/**
 * Give a person a config directory with a signed-in CLI.
 * @param user - Who.
 */
async function signIn(user: TestUser): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "hyp-conversation-"));
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
  for (const user of [stage.u.peach, stage.u.mario]) await signIn(user);
}, HOOK_TIMEOUT);

afterEach(() => {
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
});

afterAll(async () => {
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Start the CLI as a person, in the Castle project.
 * @param user - Whose config directory to use.
 * @param args - Arguments after `hypotenuse --project <castle>`.
 * @param stdin - Written to its standard input.
 * @returns The running process.
 */
function spawn(user: TestUser, args: string[], stdin?: string) {
  return Bun.spawn(
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
}

/**
 * Wait for a spawned CLI and collect what it printed.
 * @param proc - The process.
 * @returns Exit code and captured output.
 */
async function collect(proc: ReturnType<typeof spawn>) {
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

/**
 * Run the CLI to completion.
 * @param user - Who.
 * @param args - Arguments.
 * @param stdin - Standard input.
 * @returns Exit code and captured output.
 */
async function as(user: TestUser, args: string[], stdin?: string) {
  return collect(spawn(user, args, stdin));
}

/**
 * Run the CLI while ticks are run beside it, as a worker would, until it exits.
 * @param user - Who.
 * @param args - Arguments.
 * @param stdin - Standard input.
 * @returns Exit code and captured output.
 */
async function asWithWorker(user: TestUser, args: string[], stdin?: string) {
  const proc = spawn(user, args, stdin);
  const output = collect(proc);
  let exited = false;
  proc.exited.then(() => {
    exited = true;
  });
  while (!exited) {
    await runTicks();
    await Bun.sleep(50);
  }
  return output;
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

/**
 * A scripted step that ends with one terminal tool.
 * @param name - The tool.
 * @param input - Its input.
 * @returns The step.
 */
function step(name: string, input: Record<string, unknown>) {
  return { toolCalls: [{ name, input }] };
}

describe("conversation", () => {
  let first: number;

  test("create starts one by bot slug; follow prints the transcript and where it rests", async () => {
    stage.models.play([step("reply_and_wait", { text: "Hi, Peach." })]);
    const created = await json(stage.u.peach, [
      "conversation",
      "create",
      "--bot",
      "toadsworth",
      "--text",
      "Hello?",
      "--request-id",
      "cli-first",
    ]);
    first = created.conversation.id;
    expect(created.conversation).toMatchObject({
      botId: stage.botId,
      state: "working",
      title: null,
    });
    expect(created.channel.name).toBeString();
    expect(created.deduped).toBe(false);

    // The same --request-id starts nothing new.
    const again = await json(stage.u.peach, [
      "conversation",
      "create",
      "--bot",
      String(stage.botId),
      "--text",
      "Hello?",
      "--request-id",
      "cli-first",
    ]);
    expect(again).toMatchObject({
      deduped: true,
      conversation: { id: first },
    });

    // The repeat re-enqueues the still-working conversation's tick; the
    // second finds nothing to do.
    expect(await runTicks()).toBeGreaterThanOrEqual(1);
    const out = await as(stage.u.peach, [
      "conversation",
      "follow",
      String(first),
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain("user: Hello?");
    expect(out.stdout).toContain("Toadsworth (bot): Hi, Peach.");
    expect(out.stdout).toContain("· new → working");
    expect(out.stdout).toContain("· working → hibernating (reply)");
    expect(out.stdout.trim().split("\n").at(-1)).toMatch(
      new RegExp(`^. Hibernating — conversation ${first}$`),
    );
    // A step record (the assistant message with no text) prints nothing.
    expect(out.stdout).not.toContain("Toadsworth (bot): \n");
  });

  test("message --follow sends, follows only what is new, and stops when it ends", async () => {
    stage.models.play([step("complete", { summary: "All done." })]);
    const out = await asWithWorker(stage.u.peach, [
      "conversation",
      "message",
      String(first),
      "--text",
      "Thanks, that is all",
      "--follow",
      "--interval",
      "0.1",
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(`Sent to conversation ${first} (steer)`);
    expect(out.stdout).toContain("user: Thanks, that is all");
    expect(out.stdout).toContain("Toadsworth (bot): All done.");
    expect(out.stdout).not.toContain("Hi, Peach.");
    expect(out.stdout.trim().split("\n").at(-1)).toContain(
      `Complete — conversation ${first}`,
    );
    expect((await conversationRow(first)).outcome).toBe("completed");
  });

  test("create --follow --json reads stdin and prints one JSON object per line", async () => {
    stage.models.play([
      {
        toolCalls: [{ name: "search_history", input: { query: "castle" } }],
      },
      step("reply_and_wait", { text: "Found nothing." }),
    ]);
    const out = await asWithWorker(
      stage.u.mario,
      [
        "--json",
        "conversation",
        "create",
        "--bot",
        "toadsworth",
        "--text",
        "-",
        "--title",
        "From stdin",
        "--channel",
        "cli",
        "--follow",
        "--interval",
        "0.1",
      ],
      "What happened\nat the castle?\n",
    );
    expect(out.code).toBe(0);
    const lines = out.stdout
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0].conversation.title).toBe("From stdin");
    expect(lines[0].channel.name).toContain("cli");
    const entries = lines.slice(1, -1);
    expect(entries.map((e) => e.kind)).toContain("tool_call_intent");
    const said = entries.find((e) => e.kind === "message" && e.role === "user");
    expect(said.content.text).toBe("What happened\nat the castle?");
    expect(lines.at(-1).conversation.state).toBe("hibernating");

    // A person reads the non-speaking tool call as one line.
    const id = lines[0].conversation.id;
    const human = await as(stage.u.mario, [
      "conversation",
      "follow",
      String(id),
    ]);
    expect(human.stdout).toMatch(/→ search_history\(\{"query":"castle"\}\)/);
    expect(human.stdout).toContain("Toadsworth (bot): Found nothing.");
  });

  test("follow exits 1 when the conversation failed", async () => {
    stage.models.play([step("fail", { reason: "The moat is frozen." })]);
    const out = await asWithWorker(stage.u.peach, [
      "conversation",
      "create",
      "--bot",
      "toadsworth",
      "--text",
      "Open the gate",
      "--follow",
      "--interval",
      "0.1",
    ]);
    expect(out.code).toBe(1);
    expect(out.stdout).toContain("Toadsworth (bot): The moat is frozen.");
    expect(out.stdout.trim().split("\n").at(-1)).toMatch(
      /Failed — conversation \d+$/,
    );
  });

  test("list filters by bot and state; view shows one", async () => {
    const ended = await json(stage.u.peach, [
      "conversation",
      "list",
      "--bot",
      "toadsworth",
      "--state",
      "ended",
    ]);
    expect(ended.pagination).toMatchObject({ page: 1, limit: 25 });
    expect(ended.conversations.length).toBe(2);
    for (const c of ended.conversations) {
      expect(c.state).toBe("ended");
      expect(c.bot.slug).toBe("toadsworth");
    }

    const table = await as(stage.u.peach, [
      "conversation",
      "list",
      "--limit",
      "2",
    ]);
    expect(table.code).toBe(0);
    expect(table.stdout).toContain("LAST ACTIVE");
    expect(table.stdout).toContain("page 1 of 2");

    const view = await json(stage.u.peach, [
      "conversation",
      "view",
      String(first),
    ]);
    expect(view.conversation).toMatchObject({
      id: first,
      outcome: "completed",
    });
    expect(view.bot.slug).toBe("toadsworth");
    const human = await as(stage.u.peach, [
      "conversation",
      "view",
      String(first),
    ]);
    expect(human.stdout).toContain("Complete");
    expect(human.stdout).toContain("bot           Toadsworth (toadsworth");
  });

  test("cancel ends a resting conversation; a second cancel changes nothing", async () => {
    const list = await json(stage.u.peach, [
      "conversation",
      "list",
      "--state",
      "hibernating",
    ]);
    const id = list.conversations[0].id;
    const out = await as(stage.u.peach, ["conversation", "cancel", String(id)]);
    expect(out.code).toBe(0);
    expect(out.stdout.trim()).toBe(`Cancelled conversation ${id}`);
    expect(await conversationRow(id)).toMatchObject({
      state: "ended",
      outcome: "cancelled",
    });
    const again = await json(stage.u.peach, [
      "conversation",
      "cancel",
      String(id),
    ]);
    expect(again.result).toBe("noop");
    const view = await as(stage.u.peach, ["conversation", "view", String(id)]);
    expect(view.stdout).toContain("Cancelled");
  });

  test("refusals land on stderr with a non-zero exit", async () => {
    const missing = await as(stage.u.peach, [
      "conversation",
      "message",
      "999999",
      "--text",
      "Anyone?",
    ]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toMatch(/not found|No /i);

    const notAnId = await as(stage.u.peach, ["conversation", "view", "abc"]);
    expect(notAnId.code).toBe(1);
    expect(notAnId.stderr).toContain("named by its id");

    const empty = await as(
      stage.u.peach,
      ["conversation", "create", "--bot", "toadsworth", "--text", "-"],
      "\n",
    );
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("Standard input was empty");
  });
});

describe("bot callback-secret", () => {
  test("prints the secret once on stdout, and replacing it needs --yes", async () => {
    const out = await as(stage.u.peach, [
      "bot",
      "callback-secret",
      "toadsworth",
    ]);
    expect(out.code).toBe(0);
    const secret = out.stdout.trim();
    expect(secret.length).toBeGreaterThan(20);
    expect(secret).not.toContain(" ");
    expect(out.stderr).toContain("never shown again");

    const view = await json(stage.u.peach, ["bot", "view", "toadsworth"]);
    expect(view.bot.hasCallbackSecret).toBe(true);
    expect(JSON.stringify(view)).not.toContain(secret);

    const refused = await as(stage.u.peach, [
      "bot",
      "callback-secret",
      "toadsworth",
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("--yes");
    expect(refused.stdout).toBe("");

    const rotated = await json(stage.u.peach, [
      "bot",
      "callback-secret",
      "toadsworth",
      "--yes",
    ]);
    expect(rotated.callbackSecret).toBeString();
    expect(rotated.callbackSecret).not.toBe(secret);
    expect(rotated.bot.hasCallbackSecret).toBe(true);
  });
});
