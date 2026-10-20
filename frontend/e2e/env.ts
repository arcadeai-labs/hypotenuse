import { join } from "node:path";
import { loadEnv } from "vite";

/**
 * The environment the e2e stack runs in, shared by `playwright.config.ts` (which
 * imposes it on the servers it spawns) and `global-setup.ts` (which waits for
 * them).
 *
 * **The backend runs as `NODE_ENV=test`.** That one choice is what puts the suite
 * in the normal test database rather than the one you are developing against:
 * `DATABASE_URL_TEST` and `REDIS_URL_TEST` select themselves through keryx's
 * `loadFromEnvIfSet`, which reads `${VAR}_${NODE_ENV}` before `${VAR}`. Neither
 * URL is named here on purpose — it would be a second copy of a value
 * `backend/.env` already owns, and the two would disagree the first time somebody
 * edited one of them. The suite and `bun test` land in the same place because they
 * are asking the same file the same question.
 *
 * The consequence worth knowing: `bun test` opens with `clearDatabase()`, so
 * running it *while* Playwright is running pulls the rug out. One suite at a time
 * per checkout — which is what `bun run workspace:setup` giving each checkout its
 * own database is for.
 *
 * What *is* set here is everything `NODE_ENV=test` would otherwise get wrong for a
 * browser-driven suite, and nothing else. Each is `_TEST`-suffixed, so it beats
 * `backend/.env` without editing it, and affects only the process Playwright
 * spawns — `bun test` in another terminal is untouched.
 */

// Playwright runs under node, so unlike the backend nothing has loaded `.env`
// into `process.env` for us. `loadEnv` with an empty prefix is how
// `vite.config.ts` already reads `PORT`, and it lets a real environment variable
// win over the file — which is how CI overrides these without editing anything.
//
// The directory is `frontend/`, **not this file's own** — which is the bug this
// argument exists to prevent recurring. `workspace:setup` writes the two ports
// into `frontend/.env`, and `import.meta.dirname` is `frontend/e2e`, where there
// is no `.env` at all. The symptom was not an error: every checkout silently
// fell back to the 8081/3001 defaults, so the per-workspace ports that exist
// precisely to stop worktrees colliding were never read, and two suites running
// at once fought over one pair of ports.
const env = loadEnv("development", join(import.meta.dirname, ".."), "");

/**
 * The database the e2e backend will connect to, for the one spec that has to
 * put a run row in a state no browser can reach.
 *
 * Read out of `backend/.env` rather than named here, for the reason the note
 * above gives: a copy of the value would disagree with the file the backend
 * reads the moment somebody edited one of them. Mode `test` because that is
 * what the backend runs as, so `DATABASE_URL_TEST` is the key that selects
 * itself — and a real environment variable still wins, which is how CI points
 * the suite at its service container without editing anything.
 */
export const DATABASE_URL =
  loadEnv("test", join(import.meta.dirname, "../../backend"), "")
    .DATABASE_URL_TEST ?? "";

// Written by `bun run workspace:setup`; absent until somebody runs it, and these
// defaults are deliberately not 8080/3000, since the original complaint was a
// suite taking the ports out from under a running dev server.
export const BACKEND_PORT = Number(env.E2E_BACKEND_PORT) || 8081;
export const FRONTEND_PORT = Number(env.E2E_FRONTEND_PORT) || 3001;
export const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;
export const BACKEND_URL = `http://localhost:${BACKEND_PORT}`;

/** What the backend is started with. See the note above on `NODE_ENV=test`. */
export const BACKEND_ENV: Record<string, string> = {
  NODE_ENV: "test",
  // `bun test` gives every file a random free port; a browser has to be told one
  // up front.
  WEB_SERVER_PORT_TEST: String(BACKEND_PORT),
  APPLICATION_URL_TEST: BACKEND_URL,
  // Must be the Vite dev server's origin or every request fails its CORS preflight.
  WEB_SERVER_ALLOWED_ORIGINS_TEST: FRONTEND_URL,
  // `.env` silences the backend to `fatal` under test, which is right for a
  // thousand-assertion unit suite and wrong here: a browser spec fails with a
  // screenshot of a page that did not change, and the server's account of why is
  // the other half of the story. `warn` rather than `info` so a green run stays
  // readable — the request log would be several hundred lines of noise — while
  // anything that actually went wrong still reaches the terminal. It only gets
  // there because `playwright.config.ts` pipes this server's stdout, which
  // Playwright otherwise discards.
  LOG_LEVEL_TEST: "warn",
  // Also off under test, and also wrong here. The limiter is real in production
  // and the browser path is the only place we exercise it, which is why
  // `.env.example` raises `RATE_LIMIT_UNAUTH_LIMIT` to 100 rather than dodging it.
  RATE_LIMIT_ENABLED_TEST: "true",
  // Nothing else migrates the test database before Playwright starts.
  DATABASE_AUTO_MIGRATE_TEST: "true",
  PROCESS_NAME_TEST: "toolexec-e2e",
  // Orchestration ticks are task-only — no public HTTP poke — so the live
  // notifications specs wait on the Resque schedule. Production's thirty-second
  // cadence is longer than a Playwright test timeout; a one-second tick keeps
  // those specs deterministic without putting the control plane back on the API.
  RUN_DISPATCH_FREQUENCY_MS_TEST: "1000",
  NOTIFICATION_DISPATCH_FREQUENCY_MS_TEST: "1000",
  // **Pointed away from the real Vercel, deliberately.** The Integrations
  // section fires `connection:probe` after a successful connect, so the spec
  // that connects a `team_e2e` / `prj_e2e` fixture would otherwise send a real
  // request to `vercel.com` on every run — from every developer's laptop and
  // from CI, carrying a fake token, in a suite about a form. Nothing here is
  // listening on this port, so the probe answers `unreachable` in milliseconds,
  // which is a perfectly good thing for the spec to see.
  TOOLEXEC_VERCEL_API_BASE_URL_TEST: "http://127.0.0.1:9",
  // The model providers, for exactly the same reason and to the same dead port.
  // The Model section fires a probe after a successful connect too, so the specs
  // that paste `sk-ant-e2e-value-7b41` would otherwise send a fake key to
  // Anthropic and OpenAI on every run of the suite.
  TOOLEXEC_MODEL_UPSTREAMS_TEST: JSON.stringify({
    anthropic: "http://127.0.0.1:9",
    openai: "http://127.0.0.1:9",
  }),
};

/** What the Vite dev server is started with. */
export const FRONTEND_ENV: Record<string, string> = {
  PORT: String(FRONTEND_PORT),
  VITE_API_URL: BACKEND_URL,
};
