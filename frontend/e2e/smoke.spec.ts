import { expect, test } from "@playwright/test";

test.describe("smoke", () => {
  test("renders the landing page", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "ToolExec" })).toBeVisible();
    await expect(page.getByTestId("navbar")).toBeVisible();
  });

  test("draws the software factory DAG on the landing page", async ({
    page,
  }) => {
    await page.goto("/");

    const dag = page.getByTestId("software-factory-dag");
    await expect(dag).toBeVisible();

    // The start node carries the trigger, and every station names its agent.
    // Statuses are deliberately not asserted: the panel replays a run, so the
    // one thing that changes between frames is the thing a test must not pin.
    await expect(dag).toContainText("ticket: ACME-4127");
    for (const agent of [
      "spec-writer",
      "implementer",
      "test-writer",
      "reviewer",
      "doc-writer",
      "release-manager",
    ]) {
      await expect(
        dag.locator(".react-flow__node", { hasText: agent }),
      ).toHaveCount(1);
    }

    // A hop label is the hand-off. It is HTML, not SVG text, which is the
    // whole reason the custom edge type exists.
    await expect(dag).toContainText("artifact");
  });

  test("reaches the backend across origins", async ({ page }) => {
    // The health readout lives on its own route. It is still the page
    // that proves CORS and `VITE_API_URL` are wired correctly, because the table
    // only populates if the cross-origin `apiFetch` succeeded.
    await page.goto("/status");

    await expect(page.getByTestId("status-loading")).toBeHidden();
    await expect(page.getByTestId("status-table")).toBeVisible();

    const rows = page.getByTestId("status-table").locator("tbody tr");
    await expect(rows.filter({ hasText: "Database" })).toContainText("up");
    await expect(rows.filter({ hasText: "Redis" })).toContainText("up");
  });

  test("client-side routing resolves the auth shells", async ({ page }) => {
    await page.goto("/");

    await page.getByRole("link", { name: "Get started" }).click();
    await expect(page.getByTestId("sign-up-card")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/sign-up");

    await page.getByTestId("sign-in-link-from-sign-up").click();
    await expect(page.getByTestId("sign-in-card")).toBeVisible();
  });

  test("serves the terminal favicon the document points at", async ({
    page,
    request,
  }) => {
    await page.goto("/");

    const href = await page.locator('link[rel="icon"]').getAttribute("href");
    expect(href).toBe("/favicon.svg");

    const res = await request.get(href as string);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("image/svg+xml");

    const svg = await res.text();
    // Phosphor on ground, and not the purple bolt Vite scaffolds — a favicon is
    // the one asset nothing else in the suite would notice going stale.
    expect(svg).toContain("#33ff66");
    expect(svg).toContain("#0a0a0a");
    expect(svg.toLowerCase()).not.toContain("863bff");
  });
});
