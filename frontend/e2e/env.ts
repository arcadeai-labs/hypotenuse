import { join } from "node:path";
import { loadEnv } from "vite";

/**
 * The environment the browser suite runs in, shared by `playwright.config.ts`.
 *
 * The suite drives the frontend alone: every page it visits renders from the
 * bundle and fixtures, and `/status` answering "the server did not answer" is
 * a state worth seeing too. A spec that needs the backend adds it to
 * `playwright.config.ts` as a second `webServer` when it arrives.
 */

// Playwright runs under node, so nothing has loaded `.env` into `process.env`.
// `workspace:setup` writes this checkout's e2e port into `frontend/.env`.
const env = loadEnv("development", join(import.meta.dirname, ".."), "");

// Deliberately not 3000, so a suite never takes the port `bun dev` uses.
export const FRONTEND_PORT = Number(env.E2E_FRONTEND_PORT) || 3001;
export const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;
// Never started by this suite; named so the bundle's API origin is not `bun dev`'s.
export const BACKEND_URL = `http://localhost:${Number(env.E2E_BACKEND_PORT) || 8081}`;

/** What the Vite dev server is started with. */
export const FRONTEND_ENV: Record<string, string> = {
  PORT: String(FRONTEND_PORT),
  VITE_API_URL: BACKEND_URL,
};
