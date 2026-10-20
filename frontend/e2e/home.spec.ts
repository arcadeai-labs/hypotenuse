import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const) {
  test(`the public home and docs render signed out in ${scheme}`, async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await expect(page.getByTestId("home-page")).toBeVisible();
    await page.getByTestId("public-docs-link").click();
    await expect(page).toHaveURL(/\/docs/);
    await expect(page.locator("article h1").first()).toBeVisible();
  });
}

test("a copy button copies its command", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  const button = page.getByTestId("copy-button").first();
  await button.click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.length).toBeGreaterThan(0);
  // The button sits beside the command it copies.
  await expect(button.locator("xpath=..")).toContainText(copied.trim());
});

test("sign-in and sign-up render their forms", async ({ page }) => {
  await page.goto("/sign-in");
  await expect(page.getByTestId("sign-in-form")).toBeVisible();
  await page.goto("/sign-up");
  await expect(page.getByTestId("sign-up-form")).toBeVisible();
});
