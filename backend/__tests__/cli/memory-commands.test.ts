import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "keryx";
import { clearLoopQueues, startConversation } from "../agent/harness";
import {
  buildMemoryStage,
  channelOf,
  clearMemory,
  type MemoryStage,
  runMemoryJobs,
} from "../memory/harness";
import { cliSignIn, HOOK_TIMEOUT, type TestUser } from "../setup";

/**
 * `hypotenuse memory …`, the bot half-life flags, and `model alias set
 * --kind`, spawned from source against the booted server and the memory
 * stage (a bot, Toadsworth, and an `embedding` alias on the scripted model
 * server): every command once, its `--json` answer, what a person reads, and
 * refusals — the CLI's own before any request, the server's on stderr.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");

let stage: MemoryStage;
let channelId: number;
const homes = new Map<string, string>();

/**
 * Give a person a config directory with a signed-in CLI.
 * @param user - Who.
 */
async function signIn(user: TestUser): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "hyp-memory-"));
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
  stage = await buildMemoryStage();
  // An embed mark left in Redis by an earlier run would swallow this run's.
  await clearMemory();
  for (const user of [stage.u.peach, stage.u.mario]) await signIn(user);
  // A conversation gives Toadsworth an API channel to remember; its tick is
  // never run, so no model is asked anything.
  const started = await startConversation(stage, "Hello", {
    channelKey: "war-room",
  });
  if (started.status !== 200) throw new Error(JSON.stringify(started.body));
  channelId = await channelOf(started.body.conversation.id);
  await clearLoopQueues();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await clearLoopQueues();
  await clearMemory();
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

/** The flags that name Toadsworth's memory of the war room. */
const inWarRoom = () => ["--bot", "toadsworth", "--channel", String(channelId)];

const DEPLOY =
  "# Deploys\n\nDeploys go out on Tuesdays after the castle standup.\n";

