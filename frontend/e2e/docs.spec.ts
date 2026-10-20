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
