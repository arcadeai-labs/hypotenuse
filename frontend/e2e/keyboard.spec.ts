import { expect, test } from "@playwright/test";

const mod = process.platform === "darwin" ? "Meta" : "Control";

test("⌘K opens the palette, filters, and runs a navigation command", async ({
  page,
}) => {
  await page.goto("/home");
  await page.keyboard.press(`${mod}+k`);
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.getByTestId("command-palette-input").fill("runners");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/runners$/);
  await expect(page.getByTestId("command-palette")).toBeHidden();
});

test("g s goes to Sessions", async ({ page }) => {
  await page.goto("/home");
  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await expect(page).toHaveURL(/\/sessions$/);
});

test("? shows the shortcut sheet and Escape closes it", async ({ page }) => {
  await page.goto("/home");
  await page.keyboard.press("?");
  await expect(page.getByTestId("shortcut-sheet")).toBeVisible();
  await expect(page.getByTestId("shortcut-sheet")).toContainText(
    "Go to Sessions",
  );
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("shortcut-sheet")).toBeHidden();
});

test("the palette switches the theme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/home");
  await page.keyboard.press(`${mod}+k`);
  await page.getByTestId("command-palette-input").fill("Theme: Dark");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
});
