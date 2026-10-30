import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "keryx";
import { runTicks, startConversation } from "../agent/harness";
import {
  approvalsOf,
  buildMcpStage,
  clearLoopQueues,
  infoThenExec,
  type McpStage,
  replyStep,
  resultsOf,
} from "../mcp/harness";
import { cliSignIn, HOOK_TIMEOUT, type TestUser } from "../setup";

/**
 * `hypotenuse mcp-server …`, `bot tools …`, `approval …`, `large-result
 * view`, and the bot approval flags, spawned from source against the booted
 * server, the scripted model, and the fixture MCP server: every command's
 * `--json` answer, what a person reads, refusals, and that no credential
 * handed to the CLI ever comes back out of it.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");

const BEARER = "bearer-secret-token-0451";
const HEADER_SECRET = "header-secret-value-9876";

let stage: McpStage;
const homes = new Map<string, string>();
/** Everything the CLI printed, on either stream, to check for secrets. */
const printed: string[] = [];

/**
 * Give a person a config directory with a signed-in CLI.
 * @param user - Who.
 */
async function signIn(user: TestUser): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "hyp-mcp-"));
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
  for (const user of [stage.u.peach, stage.u.mario]) await signIn(user);
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

/**
 * Park a conversation on a gated `mail/send_email` call.
 * @returns The conversation and its pending approval's id.
 */
async function parkOnSend(): Promise<{
  conversationId: number;
  approvalId: number;
}> {
  stage.models.play(
    infoThenExec("mail/send_email", { to: "toad", subject: "hi" }),
  );
  const started = await startConversation(stage, "Email Toad");
  const conversationId = started.body.conversation.id;
  await runTicks();
  const pending = (await approvalsOf(conversationId)).filter(
    (a) => a.status === "pending",
  );
  expect(pending.length).toBe(1);
  return { conversationId, approvalId: pending[0].id };
}

