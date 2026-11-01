import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botBody } from "../src/commands/bot";
import { missingRequiredLine } from "../src/commands/model";
import {
  AVATAR_MAX_BYTES,
  encodeAvatar,
  imageMimeType,
  parseList,
  parseNumber,
  readSecret,
  type SecretSources,
} from "../src/input";

const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

describe("parseList", () => {
  test("splits on commas, trims, and drops blanks", () => {
    expect(parseList("operators, viewers,,")).toEqual(["operators", "viewers"]);
    expect(parseList("*")).toEqual(["*"]);
  });

  test("an empty string is the empty list: every member", () => {
    expect(parseList("")).toEqual([]);
    expect(parseList(" , ")).toEqual([]);
  });
});

describe("parseNumber", () => {
  test("parses decimals and refuses anything else, naming the flag", () => {
    expect(parseNumber("12.5", "--budget")).toBe(12.5);
    expect(() => parseNumber("lots", "--budget")).toThrow(
      '--budget takes a number; got "lots".',
    );
    expect(() => parseNumber("", "--temperature")).toThrow("--temperature");
  });
});

describe("avatars", () => {
  test("the type comes from the bytes, not the name", () => {
    expect(imageMimeType(PNG)).toBe("image/png");
    expect(imageMimeType(JPEG)).toBe("image/jpeg");
    expect(imageMimeType(new TextEncoder().encode("GIF89a"))).toBeNull();
  });

  test("a PNG or JPEG is base64-encoded; anything else or too large is refused", () => {
    expect(encodeAvatar(PNG, "a.png")).toBe(
      Buffer.from(PNG).toString("base64"),
    );
    expect(() =>
      encodeAvatar(new TextEncoder().encode("GIF89a"), "a.gif"),
    ).toThrow("a.gif is not a PNG or JPEG image.");
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1);
    big.set(PNG);
    expect(() => encodeAvatar(big, "big.png")).toThrow("at most 512 KB");
  });
});

/**
 * Secret sources with nothing given, on no terminal.
 * @param overrides - What a test changes.
 * @returns The sources.
 */
function sources(overrides: Partial<SecretSources> = {}): SecretSources {
  return {
    label: "API key",
    env: {},
    isTTY: false,
    readStdin: async () => {
      throw new Error("stdin was not asked for");
    },
    prompt: async () => {
      throw new Error("the prompt was not asked for");
    },
    ...overrides,
  };
}

describe("readSecret", () => {
  test("stdin loses its trailing newline", async () => {
    expect(
      await readSecret(
        sources({ fromStdin: true, readStdin: async () => "sk-abc\n" }),
      ),
    ).toBe("sk-abc");
  });

  test("a named environment variable, and a refusal when it is unset", async () => {
    expect(
      await readSecret(
        sources({ fromEnv: "MY_KEY", env: { MY_KEY: "sk-env" } }),
      ),
    ).toBe("sk-env");
    await expect(readSecret(sources({ fromEnv: "MY_KEY" }))).rejects.toThrow(
      "The environment variable MY_KEY is not set.",
    );
  });

  test("a terminal is prompted; no terminal and no source is refused", async () => {
    expect(
      await readSecret(
        sources({ isTTY: true, prompt: async () => "sk-typed" }),
      ),
    ).toBe("sk-typed");
    await expect(readSecret(sources())).rejects.toThrow("--api-key-stdin");
  });

  test("both sources, or an empty key, are refused", async () => {
    await expect(
      readSecret(sources({ fromStdin: true, fromEnv: "X" })),
    ).rejects.toThrow("not both");
    await expect(
      readSecret(sources({ fromStdin: true, readStdin: async () => "\n" })),
    ).rejects.toThrow("The API key is empty.");
  });
});

describe("botBody", () => {
  test("sends only the fields given", () => {
    expect(botBody({})).toEqual({});
    expect(
      botBody({
        name: "Ada",
        read: "operators,viewers",
        write: "",
        model: "reasoning",
        fastModel: "fast",
        budget: "25",
        maxSteps: "12",
        enable: true,
      }),
    ).toEqual({
      name: "Ada",
      accessRead: ["operators", "viewers"],
      accessWrite: [],
      modelAlias: "reasoning",
      fastModelAlias: "fast",
      monthlyBudgetUsd: 25,
      maxStepsPerTurn: 12,
      enabled: true,
    });
  });

  test("the --no-* flags send null, and --disable sends false", () => {
    expect(
      botBody({ helpTag: false, budget: false, avatar: false, disable: true }),
    ).toEqual({
      helpNotifyTag: null,
      monthlyBudgetUsd: null,
      avatar: null,
      enabled: false,
    });
    // `--no-avatar` alone defaults `avatar` to true, which changes nothing.
    expect(botBody({ avatar: true })).toEqual({});
  });

  test("reads the persona and the avatar from files", () => {
    const dir = mkdtempSync(join(tmpdir(), "hyp-bot-"));
    writeFileSync(join(dir, "persona.md"), "# Ada\nShe is kind.\n");
    writeFileSync(join(dir, "ada.jpg"), JPEG);
    expect(
      botBody({
        personaFile: join(dir, "persona.md"),
        avatarFile: join(dir, "ada.jpg"),
      }),
    ).toEqual({
      persona: "# Ada\nShe is kind.\n",
      avatar: Buffer.from(JPEG).toString("base64"),
    });
    expect(() => botBody({ personaFile: join(dir, "nope.md") })).toThrow(
      "--persona-file: cannot read",
    );
  });

  test("the sandbox flags set its policy and its per-job token budget", () => {
    expect(botBody({ sandbox: "allow", sandboxTokenBudget: "50000" })).toEqual({
      sandboxPolicy: "allow",
      sandboxJobTokenBudget: 50_000,
    });
    expect(botBody({ sandboxTokenBudget: false })).toEqual({
      sandboxJobTokenBudget: null,
    });
    expect(() => botBody({ sandbox: "sometimes" })).toThrow(
      "--sandbox takes one of off, approve, allow",
    );
  });

  test("contradictory flags are refused", () => {
    expect(() => botBody({ enable: true, disable: true })).toThrow("not both");
    expect(() => botBody({ avatarFile: "a.png", avatar: false })).toThrow(
      "not both",
    );
  });
});

describe("missingRequiredLine", () => {
  test("says nothing when both are set, and names what is missing otherwise", () => {
    expect(missingRequiredLine([])).toBe("");
    expect(missingRequiredLine(["default", "fast"])).toContain(
      "missing: default, fast",
    );
    expect(missingRequiredLine(["fast"])).toContain("until it is set");
  });
});
