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
  drainQueue,
  runTicks,
} from "../agent/harness";
import { WebhookPlatform } from "../fakes/webhook/server";
import { cliSignIn, HOOK_TIMEOUT, type TestUser } from "../setup";

/**
 * `hypotenuse installation …`, `channel …`, `binding …`, `help-request …`,
 * `participant …`, `event …`, `conversation create --web`, and the bot's
 * channel settings, spawned from source against the booted server, the
 * scripted model, and the webhook platform faked over its wire protocol:
 * every command's `--json` answer, what a person reads, the refusals, and
 * that the signing secret handed to the CLI never comes back out of it.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");

let stage: AgentStage;
let fake: WebhookPlatform;
const homes = new Map<string, string>();
/** Everything the CLI printed, on either stream, to check for the secret. */
const printed: string[] = [];

/**
 * Give a person a config directory with a signed-in CLI.
 * @param user - Who.
 */
async function signIn(user: TestUser): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "hyp-channel-"));
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
  await api.resque.queue.delQueue("ingress");
  fake = new WebhookPlatform().start();
  for (const user of [stage.u.peach, stage.u.mario]) await signIn(user);
}, HOOK_TIMEOUT);

afterEach(() => {
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
});

afterAll(async () => {
  await fake.stop();
  await stage.models.stop();
  await api.resque.queue.delQueue("ingress");
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Run the CLI as a person, in the Castle project, to completion.
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

/**
 * A scripted step that ends with one terminal tool.
 * @param name - The tool.
 * @param input - Its input.
 * @returns The step.
 */
function step(name: string, input: Record<string, unknown>) {
  return { toolCalls: [{ name, input }] };
}

/**
 * The events URL, pointed at this test's server: the server builds it from
 * its configured public origin, and the test server listens on a free port.
 * @param events - The URL the manifest printed.
 * @returns The same path on the booted server.
 */
function local(events: string): string {
  return `${new URL(stage.u.url).origin}${new URL(events).pathname}`;
}

let installationId: number;
let generalId: number;
let secretId: number;

describe("installation", () => {
  test("manifest prints the events URL, says it is shown once, and mints a new one when asked again", async () => {
    const human = await as(stage.u.peach, [
      "installation",
      "manifest",
      "--bot",
      "toadsworth",
    ]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("Events URL");
    const first = /https?:\/\/\S+\/webhooks\/webhook\/\S+/.exec(
      human.stdout,
    )?.[0];
    expect(first).toBeString();
    expect(human.stdout).toContain("manifest:");
    expect(human.stdout).toContain('"botUserId": "bot:toadsworth"');
    expect(human.stderr).toContain("shown once");

    const again = await json(stage.u.peach, [
      "installation",
      "manifest",
      "--bot",
      String(stage.botId),
      "--type",
      "webhook",
    ]);
    expect(again.installation).toMatchObject({
      botId: stage.botId,
      type: "webhook",
      externalWorkspaceId: "default",
      status: "pending",
      hasCredentials: false,
    });
    expect(again.urls.events).not.toBe(first);
    installationId = again.installation.id;
    fake.eventsUrl = local(again.urls.events);

    // The first URL stopped working when the second was minted.
    expect((await fake.sendRaw("{}", local(first as string))).status).toBe(404);
  });

  test("connect reads the signing secret from stdin, never a flag, and never prints it", async () => {
    const noSecret = await as(stage.u.peach, [
      "installation",
      "connect",
      "--bot",
      "toadsworth",
      "--delivery-url",
      fake.deliveryUrl,
    ]);
    expect(noSecret.code).toBe(1);
    expect(noSecret.stderr).toContain("--signing-secret-stdin");

    const connected = await json(
      stage.u.peach,
      [
        "installation",
        "connect",
        "--bot",
        "toadsworth",
        "--delivery-url",
        fake.deliveryUrl,
        "--signing-secret-stdin",
      ],
      `${fake.secret}\n`,
    );
    expect(connected.installation).toMatchObject({
      id: installationId,
      status: "active",
      hasCredentials: true,
      config: { deliveryUrl: fake.deliveryUrl },
    });

    const fromEnv = await as(stage.u.peach, [
      "installation",
      "connect",
      "--bot",
      "toadsworth",
      "--delivery-url",
      fake.deliveryUrl,
      "--signing-secret-env",
      "HYPOTENUSE_TEST_UNSET_SECRET",
    ]);
    expect(fromEnv.code).toBe(1);
    expect(fromEnv.stderr).toContain("HYPOTENUSE_TEST_UNSET_SECRET is not set");
  });

  test("test probes the delivery URL and exits 1 when it fails", async () => {
    const ok = await as(stage.u.peach, [
      "installation",
      "test",
      String(installationId),
    ]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain(
      `Installation ${installationId} works; the bot is B-toadsworth there`,
    );

    fake.answers.push({ status: 500 });
    const broken = await as(stage.u.peach, [
      "--json",
      "installation",
      "test",
      String(installationId),
    ]);
    expect(broken.code).toBe(1);
    const body = JSON.parse(broken.stdout);
    expect(body.ok).toBe(false);
    expect(body.error).toContain("500");
    expect(body.installation.status).toBe("error");

    const fixed = await json(stage.u.peach, [
      "installation",
      "test",
      String(installationId),
    ]);
    expect(fixed).toMatchObject({
      ok: true,
      installation: { status: "active" },
    });
  });

  test("list and view show the installation, never its credentials", async () => {
    const list = await json(stage.u.mario, [
      "installation",
      "list",
      "--bot",
      "toadsworth",
    ]);
    expect(list.pagination).toMatchObject({ page: 1, total: 1 });
    expect(list.installations[0]).toMatchObject({
      id: installationId,
      externalBotUserId: "B-toadsworth",
    });

    const table = await as(stage.u.peach, [
      "installation",
      "list",
      "--bot",
      "toadsworth",
    ]);
    expect(table.stdout).toContain("BOT USER");
    expect(table.stdout).toContain("active");

    const view = await as(stage.u.peach, [
      "installation",
      "view",
      String(installationId),
    ]);
    expect(view.code).toBe(0);
    expect(view.stdout).toContain(`installation ${installationId} — active`);
    expect(view.stdout).toContain("credentials   set (version 1)");
    expect(view.stdout).toContain(`deliveryUrl   ${fake.deliveryUrl}`);
    expect(view.stdout).toContain("can show");

    const notAnId = await as(stage.u.peach, ["installation", "view", "abc"]);
    expect(notAnId.code).toBe(1);
    expect(notAnId.stderr).toContain("named by its id");
  });
});

describe("channels and bindings", () => {
  test("a channel appears once the bot hears from it, with its binding or none", async () => {
    stage.models.play([step("reply_and_wait", { text: "At your service." })]);
    expect(
      (
        await fake.send({
          channel: { id: "C-general", name: "general" },
          conversation: "t-general",
          sender: { id: "U-peach", name: "Peach" },
          text: "@Toadsworth hello",
          mentions: true,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fake.send({
          channel: { id: "C-secret", name: "secret", private: true },
          conversation: "t-secret",
          sender: { id: "U-mario", name: "Mario" },
          text: "@Toadsworth psst",
          mentions: true,
        })
      ).status,
    ).toBe(200);
    await drainQueue("ingress");
    expect(await runTicks()).toBeGreaterThanOrEqual(1);

    const list = await json(stage.u.peach, [
      "channel",
      "list",
      "--bot",
      "toadsworth",
    ]);
    const general = list.channels.find(
      (c: { name: string }) => c.name === "general",
    );
    const secret = list.channels.find(
      (c: { name: string }) => c.name === "secret",
    );
    generalId = general.id;
    secretId = secret.id;
    expect(general).toMatchObject({
      type: "webhook",
      isPrivate: false,
      botInstallationId: installationId,
      binding: { autoBound: true, mode: "mentions", enabled: true },
    });
    expect(secret).toMatchObject({ isPrivate: true, binding: null });

    const table = await as(stage.u.peach, [
      "channel",
      "list",
      "--bot",
      "toadsworth",
    ]);
    expect(table.stdout).toContain("unbound");
    expect(table.stdout).toContain("auto-bound");

    // Without --bot, no binding column.
    const all = await json(stage.u.mario, [
      "channel",
      "list",
      "--type",
      "webhook",
    ]);
    expect(all.channels.length).toBe(2);
    expect(all.channels[0].binding).toBeUndefined();
  });

  test("binding a private channel needs --confirm-audience, in the flag's words", async () => {
    const refused = await as(stage.u.peach, [
      "binding",
      "create",
      "--bot",
      "toadsworth",
      "--channel",
      String(secretId),
    ]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('"secret" is private');
    expect(refused.stderr).toContain("Pass --confirm-audience");

    const badMode = await as(stage.u.peach, [
      "binding",
      "create",
      "--bot",
      "toadsworth",
      "--channel",
      String(secretId),
      "--mode",
      "loud",
    ]);
    expect(badMode.code).toBe(1);
    expect(badMode.stderr).toContain("--mode is one of mentions, all, dm");

    const created = await json(stage.u.peach, [
      "binding",
      "create",
      "--bot",
      "toadsworth",
      "--channel",
      String(secretId),
      "--confirm-audience",
      "--mode",
      "all",
      "--approval-policy",
      "listed",
      "--approver",
      "U-peach",
      "--approver",
      "U-mario",
      "--allow-promotion",
    ]);
    expect(created.binding).toMatchObject({
      botId: stage.botId,
      channelId: secretId,
      mode: "all",
      approvalPolicy: "listed",
      approverExternalIds: ["U-peach", "U-mario"],
      allowPromotion: true,
      autoBound: false,
      enabled: true,
    });
    const bindingId = created.binding.id;

    const twice = await as(stage.u.peach, [
      "binding",
      "create",
      "--bot",
      "toadsworth",
      "--channel",
      String(secretId),
      "--confirm-audience",
    ]);
    expect(twice.code).toBe(1);
    expect(twice.stderr).toContain("already bound");

    const edited = await json(stage.u.peach, [
      "binding",
      "edit",
      String(bindingId),
      "--disable",
      "--no-allow-promotion",
      "--delivery",
      "queue",
    ]);
    expect(edited.binding).toMatchObject({
      enabled: false,
      allowPromotion: false,
      defaultDelivery: "queue",
      mode: "all",
      approverExternalIds: ["U-peach", "U-mario"],
    });

    // Emptying the list the listed policy needs is refused, in flag words.
    const emptied = await as(stage.u.peach, [
      "binding",
      "edit",
      String(bindingId),
      "--no-approvers",
    ]);
    expect(emptied.code).toBe(1);
    expect(emptied.stderr).toContain("pass --approver with");

    const list = await as(stage.u.peach, [
      "binding",
      "list",
      "--bot",
      "toadsworth",
    ]);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(`secret (${secretId})`);
    expect(list.stdout).toContain(
      "all (disabled), queue, approvals: listed (U-peach, U-mario)",
    );

    const view = await as(stage.u.mario, ["channel", "view", String(secretId)]);
    expect(view.code).toBe(0);
    expect(view.stdout).toContain(`secret (channel ${secretId})`);
    expect(view.stdout).toContain("audience      private");
    expect(view.stdout).toContain(String(bindingId));

    const unconfirmed = await as(stage.u.peach, [
      "binding",
      "delete",
      String(bindingId),
    ]);
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.stderr).toContain("--yes");
    const deleted = await json(stage.u.peach, [
      "binding",
      "delete",
      String(bindingId),
      "--yes",
    ]);
    expect(deleted.binding.id).toBe(bindingId);
    const after = await json(stage.u.peach, [
      "channel",
      "view",
      String(secretId),
    ]);
    expect(after.bindings).toEqual([]);
  });
});

describe("participants and events", () => {
  test("participant list shows who wrote to the bots; view shows one", async () => {
    const list = await json(stage.u.mario, [
      "participant",
      "list",
      "--type",
      "webhook",
      "--query",
      "pea",
    ]);
    expect(list.participants.length).toBe(1);
    expect(list.participants[0]).toMatchObject({
      externalUserId: "U-peach",
      displayName: "Peach",
      isBot: false,
    });
    const view = await as(stage.u.mario, [
      "participant",
      "view",
      String(list.participants[0].id),
    ]);
    expect(view.code).toBe(0);
    expect(view.stdout).toContain("platform id   U-peach");
  });

  test("event list shows each delivery's outcome to an admin; view prints its payload", async () => {
    const list = await json(stage.u.peach, ["event", "list"]);
    expect(list.triggerEvents.length).toBeGreaterThanOrEqual(2);
    const unbound = await json(stage.u.peach, [
      "event",
      "list",
      "--outcome",
      "unbound",
      "--installation",
      String(installationId),
    ]);
    expect(unbound.triggerEvents.length).toBe(1);
    expect(unbound.triggerEvents[0]).toMatchObject({
      status: "ignored",
      outcome: "unbound",
    });

    const view = await as(stage.u.peach, [
      "event",
      "view",
      String(unbound.triggerEvents[0].id),
    ]);
    expect(view.code).toBe(0);
    expect(view.stdout).toContain("ignored: unbound");
    expect(view.stdout).toContain("payload:");
    expect(view.stdout).toContain("@Toadsworth psst");

    const badStatus = await as(stage.u.peach, [
      "event",
      "list",
      "--status",
      "lost",
    ]);
    expect(badStatus.code).toBe(1);
    expect(badStatus.stderr).toContain("--status is one of");

    // Admins only.
    const member = await as(stage.u.mario, ["event", "list"]);
    expect(member.code).toBe(1);
  });
});

describe("help-request", () => {
  test("list, view, and answer a bot's question; the bot carries on", async () => {
    stage.models.play([
      step("escalate_to_human", {
        question: "May I open the vault?",
        context: "The key is in the moat.",
        urgency: "high",
      }),
    ]);
    const created = await json(stage.u.peach, [
      "conversation",
      "create",
      "--bot",
      "toadsworth",
      "--text",
      "Open the vault",
    ]);
    await runTicks();

    const list = await json(stage.u.peach, [
      "help-request",
      "list",
      "--status",
      "pending",
      "--bot",
      "toadsworth",
    ]);
    expect(list.helpRequests.length).toBe(1);
    const asked = list.helpRequests[0];
    expect(asked).toMatchObject({
      conversationId: created.conversation.id,
      question: "May I open the vault?",
      urgency: "high",
      blocking: true,
      botName: "Toadsworth",
      canAnswer: true,
    });

    const table = await as(stage.u.peach, ["help-request", "list"]);
    expect(table.stdout).toContain("May I open the vault?");
    expect(table.stdout).toContain("answer");

    const view = await as(stage.u.peach, [
      "help-request",
      "view",
      String(asked.id),
    ]);
    expect(view.code).toBe(0);
    expect(view.stdout).toContain(`help request ${asked.id} — pending`);
    expect(view.stdout).toContain("context       The key is in the moat.");
    expect(view.stdout).toContain("you can       answer it, cancel it");

    stage.models.play([step("reply_and_wait", { text: "Opening it now." })]);
    const answered = await as(
      stage.u.peach,
      ["help-request", "answer", String(asked.id), "--text", "-"],
      "Yes, carefully.\n",
    );
    expect(answered.code).toBe(0);
    expect(answered.stdout).toContain(
      `Answered help request ${asked.id}; conversation ${created.conversation.id} carries on`,
    );
    await runTicks();
    const after = await json(stage.u.peach, [
      "help-request",
      "view",
      String(asked.id),
    ]);
    expect(after.helpRequest).toMatchObject({
      status: "answered",
      answer: "Yes, carefully.",
    });
    expect(after.standing).toEqual({ canAnswer: false, canCancel: false });

    const again = await as(stage.u.peach, [
      "help-request",
      "answer",
      String(asked.id),
      "--text",
      "Twice?",
    ]);
    expect(again.code).toBe(1);
  });

  test("cancel withdraws one, and refuses a status that is not one", async () => {
    stage.models.play([
      step("escalate_to_human", { question: "Which moat?", blocking: true }),
    ]);
    await json(stage.u.peach, [
      "conversation",
      "create",
      "--bot",
      "toadsworth",
      "--text",
      "Fill the moat",
    ]);
    await runTicks();
    const [pending] = (
      await json(stage.u.peach, ["help-request", "list", "--status", "pending"])
    ).helpRequests;
    expect(pending.question).toBe("Which moat?");

    stage.models.play([step("reply_and_wait", { text: "I will choose." })]);
    const cancelled = await json(stage.u.peach, [
      "help-request",
      "cancel",
      String(pending.id),
    ]);
    expect(cancelled.helpRequest.status).toBe("cancelled");
    await runTicks();

    const badStatus = await as(stage.u.peach, [
      "help-request",
      "list",
      "--status",
      "lost",
    ]);
    expect(badStatus.code).toBe(1);

    const help = await as(stage.u.peach, ["help-request", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: hypotenuse help-request");
  });
});

describe("conversation create --web", () => {
  test("starts a dashboard chat, --fresh in a scratch channel; follow piped prints no escapes", async () => {
    const lone = await as(stage.u.peach, [
      "conversation",
      "create",
      "--bot",
      "toadsworth",
      "--text",
      "Hi",
      "--fresh",
    ]);
    expect(lone.code).toBe(1);
    expect(lone.stderr).toContain("--fresh goes with --web");

    const withChannel = await as(stage.u.peach, [
      "conversation",
      "create",
      "--bot",
      "toadsworth",
      "--text",
      "Hi",
      "--web",
      "--channel",
      "x",
    ]);
    expect(withChannel.code).toBe(1);
    expect(withChannel.stderr).toContain("--channel names an API channel");

    stage.models.play([step("reply_and_wait", { text: "Shared chat." })]);
    const shared = await json(stage.u.peach, [
      "conversation",
      "create",
      "--bot",
      "toadsworth",
      "--text",
      "Hi there",
      "--web",
    ]);
    expect(shared.channel).toMatchObject({ type: "web", name: "dashboard" });
    await runTicks();

    stage.models.play([step("reply_and_wait", { text: "A clean slate." })]);
    const fresh = await json(stage.u.peach, [
      "conversation",
      "create",
      "--bot",
      "toadsworth",
      "--text",
      "Forget everything",
      "--web",
      "--fresh",
    ]);
    expect(fresh.channel.type).toBe("web");
    expect(fresh.channel.name).toMatch(/^scratch-/);
    expect(fresh.channel.id).not.toBe(shared.channel.id);
    await runTicks();

    const follow = await as(stage.u.peach, [
      "conversation",
      "follow",
      String(fresh.conversation.id),
    ]);
    expect(follow.code).toBe(0);
    expect(follow.stdout).toContain("Toadsworth (bot): A clean slate.");
    expect(follow.stdout).not.toContain("\x1b[");
  });
});

describe("bot edit channel settings", () => {
  test("--auto-bind and the rate limits change only those, and view shows them", async () => {
    const edited = await json(stage.u.peach, [
      "bot",
      "edit",
      "toadsworth",
      "--auto-bind",
      "public,dm",
      "--participant-rate-limit",
      "5",
      "--channel-rate-limit",
      "40",
    ]);
    expect(edited.bot).toMatchObject({
      autoBind: { public: true, private: false, dm: true },
      participantRateLimit: 5,
      channelRateLimit: 40,
    });
    const view = await as(stage.u.peach, ["bot", "view", "toadsworth"]);
    expect(view.stdout).toContain(
      "auto-binds    public, dm; at most 5 messages a minute a person, 40 a channel",
    );
    const bad = await as(stage.u.peach, [
      "bot",
      "edit",
      "toadsworth",
      "--auto-bind",
      "everywhere",
    ]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--auto-bind takes public, private, dm");
  });
});

describe("installation disconnect", () => {
  test("needs --yes; then the platform's deliveries stop", async () => {
    const unconfirmed = await as(stage.u.peach, [
      "installation",
      "disconnect",
      String(installationId),
    ]);
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.stderr).toContain("--yes");

    const out = await as(stage.u.peach, [
      "installation",
      "disconnect",
      String(installationId),
      "--yes",
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(`Disconnected installation ${installationId}`);
    const late = await fake.send({
      channel: { id: "C-general", name: "general" },
      conversation: "t-general",
      text: "anyone?",
    });
    expect(late.status).toBe(404);
    const list = await json(stage.u.peach, [
      "installation",
      "list",
      "--bot",
      "toadsworth",
    ]);
    expect(list.installations).toEqual([]);
    // The channel stays.
    expect(
      (await json(stage.u.peach, ["channel", "view", String(generalId)]))
        .channel.name,
    ).toBe("general");
  });

  test("the signing secret never came back out of the CLI", () => {
    for (const text of printed) expect(text).not.toContain(fake.secret);
  });
});
