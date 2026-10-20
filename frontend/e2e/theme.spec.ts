import { expect, test } from "@playwright/test";
import tokens from "../../design/tokens.json" with { type: "json" };
import { signUp } from "./session.ts";

// The stored theme must apply before first paint. The boot script in
// index.html is what guarantees it; these assert the property, not a delay.

const bgOf = (page: import("@playwright/test").Page) =>
  page.evaluate(() =>
    getComputedStyle(document.documentElement)
      .getPropertyValue("--bg-app")
      .trim(),
  );

test("a stored Dark applies before first paint on a light OS", async ({
  browser,
}) => {
  const context = await browser.newContext({ colorScheme: "light" });
  await context.addInitScript(() =>
    localStorage.setItem("hypotenuse.theme", "dark"),
  );
  const page = await context.newPage();
  // Record the theme attribute at DOMContentLoaded — before React has run.
  await context.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      (window as unknown as { firstTheme: string }).firstTheme =
        document.documentElement.dataset.theme ?? "";
    });
  });
  await page.goto("/");
  expect(
    await page.evaluate(
      () => (window as unknown as { firstTheme: string }).firstTheme,
    ),
  ).toBe("dark");
  expect(await bgOf(page)).toBe(tokens.dark["bg-app"]);
  await context.close();
});

test("System follows the OS live, without a reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await bgOf(page)).toBe(tokens.dark["bg-app"]);
});

test("the account menu's choice persists across a reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await signUp(page, "Theme Theo");
  await page.getByTestId("account-menu").click();
  await page.getByTestId("theme-dark").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(
    await page.evaluate(() => localStorage.getItem("hypotenuse.theme")),
  ).toBe("dark");
});
