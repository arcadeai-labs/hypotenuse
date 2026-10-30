import { expect, type Page, test } from "@playwright/test";

const mod = process.platform === "darwin" ? "Meta" : "Control";

/**
 * Open `/status` and wait until the page has rendered the server's answer. A
 * key pressed the instant `goto` returns can land before React has mounted the
 * shell and attached its keymap; the answer arriving is a later render, so by
 * then the listener is there.
 * @param page - The page.
 */
async function openStatus(page: Page): Promise<void> {
  await page.goto("/status");
  await expect(page.getByTestId("status-page")).toContainText(
    /is healthy|did not answer/,
  );
}

test("⌘K opens the palette, filters, and runs a navigation command", async ({
  page,
}) => {
  await openStatus(page);
  await page.keyboard.press(`${mod}+k`);
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.getByTestId("command-palette-input").fill("style guide");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/docs\/style-guide$/);
});

test("a destination that is not built yet is neither offered nor reachable by its keys", async ({
  page,
}) => {
  await openStatus(page);
  await page.keyboard.press("g");
  await page.keyboard.press("m");
  await expect(page).toHaveURL(/\/status$/);
  await page.keyboard.press(`${mod}+k`);
  await page.getByTestId("command-palette-input").fill("Memory");
  await expect(
    page.getByTestId("command-palette").getByText("Go to Memory"),
  ).toHaveCount(0);
});

test("a half-typed g survives a re-render", async ({ page }) => {
  await page.goto("/status");
  // The status page re-renders when the server's answer (or its absence)
  // arrives; a matcher rebuilt on render would drop the buffered `g`.
  await page.keyboard.press("g");
  await expect(page.getByTestId("status-page")).toContainText(
    /is healthy|did not answer/,
  );
  await page.keyboard.press("[");
  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
});

test("? shows the shortcut sheet and Escape closes it", async ({ page }) => {
  await openStatus(page);
  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();
  await expect(page.getByTestId("shortcut-sheet")).toContainText(
    "Toggle sidebar",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shortcut-sheet")).toBeHidden();
});

test("the palette switches the theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openStatus(page);
  await page.keyboard.press(`${mod}+k`);
  await page.getByTestId("command-palette-input").fill("Theme: Dark");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
