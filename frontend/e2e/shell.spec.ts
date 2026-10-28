import { expect, test } from "@playwright/test";
import { LANDED, signUpApi } from "./session.ts";

test("the sidebar collapses to icons with [ and with its toggle, and stays collapsed", async ({
  page,
}) => {
  await page.goto("/status");
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

test("the sidebar lists 2.0's destinations in order, each disabled until its page exists", async ({
  page,
}) => {
  await page.goto("/status");
  const ids = await page
    .getByTestId("sidebar")
    .locator("[data-testid^='nav-']")
    .evaluateAll((items) => items.map((i) => i.getAttribute("data-testid")));
  expect(ids).toEqual([
    "nav-home",
    "nav-conversations",
    "nav-bots",
    "nav-memory",
    "nav-sandboxes",
    "nav-settings",
    "nav-docs",
  ]);
  const bots = page.getByTestId("nav-bots");
  await expect(bots).toHaveAttribute("aria-disabled", "true");
  await expect(bots).toHaveAttribute("title", "Not available yet");
  await bots.click();
  await expect(page).toHaveURL(/\/status$/);
  // Settings exists: a link, not a disabled row.
  await expect(page.getByTestId("nav-settings")).toHaveAttribute(
    "href",
    "/settings",
  );
  await page.getByTestId("nav-docs").click();
  await expect(page).toHaveURL(/\/docs\/getting-started$/);
});

test("the organization switcher sits above the project switcher and lists members and New project", async ({
  page,
}) => {
  const me = await signUpApi(page.request, "Shell Owner");
  await page.goto("/organization/projects");
  await expect(page.getByTestId("organization-switcher-toggle")).toContainText(
    "Shell Owner",
    LANDED,
  );
  const org = await page.getByTestId("organization-switcher").boundingBox();
  const project = await page.getByTestId("project-switcher").boundingBox();
  if (!org || !project) throw new Error("a switcher is missing");
  expect(org.y + org.height).toBeLessThanOrEqual(project.y + 1);
  await page.getByTestId("organization-switcher-toggle").click();
  await page.getByTestId("organization-members-link").click();
  await expect(page).toHaveURL(/\/organization\/members$/);
  await expect(page.getByTestId("organization-members")).toContainText(
    me.email,
  );
  await page.getByTestId("organization-switcher-toggle").click();
  // An owner may create projects, so the item is a live link.
  await expect(page.getByTestId("new-project-link")).not.toHaveAttribute(
    "aria-disabled",
    "true",
  );
  await page.keyboard.press("Escape");
  await page.getByTestId("project-switcher-toggle").click();
  await expect(page.getByTestId(`project-option-${me.project.id}`)).toHaveText(
    "Default",
  );
});

test("signed out, the switchers say there is nothing to switch and the account menu offers sign-in", async ({
  page,
}) => {
  await page.goto("/status");
  await expect(page.getByTestId("organization-switcher-toggle")).toContainText(
    "No organization",
  );
  await page.getByTestId("account-menu").click();
  await expect(page.getByTestId("sign-out")).toBeDisabled();
  await page.getByTestId("account-sign-in").click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("below 768px the sidebar is a sheet, mounted once", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/status");
  await expect(page.getByTestId("sidebar")).toBeHidden();
  await page.getByTestId("sidebar-open").click();
  await expect(page.getByTestId("sidebar")).toBeVisible();
  // Strict mode: a CSS-hidden second copy would make this resolve twice.
  await expect(page.getByTestId("nav-bots")).toHaveCount(1);
  await page.getByTestId("nav-docs").click();
  await expect(page).toHaveURL(/\/docs\/getting-started$/);
  await page.goto("/status");
  await page.getByTestId("sidebar-open").click();
  await page.getByRole("button", { name: "Close navigation" }).click();
  await expect(page.getByTestId("sidebar")).toBeHidden();
});

test("below 768px the page starts right under the top bar", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/status");
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
