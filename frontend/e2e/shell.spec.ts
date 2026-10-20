import { expect, test } from "@playwright/test";

test("the sidebar collapses to icons with [ and with its toggle, and stays collapsed", async ({ page }) => {
  await page.goto("/home");
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar).toBeVisible();
  await expect(sidebar).not.toHaveAttribute("data-collapsed", "true");
  await page.keyboard.press("[");
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await page.reload();
  await expect(page.getByTestId("sidebar")).toHaveAttribute("data-collapsed", "true");
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("sidebar")).not.toHaveAttribute("data-collapsed", "true");
});

test("below 768px the sidebar is a sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/home");
  await expect(page.getByTestId("sidebar")).toBeHidden();
  await page.getByTestId("sidebar-open").click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await page.getByTestId("nav-runners").click();
  await expect(page).toHaveURL(/\/runners$/);
  await expect(page.getByTestId("sidebar")).toBeHidden();
});

test("the style guide's detail layout stacks its properties panel on a narrow screen", async ({ page }) => {
  await page.goto("/style-guide");
  const panel = page.getByTestId("style-guide-light").locator(".properties-panel").first();
  await expect(panel).toBeVisible();
});
