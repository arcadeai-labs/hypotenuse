/**
 * Turning what a person typed or pointed at into the values an action takes:
 * comma-separated tag lists, numbers, files, images, and secrets that must
 * never be typed as a flag (a flag lands in shell history and in `ps`).
 */
import { readFileSync } from "node:fs";
import { ExitError } from "./shutdown";

/** The most bytes an avatar may have; the server refuses anything larger. */
export const AVATAR_MAX_BYTES = 512 * 1024;

/**
 * Split a comma-separated list of tag names. Blank entries are dropped, so
 * `--read ""` is the empty list, which means every member.
 * @param raw - What the person typed, e.g. `operators, viewers`.
 * @returns The trimmed, non-empty names, in order.
 */
export function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Parse a number a person typed for a flag.
 * @param raw - What they typed.
 * @param flag - The flag's name, for the refusal.
 * @returns The number.
 * @throws {Error} When it is not a finite number.
 */
export function parseNumber(raw: string, flag: string): number {
  const value = Number(raw.trim());
  if (raw.trim() === "" || !Number.isFinite(value)) {
    throw new Error(`${flag} takes a number; got "${raw}".`);
  }
  return value;
}

/**
 * Collect a repeatable option's values, for commander.
 * @param value - This occurrence's value.
 * @param previous - The values so far.
 * @returns Every value, in order.
 */
export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

/**
 * Parse HTTP headers written `Name: value`, one per entry. Blank entries are
 * skipped, so a file of lines with a trailing newline works.
 * @param lines - The entries, from repeated flags or the lines of stdin.
 * @param flag - The flag they came from, for the refusal.
 * @returns The headers, by name.
 * @throws {Error} When an entry has no name or no colon.
 */
export function parseHeaders(
  lines: readonly string[],
  flag: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") continue;
    const colon = line.indexOf(":");
    const name = colon > 0 ? line.slice(0, colon).trim() : "";
    if (!name) {
      throw new Error(
        `${flag} takes "Name: value"; got an entry without a header name.`,
      );
    }
    headers[name] = line.slice(colon + 1).trim();
  }
  return headers;
}

/** Seconds in each unit a duration may be written in. */
const DURATION_UNITS: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86_400,
};

/**
 * Parse a duration a person typed: whole seconds, or a number with a unit
 * (`90s`, `30m`, `24h`, `7d`).
 * @param raw - What they typed.
 * @param flag - The flag's name, for the refusal.
 * @returns The duration in whole seconds.
 * @throws {Error} When it is not a positive duration.
 */
export function parseDuration(raw: string, flag: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([smhd])?$/i.exec(raw.trim());
  if (!match) {
    throw new Error(
      `${flag} takes seconds or a duration like 30m, 24h, or 7d; got "${raw}".`,
    );
  }
  const unit = DURATION_UNITS[(match[2] ?? "s").toLowerCase()] as number;
  return Math.round(Number(match[1]) * unit);
}

/**
 * The image type of a file, from its first bytes rather than its name.
 * @param bytes - The file's contents.
 * @returns `image/png`, `image/jpeg`, or null for anything else.
 */
export function imageMimeType(
  bytes: Uint8Array,
): "image/png" | "image/jpeg" | null {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((b, i) => bytes[i] === b)) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  return null;
}

/**
 * Encode an avatar file for `bot:create` / `bot:edit`: a PNG or JPEG of at
 * most 512 KB, base64. The server checks that it is square.
 * @param bytes - The file's contents.
 * @param path - The file's path, for the refusal.
 * @returns The base64 encoding.
 * @throws {Error} When it is not a PNG or JPEG, or is too large.
 */
export function encodeAvatar(bytes: Uint8Array, path: string): string {
  if (!imageMimeType(bytes)) {
    throw new Error(`${path} is not a PNG or JPEG image.`);
  }
  if (bytes.byteLength > AVATAR_MAX_BYTES) {
    throw new Error(
      `${path} is ${Math.ceil(bytes.byteLength / 1024)} KB; an avatar is at most 512 KB.`,
    );
  }
  return Buffer.from(bytes).toString("base64");
}

/**
 * Read a file a flag points at.
 * @param path - The path.
 * @param flag - The flag's name, for the refusal.
 * @returns The contents.
 * @throws {Error} When the file cannot be read.
 */
