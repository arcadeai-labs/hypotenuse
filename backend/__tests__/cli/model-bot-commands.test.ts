import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api } from "keryx";
import {
  type ModelServer,
  SCRIPTED_MODELS,
  startModelServer,
} from "../fixtures/model-server";
import {
  buildTestUniverse,
  cliSignIn,
  HOOK_TIMEOUT,
  type TestUniverse,
  type TestUser,
} from "../setup";

/**
 * `hypotenuse model …` and `hypotenuse bot …`, spawned from source against the
 * booted server, the Mushroom Kingdom, and the scripted model server: every
 * command once, its `--json` answer, and a refusal on stderr. An API key only
 * ever reaches the CLI on stdin or through an environment variable, and is
 * never printed back.
 */
const CLI = join(import.meta.dir, "..", "..", "..", "cli", "src", "cli.ts");
const KEY = "sk-scripted-cli-0123456789-SECRET-abcd";
const WRONG = "sk-scripted-cli-wrong-key-9876-wxyz";

let universe: TestUniverse;
let url: string;
let models: ModelServer;
let files: string;
const homes = new Map<string, string>();

/**
 * Give a person a config directory with a signed-in CLI.
 * @param user - Who.
 */
async function signIn(user: TestUser): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), "hyp-model-bot-"));
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

/**
 * A minimal PNG header the server can size: the signature and an `IHDR` chunk.
 * @param width - The width it claims.
 * @param height - The height it claims.
 * @returns The bytes.
 */
function pngHeader(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "latin1");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

beforeAll(async () => {
  universe = await buildTestUniverse();
  url = universe.url;
  models = startModelServer({ apiKey: KEY });
  for (const user of [universe.peach, universe.mario, universe.luigi]) {
    await signIn(user);
  }
  files = mkdtempSync(join(tmpdir(), "hyp-bot-files-"));
  writeFileSync(
    join(files, "ada.md"),
    "# Ada\n\nYou are Ada. You answer billing questions plainly.\n",
  );
  writeFileSync(join(files, "ada.png"), pngHeader(64, 64));
  writeFileSync(join(files, "wide.png"), pngHeader(64, 32));
}, HOOK_TIMEOUT);

afterAll(async () => {
  await models.stop();
  await api.stop();
}, HOOK_TIMEOUT);

/** What a spawned CLI may be given beyond its arguments. */
interface Spawn {
  /** Written to its standard input. */
  stdin?: string;
  /** Extra environment variables. */
  env?: Record<string, string>;
}

/**
 * Run the CLI as a person, in the Castle project.
 * @param user - Whose config directory to use.
 * @param args - Arguments after `hypotenuse --project <castle>`.
 * @param spawn - Standard input and extra environment.
 * @returns Exit code and captured output.
 */
async function as(user: TestUser, args: string[], spawn: Spawn = {}) {
  const proc = Bun.spawn(
    ["bun", "run", CLI, "--project", String(universe.projectId), ...args],
    {
      stdin: spawn.stdin !== undefined ? new Blob([spawn.stdin]) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        XDG_CONFIG_HOME: homes.get(user.email),
        BROWSER: "none",
        HYPOTENUSE_NO_UPDATE_CHECK: "1",
        HYPOTENUSE_URL: undefined,
        HYPOTENUSE_ORG: undefined,
        HYPOTENUSE_PROJECT: undefined,
        ...spawn.env,
      },
    },
  );
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const out = { code: await proc.exited, stdout, stderr };
  // Whatever happened, no key is ever printed back.
  for (const key of [KEY, WRONG]) {
    expect(out.stdout).not.toContain(key);
    expect(out.stderr).not.toContain(key);
  }
  return out;
}

/**
 * Run a command with `--json` that must succeed, and parse its answer.
 * @param user - Who.
 * @param args - Arguments after `hypotenuse --json`.
 * @param spawn - Standard input and extra environment.
 * @returns The parsed stdout.
 */
