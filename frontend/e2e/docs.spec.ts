import { expect, test } from "@playwright/test";

test.describe("public docs", () => {
  test("signed-out visitors can read docs", async ({ page }) => {
    await page.goto("/docs");

    await expect(page.getByTestId("docs-title")).toBeVisible();
    await expect(page.getByTestId("docs-section-nav")).toBeVisible();
    await expect(page.getByTestId("docs-page-overview")).toBeVisible();
    await expect(page.getByTestId("docs-markdown-overview")).toContainText(
      "What is ToolExec",
    );

    // Still signed out — the public chrome, not a bounce to /sign-in.
    await expect(page.getByTestId("user-menu-toggle")).toContainText(
      "Signed out",
    );
    expect(new URL(page.url()).pathname).toBe("/docs/overview");
  });

  test("Why ToolExec and the CLI are reachable from the landing page", async ({
    page,
  }) => {
    await page.goto("/");
    const factoryDag = page.getByTestId("software-factory-dag");
    await expect(factoryDag).toBeVisible();
    await expect(factoryDag).toContainText("Live execution timeline");
    const studioModes = factoryDag.getByRole("navigation", {
      name: "Studio preview mode",
    });
    for (const mode of ["Build", "Watch", "Replay"]) {
      await expect(studioModes.getByText(mode, { exact: true })).toBeVisible();
    }
    await page.getByRole("link", { name: "Read about workflows" }).click();
    await expect(page.getByTestId("docs-page-workflows")).toBeVisible();
    await expect(page.getByTestId("docs-markdown-workflows")).toContainText(
      "Parallel by default",
    );
    expect(new URL(page.url()).pathname).toBe("/docs/workflows");

    await page.goto("/");
    await page.getByRole("link", { name: "Why ToolExec" }).click();
    await expect(page.getByTestId("docs-page-why")).toBeVisible();
    await expect(page.getByTestId("docs-markdown-why")).toContainText(
      "Why ToolExec",
    );
    expect(new URL(page.url()).pathname).toBe("/docs/why");

    await page.goto("/");
    await page.getByRole("link", { name: "CLI", exact: true }).click();
    await expect(page.getByTestId("docs-page-cli")).toBeVisible();
    expect(new URL(page.url()).pathname).toBe("/docs/cli");

    await page.getByTestId("section-security").click();
    await expect(page.getByTestId("docs-page-security")).toBeVisible();
    await expect(page.getByTestId("docs-markdown-security")).toContainText(
      "Git access",
    );
  });

  test("the navbar Docs link is present without a session", async ({
    page,
  }) => {
    await page.goto("/status");
    await page.getByTestId("docs-link").click();
    await expect(page.getByTestId("docs-title")).toBeVisible();
  });

  test("an unknown docs slug keeps the sidebar chrome", async ({ page }) => {
    await page.goto("/docs/no-such-page");
    await expect(page.getByTestId("docs-section-nav")).toBeVisible();
    await expect(page.getByTestId("no-such-docs-page")).toBeVisible();
  });
});
