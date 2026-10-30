/**
 * Start the backend the browser suite drives: create its database when it is
 * missing, then run the server in the foreground for Playwright to own.
 *
 * Playwright's `webServer` runs this with `BACKEND_ENV` from `e2e/env.ts`, so
 * `DATABASE_URL` already names the e2e database. Creating it here removes the
 * one manual step a fresh checkout would otherwise trip over; the backend's own
 * `DATABASE_AUTO_MIGRATE` builds the schema once it connects.
 *
 * It also runs the suite's mail catcher, `backend/__tests__/fixtures/mail-catcher.ts`,
 * as a second process: started by path because the frontend may not import
 * backend code. The backend sends through it, and a spec reads verification
 * links from its inbox.
 *
 * And it runs the suite's scripted model, `backend/__tests__/fixtures/model-server-process.ts`,
 * the same way: a model connection points at it, and a spec queues what a
 * bot's model answers on its control port. If something already holds that
 * port — a scripted model left running — the new one exits and that one
 * serves.
 */
import { join } from "node:path";
import { SQL } from "bun";

/**
 * Create the database a Postgres URL names, if the server does not have it.
 * @param url - The `postgres://` URL of the database to ensure.
 */
async function ensureDatabase(url: string): Promise<void> {
  const target = new URL(url);
  const database = decodeURIComponent(target.pathname.slice(1));
  if (!/^[a-z0-9_]+$/i.test(database)) {
    throw new Error(`Refusing to create a database named ${database}`);
  }
  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  const sql = new SQL(maintenance.toString());
  try {
    const rows =
      await sql`SELECT 1 FROM pg_database WHERE datname = ${database}`;
    if (rows.length === 0) {
      await sql.unsafe(`CREATE DATABASE "${database}"`);
      console.log(`created database ${database}`);
    }
  } finally {
    await sql.close();
  }
}

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set; run this from Playwright");
await ensureDatabase(url);

const backendDir = join(import.meta.dirname, "../../backend");
const mail = Bun.spawn(["bun", "__tests__/fixtures/mail-catcher.ts"], {
  cwd: backendDir,
  env: process.env,
  stdout: "inherit",
  stderr: "inherit",
});

const model = Bun.spawn(["bun", "__tests__/fixtures/model-server-process.ts"], {
  cwd: backendDir,
  env: process.env,
  stdout: "inherit",
  stderr: "inherit",
});

const server = Bun.spawn(["bun", "keryx.ts", "start"], {
  cwd: backendDir,
  env: process.env,
  stdout: "inherit",
  stderr: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    mail.kill(signal);
    model.kill(signal);
    server.kill(signal);
  });
}
const code = await server.exited;
mail.kill();
model.kill();
process.exit(code);
