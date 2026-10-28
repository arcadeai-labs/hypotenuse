import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { api } from "keryx";
import {
  loadRedisScripts,
  redisScriptDir,
  redisScriptNames,
  redisScriptSha,
  runRedisScript,
} from "../../ops/RedisScriptOps";
import { HOOK_TIMEOUT } from "../setup";

/**
 * Lua lives in `backend/lua/*.lua`, and boot is what registers it.
 *
 * Two properties are load-bearing and neither is visible from a call site. The
 * first is that the loaded set **is** the directory listing — a script added as
 * a file but never registered would work anyway, through the `EVAL` fallback,
 * and the boot-time syntax check that fallback exists to survive would silently
 * stop covering it. The second is that a call still answers after
 * `SCRIPT FLUSH`, which is what a Redis restart or a failover looks like from
 * here, and is the one failure mode `EVALSHA` introduces over `EVAL`.
 *
 * The third test is mechanical rather than behavioral: it fails if Lua reappears
 * as a string inside TypeScript, which is the state this directory replaced.
 */

const BACKEND_DIR = join(import.meta.dir, "..", "..");

beforeAll(async () => {
  await api.start();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("redis lua scripts", () => {
  test("boot loads exactly the .lua files on disk", async () => {
    const onDisk = (await readdir(redisScriptDir()))
      .filter((file) => file.endsWith(".lua"))
      .map((file) => basename(file, ".lua"))
      .sort();

    expect(redisScriptNames()).toEqual(onDisk);

    // Registered means Redis holds it: a sha the server never loaded would
    // only ever run through the fallback.
    for (const name of onDisk) {
      const sha = redisScriptSha(name);
      expect(sha).toBeTruthy();
      expect(await api.redis.redis.script("EXISTS", String(sha))).toEqual([1]);
    }
  });

  test("a flushed script cache does not fail a call", async () => {
    // A fixture script, written for this test and removed after it, so the
    // fallback is proven whether or not the application ships a script yet.
    const name = "zz-test-echo";
    const file = join(redisScriptDir(), `${name}.lua`);
    await Bun.write(file, "return ARGV[1]\n");
    try {
      await loadRedisScripts();
      const sha = String(redisScriptSha(name));

      await api.redis.redis.script("FLUSH");
      expect(await api.redis.redis.script("EXISTS", sha)).toEqual([0]);

      expect(await runRedisScript(name, [], ["echoed"])).toBe("echoed");
      // `EVAL` re-cached the same source, so the sha the loader holds is live
      // again without another `SCRIPT LOAD`.
      expect(await api.redis.redis.script("EXISTS", sha)).toEqual([1]);
      expect(redisScriptSha(name)).toBe(sha);
    } finally {
      await rm(file, { force: true });
      // Leave the cache as the rest of the suite expects to find it.
      await loadRedisScripts();
    }
  });

  test("an unknown script names the file it wanted", async () => {
    await expect(runRedisScript("not-a-script", [])).rejects.toThrow(
      join(redisScriptDir(), "not-a-script.lua"),
    );
  });

  test("no TypeScript source carries Lua in a string", async () => {
    // Built rather than written, so this file does not match itself.
    const needle = ["redis", ".call("].join("");
    const offenders: string[] = [];

    for await (const entry of new Bun.Glob("**/*.ts").scan({
      cwd: BACKEND_DIR,
      absolute: true,
    })) {
      if (entry.includes(`${join(BACKEND_DIR, "node_modules")}/`)) continue;
      if (entry === import.meta.path) continue;
      const source = await Bun.file(entry).text();
      if (source.includes(needle)) {
        offenders.push(relative(BACKEND_DIR, entry));
      }
    }

    expect(offenders).toEqual([]);
  });
});
