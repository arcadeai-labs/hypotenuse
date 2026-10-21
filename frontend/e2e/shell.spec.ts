import { expect, test } from "@playwright/test";
import { signUp } from "./session.ts";

test("the sidebar collapses to icons with [ and with its toggle, and stays collapsed", async ({
  page,
}) => {
  await signUp(page, "Shell Shay");
  const sidebar = page.getByTestId("sidebar");
  await expect(sidebar).toBeVisible();
  await expect(sidebar).not.toHaveAttribute("data-collapsed", "true");
  await page.keyboard.press("[");
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await page.reload();
  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
  await page.getByTestId("sidebar-toggle").click();
  await expect(page.getByTestId("sidebar")).not.toHaveAttribute(
    "data-collapsed",
    "true",
  );
});

test("below 768px the sidebar is a sheet", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUp(page, "Shell Shay");
  await expect(page.getByTestId("sidebar")).toBeHidden();
  await page.getByTestId("sidebar-open").click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  await page.getByTestId("nav-runners").click();
  await expect(page).toHaveURL(/\/runners$/);
  await expect(page.getByTestId("sidebar")).toBeHidden();
  await page.getByTestId("sidebar-open").click();
  await page.getByRole("button", { name: "Close navigation" }).click();
  await expect(page.getByTestId("sidebar")).toBeHidden();
});

test("below 768px the page starts right under the top bar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await signUp(page, "Shell Shay");
  const bar = await page.locator(".shell-topbar").boundingBox();
  const header = await page.locator(".shell-page-header").first().boundingBox();
  if (!bar || !header) throw new Error("top bar or page header missing");
  expect(Math.abs(header.y - (bar.y + bar.height))).toBeLessThanOrEqual(1);
});

test("the detail layout puts properties beside the main column, and under it below 768px", async ({
  page,
}) => {
  const boxes = async () => {
    const layout = page
      .getByTestId("style-guide-light")
      .getByTestId("detail-layout");
    const main = await layout.locator(".shell-detail-main").boundingBox();
    const props = await layout
      .locator(".shell-detail-properties")
      .boundingBox();
    if (!main || !props)
      throw new Error("detail layout did not render both columns");
    return { main, props };
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/style-guide");
  const wide = await boxes();
  expect(wide.props.x).toBeGreaterThanOrEqual(
    wide.main.x + wide.main.width - 1,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await boxes();
  expect(narrow.props.y).toBeGreaterThanOrEqual(
    narrow.main.y + narrow.main.height - 1,
  );
});
