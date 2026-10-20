import { defineConfig, devices } from "@playwright/test";
import {
  BACKEND_ENV,
  BACKEND_URL,
  FRONTEND_ENV,
  FRONTEND_URL,
} from "./e2e/env.ts";

/**
 * E2E config. Playwright boots the *real* backend and the Vite dev server, so
 * these specs exercise the same cross-origin path a browser takes — the only
 * way to catch a CORS or `VITE_API_URL` regression.
 *
 * `PLAYWRIGHT_CHROMIUM_PATH` points at a preinstalled Chromium when the
 * installed `@playwright/test` would otherwise download its own.
 */
export default defineConfig({
  testDir: "./e2e",
  // Wait out the backend's migrations and warm the dev server once, before the
  // workers start. See the file for why neither `webServer.url` check is enough.
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  // Two workers: every worker is a whole Chromium on an unminified dev bundle,
  // sharing the box with Vite and the backend. More turns the browsers, not the
  // server, into the bottleneck.
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
      command: "bun run start",
      cwd: "../backend",
      url: `${BACKEND_URL}/api/status`,
      // Playwright merges this over `process.env`, and Bun prefers a real
      // environment variable to `.env`, so these are the last word.
      env: BACKEND_ENV,
      stdout: "pipe",
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: "bunx vite",
      url: FRONTEND_URL,
      // Vite's `loadEnv` lets `process.env` win over `.env`, for both `PORT` and
      // the `VITE_API_URL` it inlines — which must name the e2e backend.
      env: FRONTEND_ENV,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
});
