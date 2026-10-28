import { chromium, type FullConfig } from "@playwright/test";
import { BACKEND_URL } from "./env.ts";

/**
 * Wait until the backend has finished migrating its database. Keryx binds the
 * web server before `DATABASE_AUTO_MIGRATE` has created a table, so a probe
 * that only asks whether the port answers releases the suite against an empty
 * schema — which a warm database hides and a fresh CI run trips over.
 * `/api/status` is healthy only once its database check succeeds.
 * @throws {Error} If the backend is not healthy before the deadline.
 */
async function waitForBackend(): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last = "no response";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BACKEND_URL}/api/status`);
      const body = (await response.json()) as { healthy?: boolean };
      if (response.ok && body.healthy === true) return;
      last = `HTTP ${response.status}: ${JSON.stringify(body)}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `The e2e backend at ${BACKEND_URL} never became healthy. Last answer: ${last}`,
  );
}

/**
 * Wait for the backend, then warm the Vite dev server before any worker runs:
 * `webServer.url` is satisfied by `index.html`, which Vite serves before
 * transforming a module, so the first page in each worker would otherwise pay
 * for the whole module graph on its own assertion clock.
 * @param config - The Playwright config, for `baseURL`.
 */
export default async function globalSetup(config: FullConfig) {
  await waitForBackend();
  const baseURL = config.projects[0]?.use?.baseURL;
  if (!baseURL) return;
  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  );
  try {
    const page = await browser.newPage();
    await page.goto(`${baseURL}/status`, { waitUntil: "networkidle" });
    await page.goto(`${baseURL}/sign-in`, { waitUntil: "networkidle" });
    await page.goto(`${baseURL}/docs/style-guide`, {
      waitUntil: "networkidle",
    });
  } finally {
    await browser.close();
  }
}
