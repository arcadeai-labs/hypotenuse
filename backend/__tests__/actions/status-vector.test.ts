import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { type ActionResponse, config } from "keryx";
import type { Status } from "../../actions/status";
import { HOOK_TIMEOUT } from "../setup";

/**
 * A database without `vector` is unhealthy.
 *
 * Dropping the extension from the shared test database would leave it broken
 * for every later file if this one died halfway, and migration 0000 is already
 * recorded there, so nothing would put it back. This file instead creates a
 * throwaway database, boots a second server process against it (which runs
 * the migrations, creating the extension), drops the extension underneath it,
 * and asks that server over HTTP.
 */

const BACKEND_DIR = join(import.meta.dir, "..", "..");

/** The throwaway database's name; unique per run so a crashed run never collides. */
const DATABASE = `hypotenuse_vector_${process.pid}_${Date.now()}`;

/** The shared test database, used only to create and drop the throwaway one. */
const admin = new Bun.SQL(config.database.connectionString);

let throwaway: Bun.SQL;
let server: Bun.Subprocess;
let url: string;

/**
 * Ask the OS for a port nobody is listening on.
 * @returns A free TCP port on loopback.
 */
function freePort(): number {
  const listener = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: { data() {} },
  });
  const { port } = listener;
  listener.stop(true);
  return port;
}

/**
 * Poll the second server's status route until its migrations have run.
 *
 * Answering is not enough: the web server may bind before
 * `DATABASE_AUTO_MIGRATE` finishes, and until migration 0000 runs the throwaway
 * database has no `vector` — which is exactly what the second test asserts
 * about, so reading it early would pass for the wrong reason or fail the first.
 * @returns The first status body that reports the extension.
 * @throws {Error} If the server never reports it within the hook timeout.
 */
async function waitForMigrated(): Promise<ActionResponse<Status>> {
  const deadline = Date.now() + HOOK_TIMEOUT - 5_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/status`);
      if (res.ok) {
        const body = (await res.json()) as ActionResponse<Status>;
        if (body.database?.extensions.vector) return body;
      }
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`no migrated server answered at ${url} before the deadline`);
}

/**
 * Fetch the second server's status.
 * @returns The parsed body.
 */
async function status(): Promise<ActionResponse<Status>> {
  const res = await fetch(`${url}/api/status`);
  expect(res.status).toBe(200);
  return (await res.json()) as ActionResponse<Status>;
}

beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE "${DATABASE}"`);
  const databaseUrl = new URL(config.database.connectionString);
  databaseUrl.pathname = `/${DATABASE}`;
  throwaway = new Bun.SQL(databaseUrl.toString());

  const port = freePort();
  url = `http://127.0.0.1:${port}`;
  server = Bun.spawn(["bun", "keryx.ts", "start"], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL_TEST: databaseUrl.toString(),
      DATABASE_AUTO_MIGRATE_TEST: "true",
      WEB_SERVER_PORT_TEST: String(port),
      WEB_SERVER_HOST: "127.0.0.1",
      // Nothing here needs a worker or MCP, and each would hold Redis.
      TASKS_ENABLED_TEST: "false",
      MCP_SERVER_ENABLED: "false",
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  await waitForMigrated();
}, HOOK_TIMEOUT);

afterAll(async () => {
  server?.kill();
  await server?.exited;
  await throwaway?.end();
  await admin.unsafe(`DROP DATABASE IF EXISTS "${DATABASE}" WITH (FORCE)`);
  await admin.end();
}, HOOK_TIMEOUT);

describe("status: the vector extension", () => {
  test("a freshly migrated database has it, and is healthy", async () => {
    const body = await status();
    expect(body.database?.extensions.vector).toBe(true);
    expect(body.healthy).toBe(true);
  });

  test("the health probe answers 200 while it is there", async () => {
    const res = await fetch(`${url}/api/health`);
    expect(res.status).toBe(200);
  });

  test("a reachable database without it is unhealthy", async () => {
    // CASCADE: memory's embedding column and its index depend on the type.
    await throwaway`DROP EXTENSION vector CASCADE`;
    const body = await status();
    expect(body.checks.database).toBe(true);
    expect(body.checks.redis).toBe(true);
    expect(body.database?.extensions.vector).toBe(false);
    expect(body.healthy).toBe(false);
  });

  test("and the health probe fails it with a status a load balancer reads", async () => {
    // A deploy's health check sees only the HTTP status, so the verdict must
    // be a non-2xx answer, and its message names what failed.
    const res = await fetch(`${url}/api/health`);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe("unhealthy: database extension vector");
  });
});