// biome-ignore lint/suspicious/noExplicitAny: each test reads the action's own shape.
async function json(
  user: TestUser,
  args: string[],
  spawn?: Spawn,
): Promise<any> {
  const out = await as(user, ["--json", ...args], spawn);
  if (out.code !== 0) {
    throw new Error(`hypotenuse ${args.join(" ")}: ${out.stderr}`);
  }
  return JSON.parse(out.stdout);
}

describe("model connection", () => {
  let connectionId: number;

  test("add reads the key from stdin, and list and view show only its last four", async () => {
    const added = await json(
      universe.peach,
      [
        "model",
        "connection",
        "add",
        "--name",
        "scripted",
        "--provider",
        "openai",
        "--base-url",
        models.baseUrl("openai"),
        "--api-key-stdin",
      ],
      { stdin: `${KEY}\n` },
    );
    connectionId = added.modelConnection.id;
    expect(added.modelConnection).toMatchObject({
      name: "scripted",
      provider: "openai",
      baseUrl: models.baseUrl("openai"),
      lastFour: "abcd",
      status: "unverified",
    });

    const list = await json(universe.peach, ["model", "connection", "list"]);
    expect(list.pagination).toMatchObject({ page: 1, limit: 25, total: 1 });
    expect(list.modelConnections[0].id).toBe(connectionId);

    const view = await json(universe.peach, [
      "model",
      "connection",
      "view",
      "scripted",
    ]);
    expect(view.modelConnection.id).toBe(connectionId);

    const human = await as(universe.peach, ["model", "connection", "list"]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("…abcd");
  });

  test("add reads the key from a named environment variable", async () => {
    const added = await json(
      universe.peach,
      [
        "model",
        "connection",
        "add",
        "--name",
        "spare",
        "--provider",
        "anthropic",
        "--base-url",
        models.baseUrl("anthropic"),
        "--api-key-env",
        "SCRIPTED_KEY",
      ],
      { env: { SCRIPTED_KEY: KEY } },
    );
    expect(added.modelConnection).toMatchObject({
      provider: "anthropic",
      lastFour: "abcd",
    });
  });

  test("with no key source and no terminal, add is refused before any request", async () => {
    const out = await as(universe.peach, [
      "model",
      "connection",
      "add",
      "--name",
      "keyless",
      "--provider",
      "openai",
    ]);
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr).toContain("--api-key-stdin");
  });

  test("a member who is not an admin is refused by the server, on stderr", async () => {
    const out = await as(
      universe.mario,
      [
        "model",
        "connection",
        "add",
        "--name",
        "mario",
        "--provider",
        "openai",
        "--api-key-stdin",
      ],
      { stdin: KEY },
    );
    expect(out.code).toBe(1);
    expect(out.stdout).toBe("");
    expect(out.stderr.length).toBeGreaterThan(0);
  });

  test("test probes it; a rotated wrong key fails the probe and exits 1", async () => {
    const ok = await json(universe.peach, [
      "model",
      "connection",
      "test",
      String(connectionId),
    ]);
    expect(ok.modelConnection.status).toBe("ok");

    const rotated = await json(
      universe.peach,
      ["model", "connection", "rotate", "scripted", "--api-key-stdin"],
      { stdin: WRONG },
    );
    expect(rotated.modelConnection).toMatchObject({
      status: "unverified",
      lastFour: "wxyz",
    });

    const failed = await as(universe.peach, [
      "--json",
      "model",
      "connection",
      "test",
      "scripted",
    ]);
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout).modelConnection.status).toBe("error");

    await json(
      universe.peach,
      ["model", "connection", "rotate", "scripted", "--api-key-env", "K"],
      { env: { K: KEY } },
    );
    const human = await as(universe.peach, [
      "model",
      "connection",
      "test",
      "scripted",
    ]);
    expect(human.code).toBe(0);
    expect(human.stdout).toContain("scripted: ok");
  });

  test("models lists what the provider offers", async () => {
    const listed = await json(universe.peach, [
      "model",
      "connection",
      "models",
      "scripted",
    ]);
    expect(listed.models.map((m: { id: string }) => m.id)).toEqual(
      SCRIPTED_MODELS.map((m) => m.id),
    );
  });

  test("edit renames it and returns it to the provider's default base URL", async () => {
    const renamed = await json(universe.peach, [
      "model",
      "connection",
      "edit",
      "spare",
      "--name",
      "spare-anthropic",
      "--default-base-url",
    ]);
    expect(renamed.modelConnection).toMatchObject({
      name: "spare-anthropic",
      baseUrl: null,
    });
  });
});

