import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import { type ActionResponse, api, config } from "keryx";
import type { BotCreate } from "../../actions/bot/bot-create";
import { conversationEntries } from "../../schema/conversation_entries";
import { githubInstallations } from "../../schema/github_installations";
import { repositoryGrants } from "../../schema/repository_grants";
import {
  type AgentStage,
  buildAgentStage,
  clearLoopQueues,
  runTicks,
  startConversation,
} from "../agent/harness";
import { FakeGitHub } from "../fakes/github/server";
import { call, HOOK_TIMEOUT } from "../setup";

/**
 * The GitHub read tools, run by the real tick through the scripted model,
 * against the GitHub fake: each reads only a repository granted to the
 * calling bot, through a token minted for that one call, scoped to that one
 * repository at `read`, and revoked when the call ends.
 *
 * Coverage matrix rows: `github.out.contents` (`github_file_read`),
 * `github.out.search-code` (`github_search_code`), `github.out.pull`
 * (`github_pr_view`), `github.out.issue` (`github_issue_view`).
 */

const github = new FakeGitHub();
const saved = { ...config.github };
let stage: AgentStage;
/** A second bot, the only one granted `acme/secret`. */
let otherBotId: number;
/** A third bot with no grants at all. */
let lonelyBotId: number;

const GITHUB_TOOLS = [
  "github_file_read",
  "github_issue_view",
  "github_pr_view",
  "github_search_code",
];

/**
 * Create a bot over HTTP.
 * @param name - Its name.
 * @returns Its id.
 */
async function createBot(name: string): Promise<number> {
  const res = await call<ActionResponse<BotCreate>>(
    stage.u.url,
    stage.u.peach,
    "PUT",
    `/project/${stage.u.projectId}/bot`,
    { name, persona: "You read code." },
  );
  if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  return res.body.bot.id;
}

beforeAll(async () => {
  stage = await buildAgentStage("anthropic");
  await github.start();
  github.configure(config.github as unknown as Record<string, unknown>);
  github.install({
    id: "7001",
    login: "acme",
    repositories: ["api", "secret"],
  });
  await github.createRepository("acme", "api", {
    "README.md": "# api\n\nThe castle's API.\n",
    "src/app.ts": "export const princess = 'peach';\n",
    "src/lib/util.ts": "export const plumber = 'mario';\n",
    "big.txt": `${"0123456789".repeat(100)}TAIL-MARKER\n`,
    "logo.bin": "\u0000\u0001\u0002PNG\u0000",
  });
  await github.createRepository("acme", "secret", {
    "README.md": "# secret\n\nBowser's plans.\n",
  });
  github.openPull({
    owner: "acme",
    name: "api",
    title: "Rescue the princess",
    body: "Moves the princess to a safer castle.",
    head: "hypotenuse/toadsworth/rescue",
    base: "main",
    author: "mario",
  });

  otherBotId = await createBot("Kamek");
  lonelyBotId = await createBot("Lakitu");

  const [installation] = await api.db.db
    .insert(githubInstallations)
    .values({
      projectId: stage.u.projectId,
      installationId: "7001",
      accountLogin: "acme",
      accountType: "Organization",
      permissions: { contents: "write", metadata: "read" },
    })
    .returning();
  await api.db.db.insert(repositoryGrants).values([
    {
      projectId: stage.u.projectId,
      githubInstallationId: installation.id,
      owner: "acme",
      name: "api",
      botIds: [stage.botId, otherBotId],
    },
    {
      projectId: stage.u.projectId,
      githubInstallationId: installation.id,
      owner: "acme",
      name: "secret",
      botIds: [otherBotId],
    },
  ]);
}, HOOK_TIMEOUT);

afterEach(async () => {
  await clearLoopQueues();
  config.github.maxFileBytes = saved.maxFileBytes;
  expect(stage.models.expectationFailures).toEqual([]);
  stage.models.reset();
});

