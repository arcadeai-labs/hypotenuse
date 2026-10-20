import { join } from "node:path";
import { loadEnv } from "vite";

/**
 * The environment the e2e stack runs in, shared by `playwright.config.ts` (which
 * imposes it on the servers it spawns) and `global-setup.ts` (which waits for
 * them).
 *
 * **The backend runs as `NODE_ENV=test`.** That one choice puts the suite in the
 * normal test database rather than the one you develop against:
 * `DATABASE_URL_TEST` and `REDIS_URL_TEST` select themselves through keryx's
 * `loadFromEnvIfSet`, which reads `${VAR}_${NODE_ENV}` before `${VAR}`. Neither
 * URL is named here, so `backend/.env` stays the one owner of both.
 *
 * The consequence worth knowing: `bun test` opens with `clearDatabase()`, so
 * running it *while* Playwright is running pulls the rug out. One suite at a
 * time per checkout — which is what `bun run workspace:setup` is for.
 *
 * What *is* set here is everything `NODE_ENV=test` would otherwise get wrong for
 * a browser-driven suite. Each is `_TEST`-suffixed, so it beats `backend/.env`
 * without editing it and affects only the process Playwright spawns.
 */

// Playwright runs under node, so nothing has loaded `.env` into `process.env`.
// The directory is `frontend/`, not this file's own: `workspace:setup` writes
// the two ports into `frontend/.env`, and there is no `.env` in `e2e/`.
const env = loadEnv("development", join(import.meta.dirname, ".."), "");

/**
 * The database the e2e backend connects to, for the spec that has to put a row
 * in a state no browser can reach. Read out of `backend/.env` in mode `test`, so
 * `DATABASE_URL_TEST` selects itself and a real environment variable still wins.
 */
export const DATABASE_URL =
  loadEnv("test", join(import.meta.dirname, "../../backend"), "")
    .DATABASE_URL_TEST ?? "";

// Deliberately not 8080/3000, so a suite never takes the ports `bun dev` uses.
export const BACKEND_PORT = Number(env.E2E_BACKEND_PORT) || 8081;
export const FRONTEND_PORT = Number(env.E2E_FRONTEND_PORT) || 3001;
export const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;
export const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

/** What the backend is started with. See the note above on `NODE_ENV=test`. */
export const BACKEND_ENV: Record<string, string> = {
  NODE_ENV: "test",
  // `bun test` gives every file a random free port; a browser needs one up front.
  WEB_SERVER_PORT_TEST: String(BACKEND_PORT),
  APPLICATION_URL_TEST: BACKEND_URL,
  // Must be the Vite dev server's origin or every request fails its preflight.
  WEB_SERVER_ALLOWED_ORIGINS_TEST: FRONTEND_URL,
  FRONTEND_URL_TEST: FRONTEND_URL,
  // `.env` silences the backend to `fatal` under test. A browser spec that fails
  // shows a page that did not change; the server's side of why should reach the
  // terminal, and `playwright.config.ts` pipes this server's stdout for it.
  LOG_LEVEL_TEST: "warn",
  // The limiter is real in production and the browser path is the only place
  // it is exercised; `.env.example` raises the unauthenticated limit for it.
  RATE_LIMIT_ENABLED_TEST: "true",
  // Nothing else migrates the test database before Playwright starts.
  DATABASE_AUTO_MIGRATE_TEST: "true",
  PROCESS_NAME_TEST: "hypotenuse-e2e",
  // `bun test` drives jobs in-process and wants no worker. The browser suite is
  // the opposite: a queued notification only reaches an open page when the
  // dispatch clock runs, so this backend works its queues, on a one-second tick.
  TASK_PROCESSORS_TEST: "1",
  NOTIFICATION_DISPATCH_FREQUENCY_MS_TEST: "1000",
};

/** What the Vite dev server is started with. */
export const FRONTEND_ENV: Record<string, string> = {
  PORT: String(FRONTEND_PORT),
  VITE_API_URL: BACKEND_URL,
};