describe("project memory", () => {
  let first: number;

  test("write reads the document from stdin; list, view, and versions show it", async () => {
    const written = await json(
      stage.u.peach,
      [
        "memory",
        "write",
        "facts/deploys.md",
        "--text",
        "-",
        "--note",
        "From the runbook",
      ],
      DEPLOY,
    );
    first = written.document.versionId;
    expect(written.document).toMatchObject({
      scope: "project",
      path: "facts/deploys.md",
      content: DEPLOY,
      description: "Deploys",
      changeNote: "From the runbook",
      sourceType: "person",
      current: true,
    });

    const list = await json(stage.u.peach, ["memory", "list"]);
    expect(list.pagination).toMatchObject({ page: 1, limit: 25, total: 1 });
    expect(list.documents[0]).toMatchObject({
      path: "facts/deploys.md",
      versionId: first,
    });
    expect(list.index.embeddingModel).toBe("scripted-embed");

    const view = await json(stage.u.mario, [
      "memory",
      "view",
      "facts/deploys.md",
    ]);
    expect(view.document.content).toBe(DEPLOY);
    // A member reads project memory; only an admin changes it.
    expect(view.standing).toEqual({ canWrite: false, canPromote: false });

    const person = await as(stage.u.peach, [
      "memory",
      "view",
      "facts/deploys.md",
    ]);
    expect(person.code).toBe(0);
    expect(person.stdout).toContain("project:facts/deploys.md");
    expect(person.stdout).toContain(`version       ${first}`);
    expect(person.stdout).toContain("change note   From the runbook");
    expect(person.stdout).toContain("Deploys go out on Tuesdays");
  });

  test("write --base refuses a stale base; a fresh one makes a second version", async () => {
    const changed = await json(stage.u.peach, [
      "memory",
      "write",
      "facts/deploys.md",
      "--text",
      "# Deploys\n\nDeploys go out on Wednesdays now.\n",
      "--base",
      String(first),
      "--description",
      "When deploys happen",
    ]);
    expect(changed.document.versionId).not.toBe(first);

    const stale = await as(stage.u.peach, [
      "memory",
      "write",
      "facts/deploys.md",
      "--text",
      "Thursdays",
      "--base",
      String(first),
    ]);
    expect(stale.code).toBe(1);
    expect(stale.stderr).toContain(`changed since version ${first}`);

    const versions = await json(stage.u.peach, [
      "memory",
      "versions",
      "facts/deploys.md",
    ]);
    expect(versions.pagination.total).toBe(2);
    expect(
      versions.versions.map((v: { current: boolean }) => v.current),
    ).toEqual([true, false]);

    const old = await json(stage.u.peach, [
      "memory",
      "view",
      "facts/deploys.md",
      "--version-id",
      String(first),
    ]);
    expect(old.document).toMatchObject({ versionId: first, current: false });
    expect(old.document.content).toContain("Tuesdays");
  });

  test("search finds it, hybrid once embedded, and a person reads score, path, and snippet", async () => {
    await runMemoryJobs();
    const result = await json(stage.u.peach, [
      "memory",
      "search",
      "when do deploys go out",
    ]);
    expect(result.mode).toBe("hybrid");
    expect(result.hits[0]).toMatchObject({
      path: "facts/deploys.md",
      scope: "project",
    });

    const person = await as(stage.u.peach, ["memory", "search", "Wednesdays"]);
    expect(person.code).toBe(0);
    expect(person.stdout).toMatch(/SCORE\s+SCOPE\s+PATH\s+DECAY\s+SNIPPET/);
    expect(person.stdout).toContain("facts/deploys.md");
    expect(person.stdout).toContain("Wednesdays");
  });

  test("pin and --unpin; forget hides it from list and search but not from --forgotten", async () => {
    const pinned = await json(stage.u.peach, [
      "memory",
      "pin",
      "facts/deploys.md",
    ]);
    expect(pinned.document.pinned).toBe(true);
    const person = await as(stage.u.peach, ["memory", "list"]);
    expect(person.stdout).toMatch(/facts\/deploys\.md.*pinned/);

    const unpinned = await json(stage.u.peach, [
      "memory",
      "pin",
      "facts/deploys.md",
      "--unpin",
    ]);
    expect(unpinned.document.pinned).toBe(false);

    const forgot = await as(stage.u.peach, [
      "memory",
      "forget",
      "facts/deploys.md",
      "--reason",
      "Out of date",
    ]);
    expect(forgot.code).toBe(0);
    expect(forgot.stdout).toBe("Forgot project:facts/deploys.md\n");

    expect((await json(stage.u.peach, ["memory", "list"])).documents).toEqual(
      [],
    );
    expect(
      (await json(stage.u.peach, ["memory", "search", "Wednesdays"])).hits,
    ).toEqual([]);
    const all = await json(stage.u.peach, ["memory", "list", "--forgotten"]);
    expect(all.documents[0]).toMatchObject({
      path: "facts/deploys.md",
      forgotten: true,
    });
  });

  test("a member who is not an admin is refused project writes by the server", async () => {
    const out = await as(stage.u.mario, [
      "memory",
      "write",
      "facts/mario.md",
      "--text",
      "Mario was here",
    ]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("only a project admin changes it");
  });
});

describe("channel memory", () => {
  test("channels lists the bot's channels; write and list act on its memory of one", async () => {
    const before = await json(stage.u.mario, [
      "memory",
      "channels",
      "--bot",
      "toadsworth",
    ]);
    expect(before.channels).toEqual([
      expect.objectContaining({ id: channelId, documents: 0 }),
    ]);

    // Anyone who may change the bot may change its channel memory.
    const written = await json(stage.u.mario, [
      "memory",
      "write",
      "facts/cannon.md",
      ...inWarRoom(),
      "--text",
      "The castle cannon fires at noon.",
    ]);
    expect(written.document).toMatchObject({
      scope: "channel",
      channelId,
      path: "facts/cannon.md",
    });

    const list = await json(stage.u.mario, ["memory", "list", ...inWarRoom()]);
    expect(list.documents.map((d: { path: string }) => d.path)).toEqual([
      "facts/cannon.md",
    ]);
    expect(list.halfLifeDays).toEqual({ channel: 30, project: 180 });
    const after = await json(stage.u.mario, [
      "memory",
      "channels",
      "--bot",
      String(stage.botId),
    ]);
    expect(after.channels[0].documents).toBe(1);
  });

  test("search --scope both reads the channel and the project; project scope alone does not see the channel", async () => {
    await json(stage.u.peach, [
      "memory",
      "write",
      "facts/moat.md",
      "--text",
      "The moat around the castle is drained in winter.",
    ]);
    await runMemoryJobs();
    const both = await json(stage.u.peach, [
      "memory",
      "search",
      "castle",
      ...inWarRoom(),
      "--scope",
      "both",
    ]);
    expect(
      both.hits
        .map((h: { scope: string; path: string }) => `${h.scope}:${h.path}`)
        .sort(),
    ).toEqual(["channel:facts/cannon.md", "project:facts/moat.md"]);

    const project = await json(stage.u.peach, ["memory", "search", "castle"]);
    expect(project.hits.map((h: { path: string }) => h.path)).toEqual([
      "facts/moat.md",
    ]);
  });

  test("promote copies it to project memory under --to, citing the channel version", async () => {
    const out = await as(stage.u.peach, [
      "memory",
      "promote",
      "facts/cannon.md",
      ...inWarRoom(),
      "--to",
      "facts/castle-cannon.md",
    ]);
    expect(out.code).toBe(0);
    expect(out.stdout).toContain(
      `Promoted channel ${channelId}:facts/cannon.md to project:facts/castle-cannon.md`,
    );

    const view = await json(stage.u.peach, [
      "memory",
      "view",
      "facts/castle-cannon.md",
    ]);
    expect(view.document).toMatchObject({
      scope: "project",
      sourceType: "promotion",
      content: "The castle cannon fires at noon.",
    });
    expect(view.document.provenance).toMatchObject({
      promotedFromBotId: stage.botId,
      promotedFromChannelId: channelId,
    });
    // The channel copy stays.
    const channel = await json(stage.u.peach, [
      "memory",
      "view",
      "facts/cannon.md",
      ...inWarRoom(),
    ]);
    expect(channel.document.current).toBe(true);
    expect(channel.standing).toEqual({ canWrite: true, canPromote: true });
  });

  test("promote needs admin standing as well as the bot's write access", async () => {
    const out = await as(stage.u.mario, [
      "memory",
      "promote",
      "facts/cannon.md",
      ...inWarRoom(),
    ]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("only a project admin changes it");
  });
});

describe("refusals before any request", () => {
  test("--bot without --channel, a bad --channel, and an unknown --scope", async () => {
    const half = await as(stage.u.peach, [
      "memory",
      "view",
      "facts/cannon.md",
      "--bot",
      "toadsworth",
    ]);
    expect(half.code).toBe(1);
    expect(half.stderr).toContain("pass both --bot and --channel");

    const word = await as(stage.u.peach, [
      "memory",
      "list",
      "--bot",
      "toadsworth",
      "--channel",
      "war-room",
    ]);
    expect(word.code).toBe(1);
    expect(word.stderr).toContain("--channel takes a channel's id");

    const scope = await as(stage.u.peach, [
      "memory",
      "search",
      "castle",
      "--scope",
      "everywhere",
    ]);
    expect(scope.code).toBe(1);
    expect(scope.stderr).toContain("--scope is one of channel, project, both");

    const lonely = await as(stage.u.peach, [
      "memory",
      "search",
      "castle",
      "--scope",
      "both",
    ]);
    expect(lonely.code).toBe(1);
    expect(lonely.stderr).toContain("pass --bot and --channel too");

    const empty = await as(
      stage.u.peach,
      ["memory", "write", "facts/empty.md", "--text", "-"],
      "  \n",
    );
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("Standard input was empty");
  });
});

describe("reindex", () => {
  test("an admin reindexes and is told what was queued; a member is refused", async () => {
    // The promoted copy has not been embedded yet.
    const pending = await json(stage.u.peach, ["memory", "reindex"]);
    expect(pending.embeddingModel).toBe("scripted-embed");
    expect(pending.queuedChunks).toBeGreaterThan(0);
    const queued = await as(stage.u.peach, ["memory", "reindex"]);
    expect(queued.stdout).toBe(
      `Queued ${pending.queuedChunks} chunk${pending.queuedChunks === 1 ? "" : "s"} for scripted-embed; search ranks them by keyword until they are embedded\n`,
    );

    await runMemoryJobs();
    expect(await json(stage.u.peach, ["memory", "reindex"])).toEqual({
      embeddingModel: "scripted-embed",
      queuedChunks: 0,
    });
    const person = await as(stage.u.peach, ["memory", "reindex"]);
    expect(person.stdout).toBe(
      "Every chunk is already embedded with scripted-embed\n",
    );

    const refused = await as(stage.u.mario, ["memory", "reindex"]);
    expect(refused.code).toBe(1);
  });
});

describe("bot half-lives and alias kinds", () => {
  test("bot edit sets each half-life, and bot view shows them", async () => {
    const edited = await json(stage.u.peach, [
      "bot",
      "edit",
      "toadsworth",
      "--channel-half-life",
      "7",
      "--project-half-life",
      "365",
    ]);
    expect(edited.bot).toMatchObject({
      memoryChannelHalfLifeDays: 7,
      memoryProjectHalfLifeDays: 365,
    });
    const view = await as(stage.u.peach, ["bot", "view", "toadsworth"]);
    expect(view.stdout).toContain(
      "half-life     7 days channel memory, 365 days project memory",
    );
    const list = await json(stage.u.peach, ["memory", "list", ...inWarRoom()]);
    expect(list.halfLifeDays).toEqual({ channel: 7, project: 365 });

    const tooLong = await as(stage.u.peach, [
      "bot",
      "edit",
      "toadsworth",
      "--channel-half-life",
      "5000",
    ]);
    expect(tooLong.code).toBe(1);
  });

  test("alias list shows each kind; set --kind is checked here and by the server", async () => {
    const list = await json(stage.u.peach, ["model", "alias", "list"]);
    expect(
      Object.fromEntries(
        list.modelAliases.map((a: { name: string; kind: string }) => [
          a.name,
          a.kind,
        ]),
      ),
    ).toEqual({
      default: "language",
      fast: "language",
      embedding: "embedding",
    });

    const unknown = await as(stage.u.peach, [
      "model",
      "alias",
      "set",
      "vectors",
      "--kind",
      "vector",
    ]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain("--kind is one of language, embedding");

    const change = await as(stage.u.peach, [
      "model",
      "alias",
      "set",
      "embedding",
      "--kind",
      "language",
    ]);
    expect(change.code).toBe(1);
    expect(change.stderr).toContain("an alias's kind cannot change");

    const misnamed = await as(stage.u.peach, [
      "model",
      "alias",
      "set",
      "vectors",
      "--kind",
      "embedding",
      "--connection",
      String(stage.embeddingConnectionId),
      "--model",
      "scripted-embed",
    ]);
    expect(misnamed.code).toBe(1);
    expect(misnamed.stderr).toContain(
      'An embedding model is named "embedding"',
    );
  });
});
