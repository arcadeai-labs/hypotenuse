import { join } from "node:path";
import { loadEnv } from "vite";

/**
 * The environment the browser suite runs in, shared by `playwright.config.ts`
 * (which imposes it on the servers it starts) and `global-setup.ts` (which
 * waits for them).
 *
 * The suite boots the **real backend** beside the Vite dev server, so every
 * signed-in spec takes the browser's own cross-origin path — the only place a
 * CORS, cookie, or `VITE_API_URL` regression shows. The backend runs as
 * `NODE_ENV=development` against a database and Redis index of its own, so a
 * suite run never touches the database you develop against, nor the one
 * `bun run test` truncates. The specs never clear it: each mints unique
 * addresses instead.
 */

// Playwright runs under node, so nothing has loaded `.env` into `process.env`.
// `workspace:setup` writes this checkout's e2e ports into `frontend/.env`.
const env = loadEnv("development", join(import.meta.dirname, ".."), "");
// The backend's own `.env`, for the Postgres credentials it already uses.
const backendEnv = loadEnv(
  "development",
  join(import.meta.dirname, "../../backend"),
  "",
);

// Deliberately not 3000/8080, so a suite never takes the ports `bun dev` uses.
export const FRONTEND_PORT = Number(env.E2E_FRONTEND_PORT) || 3001;
export const BACKEND_PORT = Number(env.E2E_BACKEND_PORT) || 8081;
export const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;
export const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

/**
 * The suite's mail catcher, which `scripts/e2e-backend.ts` starts beside the
 * backend: an SMTP server the backend sends through, and an HTTP inbox a spec
 * reads verification links from. Offset from the backend's port, so a second
 * checkout with its own e2e ports gets its own mailbox too.
 */
export const MAIL_SMTP_PORT = BACKEND_PORT + 1000;
export const MAIL_INBOX_PORT = BACKEND_PORT + 1001;
export const MAIL_INBOX_URL = `http://127.0.0.1:${MAIL_INBOX_PORT}`;

/**
 * Point a Postgres URL at another database on the same server, keeping its
 * credentials and host.
 * @param url - A `postgres://` URL.
 * @param database - The database name to put in its path.
 * @returns The rewritten URL.
 */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/**
 * The e2e database: `E2E_DATABASE_URL` when set (CI points it at its service
 * container), else `backend/.env`'s `DATABASE_URL` with the database renamed
 * to `hypotenuse_e2e`. `scripts/e2e-backend.ts` creates it when it is missing.
 */
export const E2E_DATABASE_URL =
  process.env.E2E_DATABASE_URL ||
  env.E2E_DATABASE_URL ||
  withDatabase(
    backendEnv.DATABASE_URL || "postgres://localhost:5432/hypotenuse",
    "hypotenuse_e2e",
  );

/** The e2e Redis: its own index, so its sessions and queues stand apart. */
export const E2E_REDIS_URL =
  process.env.E2E_REDIS_URL || env.E2E_REDIS_URL || "redis://localhost:6379/2";

/** What the backend is started with. Real environment variables beat `.env`. */
export const BACKEND_ENV: Record<string, string> = {
  NODE_ENV: "development",
  DATABASE_URL: E2E_DATABASE_URL,
  DATABASE_AUTO_MIGRATE: "true",
  REDIS_URL: E2E_REDIS_URL,
  WEB_SERVER_PORT: String(BACKEND_PORT),
  // Must be the Vite dev server's origin or every request fails its preflight.
  WEB_SERVER_ALLOWED_ORIGINS: FRONTEND_URL,
  APPLICATION_URL: BACKEND_URL,
  FRONTEND_URL,
  // Mail goes to the catcher, so a spec can follow a verification link.
  SMTP_HOST: "127.0.0.1",
  SMTP_PORT: String(MAIL_SMTP_PORT),
  E2E_MAIL_INBOX_PORT: String(MAIL_INBOX_PORT),
  // Every spec signs up through one IP; the limiter is not what is under test.
  RATE_LIMIT_ENABLED: "false",
  // No clocks or queue workers: nothing a spec checks waits on a task.
  TASK_PROCESSORS: "0",
  PROCESS_NAME: "hypotenuse-e2e",
  LOG_LEVEL: "warn",
};

/** What the Vite dev server is started with. */
export const FRONTEND_ENV: Record<string, string> = {
  PORT: String(FRONTEND_PORT),
  VITE_API_URL: BACKEND_URL,
};
