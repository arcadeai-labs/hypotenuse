/**
 * `credentials.json` — what this machine holds for each Hypotenuse server.
 *
 * Keyed by server origin, so one machine can hold a sign-in against production
 * and another against staging. Per server: `login` (the CLI token `hypotenuse
 * login` wrote), and the `organization` and `project` that `org use` and
 * `project use` selected. `logout` clears the sign-in and keeps the selections,
 * so signing back in lands where you were.
 *
 * The directory is `0700` and the file `0600`, written atomically (temp file,
 * then rename) so a crash never leaves half a credentials file.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { credentialsPath } from "../paths";

/**
 * The credentials path for an environment (re-exported for the context).
 * @param env - Environment variables.
 * @returns The path.
 */
export function credentialsPathFor(
  env: Record<string, string | undefined>,
): string {
  return credentialsPath(env);
}

/** An operator's CLI sign-in on one server. */
export const LoginSchema = z.object({
  token: z.string(),
  cliTokenId: z.number(),
  device: z.string(),
  email: z.string().optional(),
  expiresAt: z.number().optional(),
});

/** One server's entry. */
export const ServerEntrySchema = z.object({
  login: LoginSchema.nullable().default(null),
  /** The organization `hypotenuse org use` selected, by id. */
  organization: z.number().nullable().default(null),
  /** The project `hypotenuse project use` selected, by id. */
  project: z.number().nullable().default(null),
});

/** The whole file. */
export const CredentialsSchema = z.object({
  version: z.literal(1),
  /** The server the last `login` signed in to, used when nothing names one. */
  current: z.string().nullable().default(null),
  servers: z.record(z.string(), ServerEntrySchema).default({}),
});

export type Login = z.infer<typeof LoginSchema>;
export type ServerEntry = z.infer<typeof ServerEntrySchema>;
export type Credentials = z.infer<typeof CredentialsSchema>;

/**
 * An empty credentials file.
 * @returns A file with no servers.
 */
export function emptyCredentials(): Credentials {
  return { version: 1, current: null, servers: {} };
}

/**
 * Refuse a credentials file other users can read or write, as ssh refuses a
 * private key: the file holds bearer tokens. Skipped on Windows, whose
 * permissions are not mode bits.
 * @param path - The file.
 * @throws {Error} Naming the path and the `chmod` that fixes it.
 */
export function assertPrivateFile(path: string): void {
  if (process.platform === "win32") return;
  const mode = statSync(path).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(
      `${path} is accessible by other users (mode ${mode.toString(8).padStart(4, "0")}); it holds tokens. Run \`chmod 600 ${path}\` and try again.`,
    );
  }
}

/**
 * Read the credentials file. A missing file is an empty one; a malformed one is
 * an error naming the path, never silently replaced; one readable by other
 * users is refused (see {@link assertPrivateFile}).
 * @param path - The file to read.
 * @returns The parsed credentials.
 * @throws {Error} When the file exists but is not valid credentials, or is
 *   group- or world-accessible.
 */
export function loadCredentials(path = credentialsPath()): Credentials {
  if (!existsSync(path)) return emptyCredentials();
  assertPrivateFile(path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${path} is not valid JSON`);
  }
  const parsed = CredentialsSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${path} is not a hypotenuse credentials file`);
  }
  return parsed.data;
}

/**
 * Write the credentials file atomically, directory `0700`, file `0600`.
 * @param credentials - What to write.
 * @param path - Where.
 */
export function saveCredentials(
  credentials: Credentials,
  path = credentialsPath(),
): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode is masked by umask and ignored for an existing directory.
  chmodSync(dir, 0o700);
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(credentials, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(temp, 0o600);
  // Durable before the rename, so a crash leaves the old file or the new one.
  const fd = openSync(temp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, path);
}

/**
 * Normalize a server URL to the origin credentials are keyed by.
 * @param url - What the person typed or configured.
 * @returns `scheme://host[:port]`, no path or trailing slash.
 * @throws {Error} For something that is not an http(s) URL.
 */
export function originOf(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Not a URL: ${url}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`Not an http(s) URL: ${url}`);
  }
  return parsed.origin;
}

/**
 * One server's entry, created empty if absent (not saved).
 * @param credentials - The file.
 * @param origin - The server.
 * @returns The live entry object inside `credentials`.
 */
export function serverEntry(
  credentials: Credentials,
  origin: string,
): ServerEntry {
  credentials.servers[origin] ??= {
    login: null,
    organization: null,
    project: null,
  };
  return credentials.servers[origin];
}
