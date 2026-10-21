import { expect, test } from "@playwright/test";
import { LANDED, signUp } from "./session.ts";

test.describe("public docs", () => {
  test("every account and project page is reachable from the docs nav", async ({
    page,
  }) => {
    await page.goto("/docs");
    for (const [slug, heading] of [
      ["getting-started", "Getting started"],
      ["accounts", "Accounts"],
      ["projects", "Projects"],
      ["members", "Members and tags"],
      ["audit", "Audit log"],
    ] as const) {
      await page.getByTestId(`docs-section-${slug}`).click();
      await expect(page).toHaveURL(new RegExp(`/docs/${slug}$`));
      await expect(page.getByTestId(`docs-page-${slug}`)).toBeVisible();
      await expect(page.locator("article h1").first()).toHaveText(heading);
    }
  });

  test("below 768px the section nav folds behind the current section, and no page scrolls sideways or hides a linked heading", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/docs/runners");
    const toggle = page.getByTestId("docs-nav-toggle");
    await expect(toggle).toHaveText("Runners");
    await expect(page.getByTestId("docs-nav")).toBeHidden();
    await toggle.click();
    await expect(page.getByTestId("docs-nav")).toBeVisible();
    await page.getByTestId("docs-section-cli").click();
    await expect(page).toHaveURL(/\/docs\/cli$/);
    await expect(page.getByTestId("docs-nav")).toBeHidden();
    await expect(toggle).toHaveText("The CLI");
    for (const slug of ["runners", "cli", "agent-sessions", "members"]) {
      await page.goto(`/docs/${slug}`);
      await expect(page.getByTestId(`docs-page-${slug}`)).toBeVisible();
      const [scroll, client] = await page.evaluate(() => [
        document.documentElement.scrollWidth,
        document.documentElement.clientWidth,
      ]);
      expect(scroll, slug).toBeLessThanOrEqual(client);
    }
    await page.goto("/docs/cli#commands");
    const heading = await page.locator("#commands").boundingBox();
    const picker = await page.locator(".docs-nav-frame").boundingBox();
    if (!heading || !picker) throw new Error("heading or picker missing");
    expect(heading.y).toBeGreaterThanOrEqual(picker.y + picker.height);
  });

  test("docs stay readable signed in, and offer a way back into the app", async ({
    page,
  }) => {
    await signUp(page, "Reader Rex");
    await page.goto("/docs/members");
    await expect(page.getByTestId("docs-page-members")).toBeVisible();
    await page.getByTestId("public-app-link").click();
    await expect(page).toHaveURL(/\/home$/, LANDED);
  });
});
