import { expect, test } from "@playwright/test";
import { LANDED, signUp } from "./session.ts";

/**
 * The runner fleet: registering from the browser shows the token once, the
 * view toggles with `v`, and a revocation in one tab flips another tab's
 * fleet live over `project:<id>:runners`.
 */

test.describe("runners", () => {
  test.setTimeout(60_000);

  test("register shows the token once; revoke flips another tab live", async ({
    page,
    context,
  }) => {
    await signUp(page, "Fleet Fran");
    await page.getByTestId("nav-runners").click();
    await expect(page.getByTestId("runners-empty")).toBeVisible(LANDED);

    const watcher = await context.newPage();
    await watcher.goto("/runners");
    await expect(watcher.getByTestId("runners-empty")).toBeVisible(LANDED);

    await page.getByTestId("register-runner").click();
    await expect(page.getByTestId("register-runner-commands")).toContainText(
      "hypotenuse runner register",
    );
    await page.getByTestId("register-runner-name").fill("e2e-box");
    await page.getByTestId("register-runner-submit").click();
    const token = page.getByTestId("register-runner-token");
    await expect(token).toHaveText(/^hyp_rt_/, LANDED);
    await expect(page.getByTestId("register-runner-credentials")).toContainText(
      '"name": "e2e-box"',
    );
    await page.getByTestId("register-runner-close").click();
    // Closing forgets it: reopening starts a fresh form.
    await page.getByTestId("register-runner").click();
    await expect(page.getByTestId("register-runner-token")).toHaveCount(0);
    await page.getByTestId("register-runner-name").press("Escape");

    // The other tab heard about the registration.
    const card = watcher.locator('[data-testid^="runner-card-"]');
    await expect(card).toContainText("e2e-box", { timeout: 15_000 });

    // `v` toggles cards and table.
    await page.locator("body").click();
    await page.keyboard.press("v");
    await expect(page.getByTestId("runners-table")).toBeVisible();
    await page.keyboard.press("v");
    await expect(page.getByTestId("runners-cards")).toBeVisible();

    await page.locator('[data-testid^="revoke-runner-"]').first().click();
    await page.getByTestId("runner-revoke-confirm").click();
    await expect(watcher.getByTestId("runners-empty")).toBeVisible({
      timeout: 15_000,
    });
  });
});