afterAll(async () => {
  Object.assign(config.github, saved);
  await github.stop();
  await stage.models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/**
 * Have the bot call one tool, then reply, through the real tick.
 * @param name - The tool.
 * @param input - Its input.
 * @param botId - The bot (the stage's by default).
 * @returns The stored output of the call.
 */
async function runTool(
  name: string,
  input: Record<string, unknown>,
  botId = stage.botId,
): Promise<Record<string, unknown>> {
  stage.models.play([
    { toolCalls: [{ name, input }] },
    { toolCalls: [{ name: "reply_and_wait", input: { text: "Done." } }] },
  ]);
  const res = await startConversation({ ...stage, botId }, "Have a look.");
  expect(res.status).toBe(200);
  await runTicks();
  const [result] = await api.db.db
    .select()
    .from(conversationEntries)
    .where(
      and(
        eq(conversationEntries.conversationId, res.body.conversation.id),
        eq(conversationEntries.kind, "tool_result"),
        eq(conversationEntries.toolName, name),
      ),
    );
  expect(result).toBeDefined();
  return (result.content as { output: Record<string, unknown> }).output;
}

/**
 * Every token minted since a mark names exactly one repository at read and
 * was revoked.
 * @param from - How many mints there were before.
 * @param repository - The repository the call named.
 * @param permission - The permission it needed beside `metadata`.
 */
function expectScopedAndRevoked(
  from: number,
  repository: string,
  permission: string,
): void {
  const minted = github.mints.slice(from);
  expect(minted).toHaveLength(1);
  expect(minted[0].repositories).toEqual([repository]);
  expect(minted[0].permissions).toEqual({
    metadata: "read",
    [permission]: "read",
  });
  const tokens = github.tokens.slice(-1);
  expect(tokens[0].repositories).toEqual([repository]);
  expect(github.revocations).toContain(tokens[0].token);
  expect(tokens[0].revoked).toBe(true);
}

describe("availability", () => {
  test("a bot with a grant is offered the four tools; a bot with none is not", async () => {
    await runTool("github_search_code", {
      repository: "acme/api",
      query: "princess",
    });
    const offered = (stage.models.completions[0]?.body.tools ?? []).map(
      (t) => t.name ?? t.function?.name,
    );
    for (const name of GITHUB_TOOLS) expect(offered).toContain(name);

    stage.models.reset();
    stage.models.play([
      { toolCalls: [{ name: "reply_and_wait", input: { text: "Hi." } }] },
    ]);
    const res = await startConversation(
      { ...stage, botId: lonelyBotId },
      "Hello?",
    );
    expect(res.status).toBe(200);
    await runTicks();
    const lonely = (stage.models.completions[0]?.body.tools ?? []).map(
      (t) => t.name ?? t.function?.name,
    );
    expect(lonely).toContain("reply_and_wait");
    for (const name of GITHUB_TOOLS) expect(lonely).not.toContain(name);
  });
});

describe("github.out.contents — github_file_read", () => {
  test("reads a file as text through a one-repository read token, revoked after", async () => {
    const mark = github.mints.length;
    const out = await runTool("github_file_read", {
      repository: "acme/api",
      path: "src/app.ts",
    });
    expect(out).toMatchObject({
      kind: "file",
      repository: "acme/api",
      path: "src/app.ts",
      text: "export const princess = 'peach';\n",
      truncated: false,
    });
    expectScopedAndRevoked(mark, "api", "contents");
  });

  test("an empty path lists the root, a directory path lists it, and a ref is honoured", async () => {
    const root = await runTool("github_file_read", {
      repository: "Acme/API",
      path: "",
      ref: "main",
    });
    expect(root.kind).toBe("dir");
    const names = (root.entries as { name: string; type: string }[]).map(
      (e) => `${e.name}:${e.type}`,
    );
    expect(names).toEqual(
      expect.arrayContaining(["README.md:file", "src:dir", "big.txt:file"]),
    );
    const src = await runTool("github_file_read", {
      repository: "acme/api",
      path: "src",
    });
    expect(
      (src.entries as { path: string }[]).map((e) => e.path).sort(),
    ).toEqual(["src/app.ts", "src/lib"]);
  });

  test("a file over the cap is cut, and says so", async () => {
    config.github.maxFileBytes = 64;
    const out = await runTool("github_file_read", {
      repository: "acme/api",
      path: "big.txt",
    });
    expect(out.kind).toBe("file");
    expect(out.truncated).toBe(true);
    expect((out.text as string).length).toBe(64);
    expect(out.text).not.toContain("TAIL-MARKER");
    expect(out.size).toBe(1012);
    expect(out.note).toContain("Cut");
    expect(out.note).toContain("64 of 1012 bytes");
  });

  test("a binary file is refused, politely", async () => {
    const out = await runTool("github_file_read", {
      repository: "acme/api",
      path: "logo.bin",
    });
    expect(out).toMatchObject({ is_error: true, error_type: "binary_file" });
    expect(out.next_action_hint).toContain("sandbox");
  });

  test("a missing file is not_found, and the token is still revoked", async () => {
    const mark = github.mints.length;
    const out = await runTool("github_file_read", {
      repository: "acme/api",
      path: "src/nope.ts",
    });
    expect(out).toMatchObject({ is_error: true, error_type: "not_found" });
    expect(out.message).toContain("src/nope.ts");
    expectScopedAndRevoked(mark, "api", "contents");
  });
});

describe("github.out.search-code — github_search_code", () => {
  test("answers matching paths and links, with the repository qualifier added (and the model's dropped)", async () => {
    const mark = github.mints.length;
    const out = await runTool("github_search_code", {
      repository: "acme/api",
      query: "plumber repo:acme/secret",
    });
    expect(out).toMatchObject({ repository: "acme/api", total: 1 });
    expect(out.items).toEqual([
      {
        path: "src/lib/util.ts",
        url: `${github.url}/acme/api/blob/main/src/lib/util.ts`,
      },
    ]);
    const search = github.requests.filter((r) => r.path === "/search/code");
    const q = new URLSearchParams(search[search.length - 1].search).get("q");
    expect(q).toBe("plumber repo:acme/api");
    expectScopedAndRevoked(mark, "api", "contents");
  });
});

describe("github.out.pull — github_pr_view", () => {
  test("reads the title, state, branches, author, body, and link", async () => {
    const mark = github.mints.length;
    const out = await runTool("github_pr_view", {
      repository: "acme/api",
      number: 1,
    });
    expect(out).toEqual({
      repository: "acme/api",
      number: 1,
      title: "Rescue the princess",
      status: "open",
      merged: false,
      draft: false,
      headRef: "hypotenuse/toadsworth/rescue",
      baseRef: "main",
      author: "mario",
      body: "Moves the princess to a safer castle.",
      url: `${github.url}/acme/api/pull/1`,
    });
    expectScopedAndRevoked(mark, "api", "pull_requests");
  });

  test("a number with no pull request is not_found", async () => {
    const out = await runTool("github_pr_view", {
      repository: "acme/api",
      number: 99,
    });
    expect(out).toMatchObject({ is_error: true, error_type: "not_found" });
  });
});

describe("github.out.issue — github_issue_view", () => {
  test("reads the title, state, author, body, labels, and link", async () => {
    const mark = github.mints.length;
    const out = await runTool("github_issue_view", {
      repository: "acme/api",
      number: 1,
    });
    expect(out).toMatchObject({
      repository: "acme/api",
      number: 1,
      title: "Rescue the princess",
      status: "open",
      author: "mario",
      body: "Moves the princess to a safer castle.",
      labels: [],
      isPullRequest: true,
      url: `${github.url}/acme/api/pull/1`,
    });
    expectScopedAndRevoked(mark, "api", "issues");
  });
});

describe("scope", () => {
  test("a repository granted only to another bot is not_granted, and nothing is minted for it", async () => {
    const mark = github.mints.length;
    for (const name of GITHUB_TOOLS) {
      const input: Record<string, unknown> =
        name === "github_file_read"
          ? { repository: "acme/secret", path: "README.md" }
          : name === "github_search_code"
            ? { repository: "acme/secret", query: "plans" }
            : { repository: "acme/secret", number: 1 };
      const out = await runTool(name, input);
      expect(out).toMatchObject({ is_error: true, error_type: "not_granted" });
      expect(out.message).toContain("acme/secret");
      expect(out.message).toContain("Repositories");
      expect(out.next_action_hint).toContain("acme/api");
      expect(out.next_action_hint).not.toContain("acme/secret,");
    }
    expect(github.mints.slice(mark)).toEqual([]);

    // The bot it was granted to reads it.
    const out = await runTool(
      "github_file_read",
      { repository: "acme/secret", path: "README.md" },
      otherBotId,
    );
    expect(out.text).toContain("Bowser's plans.");
    expectScopedAndRevoked(mark, "secret", "contents");
  });

  test("a name that is not owner/name is refused with the repositories it can read", async () => {
    const out = await runTool("github_pr_view", {
      repository: "api",
      number: 1,
    });
    expect(out).toMatchObject({
      is_error: true,
      error_type: "invalid_repository",
    });
    expect(out.next_action_hint).toContain("acme/api");
  });

  test("an App that is not configured is github_unavailable, with nothing minted", async () => {
    const mark = github.mints.length;
    config.github.appId = "";
    try {
      const out = await runTool("github_file_read", {
        repository: "acme/api",
        path: "README.md",
      });
      expect(out).toMatchObject({
        is_error: true,
        error_type: "github_unavailable",
      });
      expect(out.next_action_hint).toContain("Repositories");
    } finally {
      config.github.appId = github.appId;
    }
    expect(github.mints.slice(mark)).toEqual([]);
  });
});
