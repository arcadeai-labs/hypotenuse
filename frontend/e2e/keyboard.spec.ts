import { expect, test } from "@playwright/test";

const mod = process.platform === "darwin" ? "Meta" : "Control";

test("⌘K opens the palette, filters, and runs a navigation command", async ({
  page,
}) => {
  await page.goto("/status");
  await page.keyboard.press(`${mod}+k`);
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.getByTestId("command-palette-input").fill("style guide");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/style-guide$/);
});

test("a destination that is not built yet is neither offered nor reachable by its keys", async ({
  page,
}) => {
  await page.goto("/status");
  await page.keyboard.press("g");
  await page.keyboard.press("c");
  await expect(page).toHaveURL(/\/status$/);
  await page.keyboard.press(`${mod}+k`);
  await page.getByTestId("command-palette-input").fill("Conversations");
  await expect(
    page.getByTestId("command-palette").getByText("Go to Conversations"),
  ).toHaveCount(0);
});

test("a half-typed g survives a re-render", async ({ page }) => {
  await page.goto("/status");
  // The status page re-renders when the server's answer (or its absence)
  // arrives; a matcher rebuilt on render would drop the buffered `g`.
  await page.keyboard.press("g");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.keyboard.press("[");
  await expect(page.getByTestId("sidebar")).toHaveAttribute(
    "data-collapsed",
    "true",
  );
});

test("? shows the shortcut sheet and Escape closes it", async ({ page }) => {
  await page.goto("/status");
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
  await page.goto("/status");
  await page.keyboard.press(`${mod}+k`);
  await page.getByTestId("command-palette-input").fill("Theme: Dark");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
