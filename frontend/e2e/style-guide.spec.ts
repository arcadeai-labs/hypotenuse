import { expect, test } from "@playwright/test";
import tokens from "../../design/tokens.json" with { type: "json" };

test("the style guide paints each half from its own theme's tokens", async ({
  page,
}) => {
  await page.goto("/docs/style-guide");
  for (const theme of ["light", "dark"] as const) {
    const half = page.getByTestId(`style-guide-${theme}`);
    const bg = await half.evaluate(
      (el) => getComputedStyle(el).backgroundColor,
    );
    const hex = tokens[theme]["bg-app"];
    const [r, g, b] = [1, 3, 5].map((i) =>
      Number.parseInt(hex.slice(i, i + 2), 16),
    );
    expect(bg, theme).toBe(`rgb(${r}, ${g}, ${b})`);
  }
});

test("every bot avatar on the style guide carries the bot badge", async ({
  page,
}) => {
  await page.goto("/docs/style-guide");
  const bots = page.locator(".ui-avatar-bot");
  expect(await bots.count()).toBeGreaterThan(0);
  for (const avatar of await bots.all()) {
    await expect(
      avatar.locator("xpath=..").locator(".ui-bot-badge"),
    ).toHaveCount(1);
  }
});

test("questions and approvals link to where they were asked", async ({
  page,
}) => {
  await page.goto("/docs/style-guide");
  const light = page.getByTestId("style-guide-light");
  await expect(light.getByTestId("tx-question")).toContainText(
    "Answer in Linear",
  );
  await expect(light.getByTestId("tx-approval")).toContainText(
    "Answer in Linear",
  );
});

test("the memory explorer moves between scopes", async ({ page }) => {
  await page.goto("/docs/style-guide");
  const explorer = page
    .getByTestId("style-guide-light")
    .getByTestId("memory-explorer");
  await explorer.getByRole("button", { name: /#billing/ }).click();
  await expect(explorer).toContainText("Globex is on the annual plan");
});

test("the style guide's old address lands on its docs page", async ({
  page,
}) => {
  await page.goto("/style-guide");
  await expect(page).toHaveURL(/\/docs\/style-guide$/);
  await expect(page.getByTestId("docs-section-style-guide")).toHaveClass(
    /active/,
  );
});
