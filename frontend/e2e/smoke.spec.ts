import { expect, test } from "@playwright/test";

test.describe("smoke", () => {
  test("reaches the backend across origins", async ({ page }) => {
    // The status page only fills in if the cross-origin `apiFetch` succeeded,
    // so it is what proves CORS and `VITE_API_URL` are wired correctly.
    await page.goto("/status");
    const status = page.getByTestId("status");
    await expect(status).toBeVisible();
    await expect(status).toContainText("Database");
    await expect(page.getByTestId("status-error")).toHaveCount(0);
  });

  test("a signed-out visitor to the app is sent to sign in", async ({
    page,
  }) => {
    for (const path of ["/home", "/settings", "/audit", "/invites"]) {
      await page.goto(path);
      await expect(page.getByTestId("sign-in-form")).toBeVisible();
      expect(new URL(page.url()).pathname).toBe("/sign-in");
    }
  });

  test("client-side routing moves between the auth forms", async ({ page }) => {
    await page.goto("/sign-in");
    await page.getByRole("link", { name: "Create an account" }).click();
    await expect(page.getByTestId("sign-up-form")).toBeVisible();
    await page
      .getByTestId("sign-up-card")
      .getByRole("link", { name: "Sign in", exact: true })
      .click();
    await expect(page.getByTestId("sign-in-form")).toBeVisible();
  });

  test("the forms validate before they post", async ({ page }) => {
    await page.goto("/sign-up");
    await page.getByTestId("sign-up-submit").click();
    await expect(page.locator(".auth-error")).toHaveCount(3);
    expect(new URL(page.url()).pathname).toBe("/sign-up");
  });
});
