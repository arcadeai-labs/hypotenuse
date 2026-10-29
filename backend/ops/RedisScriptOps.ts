import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { api } from "keryx";

/**
 * Every Lua script this application runs, read from `backend/lua/*.lua` at boot.
 *
 * Lua is a language Redis executes, not a string this codebase composes: kept
 * inline it gets no syntax highlighting, no `.lua` tooling, and a reviewer sees
 * a template literal rather than a program. Each script is its own file, named
 * for what it claims, and the whole directory is `SCRIPT LOAD`ed by the
 * `redisScripts` initializer — so a syntax error is a failed boot in the deploy
 * log rather than a 500 the first time somebody exercises that path.
 *
 * Running a script is `EVALSHA` against the sha the load returned, with one
 * `EVAL` fallback: `SCRIPT FLUSH`, a Redis restart, or a failover to a replica
 * that never saw the load all empty that cache, and `EVAL` both runs the
 * script and refills it. The sha never changes, because it is the sha of the
 * file.
 */

/** Where the `.lua` files live, relative to this module. */
const LUA_DIR = join(import.meta.dir, "..", "lua");

/** One loaded script: its source, and the sha Redis knows it by. */
interface LoadedScript {
  /** The file's contents, kept for the `EVAL` fallback. */
  source: string;
  /** The sha1 `SCRIPT LOAD` returned, which is the sha1 of {@link source}. */
  sha: string;
}

/** Loaded scripts, keyed by file name without the `.lua` extension. */
const scripts = new Map<string, LoadedScript>();

/** The in-flight load, so concurrent callers share one directory read. */
let loading: Promise<string[]> | null = null;

/**
 * The directory the scripts are read from.
 * @returns An absolute path to `backend/lua`.
 */
export function redisScriptDir(): string {
  return LUA_DIR;
}

/**
 * Every script name loaded, sorted.
 * @returns File names without the `.lua` extension.
 */
export function redisScriptNames(): string[] {
  return [...scripts.keys()].sort();
}

/**
 * The sha Redis knows one script by.
 * @param name - The file name without the `.lua` extension.
 * @returns The sha1, or `undefined` when that script is not loaded.
 */
export function redisScriptSha(name: string): string | undefined {
  return scripts.get(name)?.sha;
}

/**
 * Read `backend/lua/*.lua` and `SCRIPT LOAD` every one of them.
 *
 * Called at boot by the `redisScripts` initializer. Idempotent: a second call
 * re-reads the directory, which is what makes it usable as the backstop for a
 * process that reaches a script before its initializer ran.
 * @returns The names loaded, sorted.
 * @throws {Error} If Redis refuses a script — a Lua syntax error fails boot.
 */
export async function loadRedisScripts(): Promise<string[]> {
  const files = (await readdir(LUA_DIR))
    .filter((file) => file.endsWith(".lua"))
    .sort();

  const loaded = new Map<string, LoadedScript>();
  for (const file of files) {
    const source = await Bun.file(join(LUA_DIR, file)).text();
    const sha = String(await api.redis.redis.script("LOAD", source));
    loaded.set(basename(file, ".lua"), { source, sha });
  }

  scripts.clear();
  for (const [name, script] of loaded) scripts.set(name, script);
  return [...scripts.keys()];
}

/**
 * Run one loaded script.
 * @param name - The file name without the `.lua` extension.
 * @param keys - The Redis keys the script touches, in `KEYS` order.
 * @param args - The script's `ARGV` values.
 * @returns Whatever the script returned, as ioredis reports it.
 * @throws {Error} If no `.lua` file of that name exists.
 */
export async function runRedisScript(
  name: string,
  keys: string[],
  args: Array<string | number> = [],
): Promise<unknown> {
  const script = await requireScript(name);

  try {
    return await api.redis.redis.evalsha(
      script.sha,
      keys.length,
      ...keys,
      ...args,
    );
  } catch (error) {
    if (!isNoScriptError(error)) throw error;
    // The cache was emptied under us (flush, restart, failover). `EVAL` runs
    // the same source and leaves it cached again under the same sha.
    return await api.redis.redis.eval(
      script.source,
      keys.length,
      ...keys,
      ...args,
    );
  }
}

/**
 * Look a script up, reading the directory once if nothing is loaded yet.
 * @param name - The file name without the `.lua` extension.
 * @returns The loaded script.
 * @throws {Error} If the name matches no `.lua` file.
 */
async function requireScript(name: string): Promise<LoadedScript> {
  let script = scripts.get(name);
  if (script) return script;

  // Boot loads these; this covers a caller that runs before the initializer.
  loading ??= loadRedisScripts().finally(() => {
    loading = null;
  });
  await loading;

  script = scripts.get(name);
  if (!script) {
    throw new Error(
      `No Redis Lua script named "${name}" — expected ${join(LUA_DIR, `${name}.lua`)}`,
    );
  }
  return script;
}

/**
 * Whether an error is Redis saying it no longer holds a script.
 * @param error - The thrown value.
 * @returns `true` for a `NOSCRIPT` reply.
 */
function isNoScriptError(error: unknown): boolean {
  return (
    error instanceof Error && error.message.toUpperCase().includes("NOSCRIPT")
  );
}