export function readFileFor(path: string, flag: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error) {
    throw new Error(
      `${flag}: cannot read ${path} (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
}

/** Where a secret may come from, and how to read each source. */
export interface SecretSources {
  /** What the secret is, for prompts and refusals ("API key"). */
  label: string;
  /** Read the secret from standard input. */
  fromStdin?: boolean;
  /** Read the secret from this environment variable. */
  fromEnv?: string;
  /** Environment variables. */
  env: Record<string, string | undefined>;
  /** Whether standard input is a terminal a person can type into. */
  isTTY: boolean;
  /** Read all of standard input. */
  readStdin: () => Promise<string>;
  /** Ask a person for it without echoing. */
  prompt: (question: string) => Promise<string>;
  /** The flags that name the two sources, for refusals (default the API key's). */
  flags?: { stdin: string; env: string };
}

/**
 * Read a secret from standard input, a named environment variable, or a
 * prompt that does not echo — never from a flag's value, which would land in
 * shell history and the process list. One trailing newline is stripped, so
 * `echo "$KEY" | …` and a file with a final newline both work.
 * @param sources - Where to look, and how.
 * @returns The secret.
 * @throws {Error} When it is empty, both sources were given, or there is no
 *   source and no terminal to prompt on.
 */
export async function readSecret(sources: SecretSources): Promise<string> {
  const { label } = sources;
  const flags = sources.flags ?? {
    stdin: "--api-key-stdin",
    env: "--api-key-env",
  };
  if (sources.fromStdin && sources.fromEnv) {
    throw new Error(`Pass one of ${flags.stdin} and ${flags.env}, not both.`);
  }
  let value: string;
  if (sources.fromStdin) {
    value = (await sources.readStdin()).replace(/\r?\n$/, "");
  } else if (sources.fromEnv) {
    const fromEnv = sources.env[sources.fromEnv];
    if (fromEnv === undefined) {
      throw new Error(
        `The environment variable ${sources.fromEnv} is not set.`,
      );
    }
    value = fromEnv;
  } else if (sources.isTTY) {
    value = await sources.prompt(`${label}: `);
  } else {
    throw new Error(
      `No ${label} given. Pipe it in with ${flags.stdin}, or name an environment variable with ${flags.env} <NAME>.`,
    );
  }
  if (value.trim() === "") throw new Error(`The ${label} is empty.`);
  return value.trim();
}

/**
 * Ask for a line on the terminal without echoing it. Ctrl-C exits 130.
 * @param question - The prompt, written to stderr.
 * @returns What was typed.
 */
export function promptHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  process.stderr.write(question);
  return new Promise((resolve, reject) => {
    let typed = "";
    /** Restore the terminal. */
    const done = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      process.stderr.write("\n");
    };
    /**
     * Take one chunk of keystrokes.
     * @param chunk - The bytes the terminal sent.
     */
    function onData(chunk: Buffer) {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n" || char === "\u0004") {
          done();
          resolve(typed);
          return;
        }
        if (char === "\u0003") {
          done();
          reject(new ExitError(130));
          return;
        }
        if (char === "\u007f" || char === "\b") {
          typed = typed.slice(0, -1);
        } else {
          typed += char;
        }
      }
    }
    stdin.setRawMode?.(true);
    stdin.resume();
    stdin.on("data", onData);
  });
}

/**
 * Read all of standard input as text.
 * @returns The text.
 */
export async function readAllStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

/** One argument of a skill, as the server takes it. */
export interface SkillArgumentSpec {
  name: string;
  required: boolean;
  default?: string;
}

/**
 * Parse a skill argument a person typed: `name`, `name!` (required), or
 * `name=default`.
 * @param raw - What they typed.
 * @returns The argument.
 * @throws {Error} When it is not one of those forms.
 */
export function parseArgSpec(raw: string): SkillArgumentSpec {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(!)?(?:=([\s\S]*))?$/.exec(
    raw.trim(),
  );
  if (!match) {
    throw new Error(
      `--arg takes name, name! (required), or name=default; got "${raw}".`,
    );
  }
  if (match[2] && match[3] !== undefined) {
    throw new Error(
      `--arg "${raw}": a required argument has no default; drop the ! or the =.`,
    );
  }
  return {
    name: match[1],
    required: Boolean(match[2]),
    ...(match[3] !== undefined ? { default: match[3] } : {}),
  };
}

/**
 * The text a command was given for a markdown body: `--body <text>`
 * (`-` reads standard input) or `--body-file <path>`; at most one.
 * @param flags - The two flags.
 * @returns The text, or undefined when neither was given.
 * @throws {Error} When both were given.
 */
export async function bodyText(flags: {
  body?: string;
  bodyFile?: string;
}): Promise<string | undefined> {
  if (flags.body !== undefined && flags.bodyFile !== undefined) {
    throw new Error("Pass --body or --body-file, not both.");
  }
  if (flags.bodyFile !== undefined) {
    return readFileFor(flags.bodyFile, "--body-file").toString("utf8");
  }
  if (flags.body === "-") return readAllStdin();
  return flags.body;
}
