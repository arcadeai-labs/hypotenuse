import { defineConfig, devices } from "@playwright/test";

/** The port the e2e dev server binds; separate from `bun dev`'s so both can run. */
const PORT = Number(process.env.E2E_FRONTEND_PORT) || 3100;

/**
 * E2E config. These specs drive the frontend alone: theme, shell, keyboard, and
 * the public pages need no backend. Specs that do will add the backend as a
 * second `webServer`.
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
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "bunx vite",
    url: `http://localhost:${PORT}`,
    // Vite's `loadEnv` lets the process environment win over `.env`.
    env: { PORT: String(PORT) },
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
