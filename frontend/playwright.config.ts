import { defineConfig, devices } from "@playwright/test";
import {
  BACKEND_ENV,
  BACKEND_URL,
  FRONTEND_ENV,
  FRONTEND_URL,
} from "./e2e/env.ts";

/**
 * The browser suite. It boots the real backend (against its own database and
 * Redis index; see `e2e/env.ts`) and the Vite dev server, so the signed-in
 * specs take the same cross-origin path a browser does. Public pages and the
 * style guide still render from the bundle and fixtures.
 *
 * `PLAYWRIGHT_CHROMIUM_PATH` points at a preinstalled Chromium when the
 * installed `@playwright/test` would otherwise download its own.
 */
export default defineConfig({
  testDir: "./e2e",
  // Wait out the backend's migrations and warm the dev server once, before
  // the workers start. See the file for why `webServer.url` is not enough.
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  workers: 2,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: FRONTEND_URL,
    trace: "on-first-retry",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      // Creates the e2e database when it is missing, then starts the server.
      command: "bun scripts/e2e-backend.ts",
      url: `${BACKEND_URL}/api/status`,
      // Playwright merges this over `process.env`, and Bun prefers a real
      // environment variable to `.env`, so these are the last word.
      env: BACKEND_ENV,
      stdout: "pipe",
      reuseExistingServer: !process.env.CI,
      timeout: 90_000,
    },
    {
      command: "bunx vite",
      url: FRONTEND_URL,
      // Vite's `loadEnv` lets `process.env` win over `.env`, for both `PORT`
      // and the `VITE_API_URL` it inlines — which must name the e2e backend.
      env: FRONTEND_ENV,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
