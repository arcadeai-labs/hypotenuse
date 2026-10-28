import { defineConfig, devices } from "@playwright/test";
import { FRONTEND_ENV, FRONTEND_URL } from "./e2e/env.ts";

/**
 * The browser suite. It boots only the Vite dev server: the design system's
 * pages render from the bundle and fixtures.
 *
 * `PLAYWRIGHT_CHROMIUM_PATH` points at a preinstalled Chromium when the
 * installed `@playwright/test` would otherwise download its own.
 */
export default defineConfig({
  testDir: "./e2e",
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
  webServer: {
    command: "bunx vite",
    url: FRONTEND_URL,
    // Vite's `loadEnv` lets `process.env` win over `.env`, for both `PORT` and
    // the `VITE_API_URL` it inlines.
    env: FRONTEND_ENV,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
