import { expect, test } from "@playwright/test";
import { LANDED, signUp } from "./session.ts";

/**
 * The Routing page: the project's ordered rules (added here — a project gets
 * its seeded ones when Linear connects), a reorder that survives a reload, the
 * enable toggle, and the
 * preview — which, with no Linear connected, says so instead of guessing.
 */

test.describe("routing", () => {
  test.setTimeout(60_000);

  test("reorder persists, a rule toggles, and the preview needs Linear", async ({
    page,
  }) => {
    await signUp(page, "Router Ray");
    await page.getByTestId("nav-routing").click();
    await expect(page.getByTestId("no-rules")).toBeVisible(LANDED);
    for (const [name, prefix] of [
      ["Plan", "/plan"],
      ["Build", "/build"],
    ]) {
      await page.getByTestId("rule-add").click();
      await page.getByTestId("rule-name").fill(name);
      await page.getByTestId("rule-prefix").fill(prefix);
      await page.getByTestId("rule-submit").click();
      await expect(page.getByTestId("rule-form")).toHaveCount(0, LANDED);
    }
    const rows = page.locator('tr[data-testid^="routing-rule-"]');
    await expect(rows).toHaveCount(2, LANDED);
    await expect(rows.first()).toBeVisible(LANDED);
    const first = await rows.first().getAttribute("data-testid");
    const second = await rows.nth(1).getAttribute("data-testid");
    const firstId = first?.replace("routing-rule-", "");

    await page.getByTestId(`rule-down-${firstId}`).click();
    await expect(rows.first()).toHaveAttribute("data-testid", second ?? "");
    await page.reload();
    await expect(rows.first()).toHaveAttribute(
      "data-testid",
      second ?? "",
      LANDED,
    );

    const toggle = page.getByTestId(`rule-toggle-${firstId}`);
    const was = await toggle.isChecked();
    await toggle.click();
    await expect(toggle).toBeChecked({ checked: !was });

    await page.getByTestId("preview-issue").fill("ENG-1");
    await page.getByTestId("preview-run").click();
    await expect(page.getByTestId("preview-error")).toContainText(
      "Connect Linear",
      LANDED,
    );
  });
});
