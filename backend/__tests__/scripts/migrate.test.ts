import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "keryx";
import { HOOK_TIMEOUT } from "../setup";

/**
 * `scripts/migrate.ts` is the API's Render `preDeployCommand`, so a deploy is
 * exactly as healthy as this script: it must migrate a database from nothing,
 * be a no-op the second time, and fail loudly — a non-zero exit is what makes
 * Render abort the deploy — when it cannot. It runs as its own process against
 * a throwaway database, with the service's own `DATABASE_AUTO_MIGRATE=false`,
 * as Render runs it.
 */

const BACKEND_DIR = join(import.meta.dir, "..", "..");

/** The throwaway database; unique per run so a crashed run never collides. */
const DATABASE = `hypotenuse_migrate_${process.pid}_${Date.now()}`;

/** The shared test database, used only to create and drop the throwaway one. */
const admin = new Bun.SQL(config.database.connectionString);

/** Every migration the repository ships, from drizzle-kit's journal. */
const JOURNAL = JSON.parse(
  readFileSync(join(BACKEND_DIR, "drizzle", "meta", "_journal.json"), "utf8"),
) as { entries: { tag: string }[] };

let databaseUrl: string;
let throwaway: Bun.SQL;

/**
 * Run the script the way Render does, against a given database.
 * @param url - The database it should migrate.
 * @returns The exit code and everything it printed.
 */
async function migrate(url: string): Promise<{ code: number; output: string }> {
  const child = Bun.spawn(["bun", "scripts/migrate.ts"], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL_TEST: url,
      // What the API service sets; the script must override it.
      DATABASE_AUTO_MIGRATE: "false",
      DATABASE_AUTO_MIGRATE_TEST: "false",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, output: stdout + stderr };
}

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${DATABASE}"`);
  const url = new URL(config.database.connectionString);
  url.pathname = `/${DATABASE}`;
  databaseUrl = url.toString();
  throwaway = new Bun.SQL(databaseUrl);
}, HOOK_TIMEOUT);

afterAll(async () => {
  await throwaway?.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
  await admin.end();
}, HOOK_TIMEOUT);

describe("scripts/migrate.ts", () => {
  test(
    "applies every migration to an empty database and exits 0",
    async () => {
      const { code, output } = await migrate(databaseUrl);
      expect(code, output).toBe(0);
      const applied =
        await throwaway`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
      expect(applied[0].n).toBe(JOURNAL.entries.length);
      const vector =
        await throwaway`SELECT 1 FROM pg_extension WHERE extname = 'vector'`;
      expect(vector).toHaveLength(1);
    },
    HOOK_TIMEOUT,
  );

  test(
    "is a no-op the second time",
    async () => {
      const { code, output } = await migrate(databaseUrl);
      expect(code, output).toBe(0);
      const applied =
        await throwaway`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
      expect(applied[0].n).toBe(JOURNAL.entries.length);
    },
    HOOK_TIMEOUT,
  );

  test(
    "exits non-zero when it cannot migrate, so Render aborts the deploy",
    async () => {
      const missing = new URL(databaseUrl);
      missing.pathname = `/${DATABASE}_missing`;
      const { code } = await migrate(missing.toString());
      expect(code).not.toBe(0);
    },
    HOOK_TIMEOUT,
  );
});