describe("mcp-server", () => {
  test("add connects a server and lists its tools; list, view, test, refresh, and match read it", async () => {
    const added = await json(stage.u.peach, [
      "mcp-server",
      "add",
      "mail",
      "--endpoint",
      stage.fixture.url,
    ]);
    expect(added.mcpServer).toMatchObject({
      name: "mail",
      url: stage.fixture.url,
      authMode: "none",
      status: "ok",
    });
    expect(added.mcpServer.toolCount).toBeGreaterThan(0);

    const listed = await json(stage.u.peach, ["mcp-server", "list"]);
    expect(listed.pagination).toMatchObject({ page: 1, total: 1 });
    expect(listed.mcpServers[0].name).toBe("mail");
    const human = await as(stage.u.peach, ["mcp-server", "list"]);
    expect(human.stdout).toContain("mail");
    expect(human.stdout).toContain("none");

    const viewed = await json(stage.u.peach, ["mcp-server", "view", "mail"]);
    const names = viewed.tools.map((t: { name: string }) => t.name);
    expect(names).toContain("mail/read_inbox");
    expect(names).toContain("mail/send_email");
    const viewText = await as(stage.u.mario, ["mcp-server", "view", "mail"]);
    expect(viewText.code).toBe(0);
    expect(viewText.stdout).toContain("mail/read_inbox");
    expect(viewText.stdout).toContain("read-only");

    const tested = await json(stage.u.peach, ["mcp-server", "test", "mail"]);
    expect(tested).toMatchObject({ ok: true, error: null });
    const refreshed = await json(stage.u.peach, [
      "mcp-server",
      "refresh",
      String(added.mcpServer.id),
    ]);
    expect(refreshed.ok).toBe(true);
    expect(refreshed.toolCount).toBe(added.mcpServer.toolCount);

    const matched = await json(stage.u.mario, [
      "mcp-server",
      "match",
      "mail",
      "--pattern",
      "/^mail\\/read_/",
      "--pattern",
      "send_email",
    ]);
    expect(matched.matches).toEqual([
      { pattern: "/^mail\\/read_/", tools: ["mail/read_inbox"] },
      { pattern: "send_email", tools: ["mail/send_email"] },
    ]);
    expect(matched.gated).not.toContain("mail/send_email");
    expect(matched.gated).toContain("mail/huge_report");
  });

  test("refusals: a member cannot connect a server, remove needs --yes, and an unknown name says how to find one", async () => {
    const member = await as(stage.u.mario, [
      "mcp-server",
      "add",
      "other",
      "--endpoint",
      stage.fixture.url,
    ]);
    expect(member.code).toBe(1);
    expect(member.stderr.toLowerCase()).toContain("admin");

    const noYes = await as(stage.u.peach, ["mcp-server", "remove", "mail"]);
    expect(noYes.code).toBe(1);
    expect(noYes.stderr).toContain("--yes");

    const unknown = await as(stage.u.peach, ["mcp-server", "view", "nope"]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("mcp-server list");

    const twoModes = await as(stage.u.peach, [
      "mcp-server",
      "add",
      "x",
      "--endpoint",
      stage.fixture.url,
      "--bearer-env",
      "T",
      "--oauth",
    ]);
    expect(twoModes.code).toBe(1);
    expect(twoModes.stderr).toContain("more than one way");
  });

  test("a bearer token and secret headers go in through stdin and never come back out", async () => {
    stage.fixture.setAuth({ mode: "bearer", token: BEARER });
    try {
      const bearer = await json(
        stage.u.peach,
        [
          "mcp-server",
          "add",
          "secure",
          "--endpoint",
          stage.fixture.url,
          "--bearer-stdin",
        ],
        `${BEARER}\n`,
      );
      expect(bearer.mcpServer).toMatchObject({
        authMode: "bearer",
        lastFour: BEARER.slice(-4),
        status: "ok",
      });
      const view = await as(stage.u.peach, ["mcp-server", "view", "secure"]);
      expect(view.stdout).toContain(`bearer …${BEARER.slice(-4)}`);

      stage.fixture.setAuth({
        mode: "headers",
        name: "X-Api-Key",
        value: HEADER_SECRET,
      });
      const headers = await json(
        stage.u.peach,
        [
          "mcp-server",
          "add",
          "keyed",
          "--endpoint",
          stage.fixture.url,
          "--header",
          "X-Team: castle",
          "--headers-stdin",
        ],
        `X-Api-Key: ${HEADER_SECRET}\n`,
      );
      expect(headers.mcpServer.authMode).toBe("headers");
      expect([...headers.mcpServer.headerNames].sort()).toEqual([
        "X-Api-Key",
        "X-Team",
      ]);
      expect(headers.mcpServer.status).toBe("ok");

      const edited = await json(stage.u.peach, [
        "mcp-server",
        "edit",
        "keyed",
        "--disable",
        "--timeout-ms",
        "5000",
      ]);
      expect(edited.mcpServer).toMatchObject({
        enabled: false,
        timeoutMs: 5000,
      });
      const nothing = await as(stage.u.peach, ["mcp-server", "edit", "keyed"]);
      expect(nothing.code).toBe(1);
      expect(nothing.stderr).toContain("Nothing to change");

      await as(stage.u.peach, ["mcp-server", "list"]);
      await json(stage.u.peach, ["mcp-server", "list"]);
      for (const name of ["secure", "keyed"]) {
        const removed = await json(stage.u.peach, [
          "mcp-server",
          "remove",
          name,
          "--yes",
        ]);
        expect(removed.mcpServer.name).toBe(name);
      }
    } finally {
      stage.fixture.setAuth({ mode: "none" });
    }
  });

  test("an OAuth server prints the URL to sign in at, and sign-in prints a fresh one", async () => {
    stage.fixture.setAuth({ mode: "oauth" });
    try {
      const added = await json(stage.u.peach, [
        "mcp-server",
        "add",
        "calendar",
        "--endpoint",
        stage.fixture.url,
        "--oauth",
      ]);
      expect(added.mcpServer).toMatchObject({
        authMode: "oauth",
        status: "needs_auth",
        signedIn: false,
      });
      expect(added.authorizationUrl).toStartWith(stage.fixture.origin);

      const human = await as(stage.u.peach, [
        "mcp-server",
        "sign-in",
        "calendar",
      ]);
      expect(human.code).toBe(0);
      expect(human.stdout.trim()).toStartWith(stage.fixture.origin);
      expect(human.stderr).toContain("Open the URL");

      await json(stage.u.peach, ["mcp-server", "remove", "calendar", "--yes"]);
    } finally {
      stage.fixture.setAuth({ mode: "none" });
    }
  });
});

describe("bot tools and the bot's approval settings", () => {
  test("add binds a server with an allowlist; add again changes it; list shows it; remove takes it away", async () => {
    const bound = await json(stage.u.peach, [
      "bot",
      "tools",
      "add",
      "toadsworth",
      "mail",
      "--allow",
      "mail/read_inbox",
      "--allow",
      "*/list_calendar_events",
      "--auto-allow-read-only",
    ]);
    expect(bound.botMcpServer).toMatchObject({
      allowedTools: ["mail/read_inbox", "*/list_calendar_events"],
      autoAllowReadOnly: true,
      server: { name: "mail" },
    });

    const changed = await json(stage.u.peach, [
      "bot",
      "tools",
      "add",
      "toadsworth",
      "mail",
      "--no-allow",
      "--no-auto-allow-read-only",
    ]);
    expect(changed.botMcpServer).toMatchObject({
      allowedTools: [],
      autoAllowReadOnly: false,
    });

    const listed = await json(stage.u.mario, [
      "bot",
      "tools",
      "list",
      "toadsworth",
    ]);
    expect(listed.pagination.total).toBe(1);
    expect(listed.botMcpServers[0].server.name).toBe("mail");
    expect(listed).toHaveProperty("capabilities");
    const human = await as(stage.u.peach, [
      "bot",
      "tools",
      "list",
      "toadsworth",
    ]);
    expect(human.stdout).toContain("(every call asks)");

    const removed = await json(stage.u.peach, [
      "bot",
      "tools",
      "remove",
      "toadsworth",
      "mail",
    ]);
    expect(removed.botMcpServer.server.name).toBe("mail");
    const empty = await json(stage.u.peach, [
      "bot",
      "tools",
      "list",
      "toadsworth",
    ]);
    expect(empty.botMcpServers).toEqual([]);
    const again = await as(stage.u.peach, [
      "bot",
      "tools",
      "remove",
      "toadsworth",
      "mail",
    ]);
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("does not use mail");
  });

  test("bot edit sets and clears the approver tag and the approval TTL", async () => {
    const set = await json(stage.u.peach, [
      "bot",
      "edit",
      "toadsworth",
      "--approver-tag",
      "operators",
      "--approval-ttl",
      "2h",
    ]);
    expect(set.bot).toMatchObject({
      approverTag: "operators",
      approvalTtlSeconds: 7200,
    });
    const view = await as(stage.u.peach, ["bot", "view", "toadsworth"]);
    expect(view.stdout).toContain("the operators tag");
    expect(view.stdout).toContain("wait 2h");

    const cleared = await json(stage.u.peach, [
      "bot",
      "edit",
      "toadsworth",
      "--no-approver-tag",
      "--approval-ttl",
      "86400",
    ]);
    expect(cleared.bot).toMatchObject({
      approverTag: null,
      approvalTtlSeconds: 86_400,
    });

    const bad = await as(stage.u.peach, [
      "bot",
      "edit",
      "toadsworth",
      "--approval-ttl",
      "soon",
    ]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("--approval-ttl");
  });
});

describe("approval", () => {
  test("list is empty before any call waits", async () => {
    const listed = await json(stage.u.peach, ["approval", "list"]);
    expect(listed.approvals).toEqual([]);
    expect(listed.pagination.total).toBe(0);
  });

  test("approve --always runs the call, records the CLI, and allowlists it; deny with a note refuses the next", async () => {
    await json(stage.u.peach, ["bot", "tools", "add", "toadsworth", "mail"]);
    const first = await parkOnSend();

    const pending = await json(stage.u.mario, [
      "approval",
      "list",
      "--status",
      "pending",
      "--bot",
      "toadsworth",
    ]);
    expect(pending.approvals).toHaveLength(1);
    expect(pending.approvals[0]).toMatchObject({
      id: first.approvalId,
      name: "mail/send_email",
      status: "pending",
      conversationId: first.conversationId,
      args: { to: "toad", subject: "hi" },
      canDecide: true,
    });
    const table = await as(stage.u.peach, ["approval", "list"]);
    expect(table.stdout).toContain("mail/send_email");

    const viewed = await json(stage.u.peach, [
      "approval",
      "view",
      String(first.approvalId),
    ]);
    expect(viewed.approval.requestedByName).toBeTruthy();
    const detail = await as(stage.u.peach, [
      "approval",
      "view",
      String(first.approvalId),
    ]);
    expect(detail.stdout).toContain("mail/send_email");
    expect(detail.stdout).toContain("decide it");

    stage.models.play([replyStep("Sent.")]);
    const approved = await json(stage.u.peach, [
      "approval",
      "approve",
      String(first.approvalId),
      "--always",
    ]);
    expect(approved.approval).toMatchObject({
      status: "approved",
      decidedVia: "cli",
    });
    await runTicks();
    expect(stage.fixture.calls.map((c) => c.tool)).toEqual(["send_email"]);
    const tools = await json(stage.u.peach, [
      "bot",
      "tools",
      "list",
      "toadsworth",
    ]);
    expect(tools.botMcpServers[0].allowedTools).toEqual(["mail/send_email"]);

    // Gate it again, then deny.
    await json(stage.u.peach, [
      "bot",
      "tools",
      "add",
      "toadsworth",
      "mail",
      "--no-allow",
    ]);
    const second = await parkOnSend();
    stage.models.play([replyStep("I will not send it.")]);
    const denied = await json(stage.u.peach, [
      "approval",
      "deny",
      String(second.approvalId),
      "--note",
      "Ask Toad in person",
    ]);
    expect(denied.approval).toMatchObject({
      status: "denied",
      decidedVia: "cli",
      note: "Ask Toad in person",
    });
    await runTicks();
    expect(stage.fixture.calls.map((c) => c.tool)).toEqual(["send_email"]);
    expect(stage.models.expectationFailures).toEqual([]);

    const decided = await as(stage.u.peach, [
      "approval",
      "deny",
      String(second.approvalId),
    ]);
    expect(decided.code).toBe(1);

    const badStatus = await as(stage.u.peach, [
      "approval",
      "list",
      "--status",
      "maybe",
    ]);
    expect(badStatus.code).toBe(1);
    expect(badStatus.stderr).toContain("--status is one of");
  });
});

describe("large-result view", () => {
  test("pages a result too long for the transcript, or prints it whole", async () => {
    await json(stage.u.peach, [
      "bot",
      "tools",
      "add",
      "toadsworth",
      "mail",
      "--allow",
      "mail/*",
    ]);
    stage.models.play([
      ...infoThenExec("mail/huge_report", { chars: 30_000 }),
      replyStep(),
    ]);
    const id = (await startConversation(stage, "Report")).body.conversation.id;
    await runTicks();
    const [exec] = await resultsOf(id, "mcp_exec");
    const ref = String(exec.id);
    expect(ref).toMatch(/^lr_\d+$/);

    const page = await json(stage.u.peach, [
      "large-result",
      "view",
      ref,
      "--limit",
      "100",
    ]);
    expect(page.largeResult).toMatchObject({
      conversationId: id,
      totalChars: 30_000,
    });
    expect(page.page).toMatchObject({ offset: 0, nextOffset: 100 });
    expect(page.page.text).toHaveLength(100);

    const whole = await json(stage.u.peach, [
      "large-result",
      "view",
      ref.slice(3),
      "--all",
      "--limit",
      "7000",
    ]);
    expect(whole.page.text).toHaveLength(30_000);
    expect(whole.page.nextOffset).toBeNull();

    const human = await as(stage.u.peach, [
      "large-result",
      "view",
      ref,
      "--limit",
      "50",
    ]);
    expect(human.stdout).toHaveLength(51);
    expect(human.stderr).toContain("--offset 50");

    const bad = await as(stage.u.peach, ["large-result", "view", "lr_x"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("lr_<id>");
  });
});

describe("credentials", () => {
  test("no secret handed to the CLI appears in anything it printed", () => {
    const all = printed.join("\n");
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain(BEARER);
    expect(all).not.toContain(HEADER_SECRET);
  });
});