describe("model alias", () => {
  test("list names the missing required aliases, in JSON and for a person", async () => {
    const empty = await json(universe.peach, ["model", "alias", "list"]);
    expect(empty.modelAliases).toEqual([]);
    expect(empty.missingRequired).toEqual(["default", "fast"]);

    const human = await as(universe.peach, ["model", "alias", "list"]);
    expect(human.stdout).toContain("missing: default, fast");
  });

  test("set creates an alias, and set again changes it, keeping options not named", async () => {
    const created = await json(universe.peach, [
      "model",
      "alias",
      "set",
      "default",
      "--connection",
      "scripted",
      "--model",
      "scripted-large",
    ]);
    expect(created.modelAlias).toMatchObject({
      name: "default",
      reserved: true,
      connectionName: "scripted",
      modelId: "scripted-large",
    });

    const fast = await json(universe.peach, [
      "model",
      "alias",
      "set",
      "fast",
      "--connection",
      "scripted",
      "--model",
      "scripted-small",
      "--max-output-tokens",
      "2000",
      "--temperature",
      "0.2",
    ]);
    expect(fast.modelAlias.options).toEqual({
      maxOutputTokens: 2000,
      temperature: 0.2,
    });

    const edited = await json(universe.peach, [
      "model",
      "alias",
      "set",
      "fast",
      "--temperature",
      "0.5",
    ]);
    expect(edited.modelAlias.id).toBe(fast.modelAlias.id);
    expect(edited.modelAlias.options).toEqual({
      maxOutputTokens: 2000,
      temperature: 0.5,
    });

    const full = await json(universe.peach, ["model", "alias", "list"]);
    expect(full.missingRequired).toEqual([]);
    expect(
      full.modelAliases.map((a: { name: string }) => a.name).slice(0, 2),
    ).toEqual(["default", "fast"]);
    const human = await as(universe.peach, ["model", "alias", "list"]);
    expect(human.stdout).not.toContain("missing:");
  });

  test("a new alias without --connection and --model is refused", async () => {
    const out = await as(universe.peach, [
      "model",
      "alias",
      "set",
      "reasoning",
      "--model",
      "scripted-large",
    ]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("needs --connection and --model");
  });

  test("a connection an alias uses cannot be removed; an unused alias and connection can", async () => {
    const inUse = await as(universe.peach, [
      "model",
      "connection",
      "remove",
      "scripted",
    ]);
    expect(inUse.code).toBe(1);
    expect(inUse.stderr).toContain("default");

    await json(universe.peach, [
      "model",
      "alias",
      "set",
      "reasoning",
      "--connection",
      "spare-anthropic",
      "--model",
      "scripted-large",
    ]);
    const removed = await json(universe.peach, [
      "model",
      "alias",
      "remove",
      "reasoning",
    ]);
    expect(removed.modelAlias.name).toBe("reasoning");
    const gone = await json(universe.peach, [
      "model",
      "connection",
      "remove",
      "spare-anthropic",
    ]);
    expect(gone.modelConnection.name).toBe("spare-anthropic");
  });
});

describe("bot", () => {
  let botId: number;

  test("create reads the persona and avatar from files", async () => {
    const created = await json(universe.peach, [
      "bot",
      "create",
      "--name",
      "Ada",
      "--description",
      "Answers billing questions",
      "--persona-file",
      join(files, "ada.md"),
      "--avatar-file",
      join(files, "ada.png"),
      "--read",
      "operators",
      "--write",
      "operators",
      "--help-tag",
      "operators",
      "--budget",
      "25",
    ]);
    botId = created.bot.id;
    expect(created.bot).toMatchObject({
      name: "Ada",
      slug: "ada",
      displayName: "Ada",
      description: "Answers billing questions",
      persona: "# Ada\n\nYou are Ada. You answer billing questions plainly.",
      modelAlias: "default",
      fastModelAlias: "fast",
      accessRead: ["operators"],
      accessWrite: ["operators"],
      helpNotifyTag: "operators",
      monthlyBudgetUsd: 25,
      enabled: true,
      avatarMimeType: "image/png",
    });
    expect(created.standing.canWrite).toBe(true);
  });

  test("create needs a persona file, and the server refuses a non-square avatar", async () => {
    const noPersona = await as(universe.peach, [
      "bot",
      "create",
      "--name",
      "Blank",
    ]);
    expect(noPersona.code).toBe(1);
    expect(noPersona.stderr).toContain("--persona-file");

    const wide = await as(universe.peach, [
      "bot",
      "create",
      "--name",
      "Wide",
      "--persona-file",
      join(files, "ada.md"),
      "--avatar-file",
      join(files, "wide.png"),
    ]);
    expect(wide.code).toBe(1);
    expect(wide.stderr).toContain("square");
  });

  test("list and view show readable bots; a reader without the tag is told it does not exist", async () => {
    const list = await json(universe.mario, ["bot", "list"]);
    expect(list.pagination.total).toBe(1);
    expect(list.bots[0]).toMatchObject({
      id: botId,
      standing: { canWrite: true },
    });

    const view = await json(universe.mario, ["bot", "view", "ada"]);
    expect(view.bot.id).toBe(botId);
    const human = await as(universe.mario, ["bot", "view", String(botId)]);
    expect(human.stdout).toContain("You are Ada.");
    expect(human.stdout).toContain("read and change it");

    const luigi = await json(universe.luigi, ["bot", "list"]);
    expect(luigi.bots).toEqual([]);
    const hidden = await as(universe.luigi, ["bot", "view", String(botId)]);
    expect(hidden.code).toBe(1);
    expect(hidden.stdout).toBe("");
  });

  test("edit changes only the flags given, and the --no-* flags clear", async () => {
    const edited = await json(universe.mario, [
      "bot",
      "edit",
      "ada",
      "--display-name",
      "Ada Lovelace",
      "--disable",
      "--no-help-tag",
      "--no-budget",
      "--no-avatar",
      "--read",
      "",
    ]);
    expect(edited.bot).toMatchObject({
      name: "Ada",
      displayName: "Ada Lovelace",
      enabled: false,
      helpNotifyTag: null,
      monthlyBudgetUsd: null,
      avatarUrl: null,
      accessRead: [],
      accessWrite: ["operators"],
    });
  });

  test("the server refuses a write list that would lock the editor out", async () => {
    const out = await as(universe.mario, [
      "bot",
      "edit",
      "ada",
      "--write",
      "viewers",
    ]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain("lock you out");
  });

  test("delete needs --yes, then deletes", async () => {
    const unconfirmed = await as(universe.mario, ["bot", "delete", "ada"]);
    expect(unconfirmed.code).toBe(1);
    expect(unconfirmed.stderr).toContain("--yes");

    const deleted = await json(universe.mario, [
      "bot",
      "delete",
      "ada",
      "--yes",
    ]);
    expect(deleted.bot.id).toBe(botId);
    const after = await json(universe.peach, ["bot", "list"]);
    expect(after.bots).toEqual([]);
  });
});
