import { chromium, type FullConfig } from "@playwright/test";
import { BACKEND_URL } from "./env.ts";

/**
 * Wait until the backend has finished migrating its database.
 *
 * Playwright's `webServer.url` check answers this wrong: keryx binds the web
 * server *before* `DATABASE_AUTO_MIGRATE` has created a table, so a probe that
 * only asks whether the port is open releases the suite against an empty schema
 * — which nobody notices against a warm database and every fresh CI run trips
 * over. `/api/status` reports `healthy` only once its database check, which
 * reads the newest migration's column, succeeds.
 * @throws {Error} If the schema has not appeared before the deadline.
 */
async function waitForMigrations(): Promise<void> {
  const deadline = Date.now() + 60_000;
  let lastError = "no response";

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BACKEND_URL}/api/status`);
      if (response.ok) {
        const body = (await response.json()) as {
          healthy?: boolean;
          checks?: { database?: boolean };
        };
        if (body.healthy === true && body.checks?.database === true) return;
        lastError = `HTTP ${response.status}: not healthy yet (${JSON.stringify(body.checks)})`;
      } else {
        lastError = `HTTP ${response.status}: ${await response.text()}`;
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(
    `The e2e backend at ${BACKEND_URL} never finished migrating. Last response — ${lastError}`,
  );
}

/**
 * Wait for the backend's schema, then warm the Vite dev server, before any
 * worker runs. `webServer.url` is satisfied by `index.html`, which Vite serves
 * before transforming a single module, so the first page in each worker would
 * otherwise pay for the whole module graph and the Sass compile on its own
 * assertion clock. Loading real pages here pays that once, on nobody's clock.
 * @param config - The Playwright config, for `baseURL`.
 */
export default async function globalSetup(config: FullConfig) {
  await waitForMigrations();

  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) return;

  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  );
  try {
    const page = await browser.newPage();
    // A protected route, so the auth context, the router, and the shell compile
    // too — not just the public page.
    await page.goto(`${baseURL}/settings`, { waitUntil: "networkidle" });
    await page.goto(`${baseURL}/style-guide`, { waitUntil: "networkidle" });
  } finally {
    await browser.close();
  }
}
