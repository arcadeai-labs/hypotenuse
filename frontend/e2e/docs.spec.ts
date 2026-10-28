import { expect, test } from "@playwright/test";

test("/docs opens the first page, and its rail links to its headings", async ({
  page,
}) => {
  await page.goto("/docs");
  await expect(page).toHaveURL(/\/docs\/getting-started$/);
  await expect(page.getByTestId("docs-page-getting-started")).toBeVisible();
  await expect(page.locator("article h1").first()).toHaveText(
    "Getting started",
  );
  await page.locator(".docs-rail a", { hasText: "Light and dark" }).click();
  await expect(page).toHaveURL(/#light-and-dark$/);
  await expect(page.locator("#light-and-dark")).toBeInViewport();
});

test("an embedded illustration follows the app's theme, not the OS", async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/docs/getting-started");
  const image = page.locator("article img.themed-image");
  await expect(image).toHaveAttribute(
    "src",
    "/doc-assets/illustrations/shell-light.png",
  );
  await page.getByTestId("theme-toggle").click(); // System → Light
  await page.getByTestId("theme-toggle").click(); // Light → Dark
  await expect(image).toHaveAttribute(
    "src",
    "/doc-assets/illustrations/shell-dark.png",
  );
  await image.scrollIntoViewIfNeeded();
  expect(
    await image.evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBeGreaterThan(0);
});

test("an unknown docs page says so inside the docs frame", async ({ page }) => {
  await page.goto("/docs/no-such-page");
  await expect(page.getByTestId("docs-not-found")).toBeVisible();
  await expect(page.getByTestId("docs-layout")).toBeVisible();
});

test("below 768px the section nav folds behind the current page, and nothing scrolls sideways", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto("/docs/getting-started");
  const toggle = page.getByTestId("docs-nav-toggle");
  await expect(toggle).toHaveText("Getting started");
  await expect(page.getByTestId("docs-nav")).toBeHidden();
  await toggle.click();
  await expect(page.getByTestId("docs-nav")).toBeVisible();
  const [scroll, client] = await page.evaluate(() => [
    document.documentElement.scrollWidth,
    document.documentElement.clientWidth,
  ]);
  expect(scroll).toBeLessThanOrEqual(client);
});

test("a reload of /docs serves the app, not a redirect", async ({
  request,
}) => {
  const response = await request.get("/docs", { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("text/html");
});
