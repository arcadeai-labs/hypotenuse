/**
 * Start the backend the browser suite drives: create its database when it is
 * missing, then run the server in the foreground for Playwright to own.
 *
 * Playwright's `webServer` runs this with `BACKEND_ENV` from `e2e/env.ts`, so
 * `DATABASE_URL` already names the e2e database. Creating it here removes the
 * one manual step a fresh checkout would otherwise trip over; the backend's own
 * `DATABASE_AUTO_MIGRATE` builds the schema once it connects.
 *
 * It also runs the suite's mail catcher: the backend's own fake SMTP server
 * (the one its tests use) on `SMTP_PORT`, and an HTTP inbox on
 * `E2E_MAIL_INBOX_PORT` answering `GET /verification-token?to=` with the token
 * from the newest verification mail to that address — so a spec follows the
 * link the real mail carried rather than minting one.
 */
import { join } from "node:path";
import { SQL } from "bun";
import {
  startFakeSmtpServer,
  verificationTokenIn,
} from "../../backend/__tests__/fixtures/smtp.ts";

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

const smtp = startFakeSmtpServer(Number(process.env.SMTP_PORT));
const inbox = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.E2E_MAIL_INBOX_PORT),
  fetch(request) {
    const to = new URL(request.url).searchParams.get("to") ?? "";
    const mail = smtp.received.findLast(
      (m) => m.to.includes(to) && m.subject.includes("Confirm your"),
    );
    const token = mail ? verificationTokenIn(mail) : undefined;
    return Response.json({ token: token ?? null });
  },
});

const server = Bun.spawn(["bun", "keryx.ts", "start"], {
  cwd: join(import.meta.dirname, "../../backend"),
  env: process.env,
  stdout: "inherit",
  stderr: "inherit",
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.kill(signal));
}
const code = await server.exited;
smtp.stop();
inbox.stop(true);
process.exit(code);
