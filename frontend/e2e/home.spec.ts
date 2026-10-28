import { expect, test } from "@playwright/test";

for (const scheme of ["light", "dark"] as const) {
  test(`the public home and docs render in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await expect(page.getByTestId("home-page")).toBeVisible();
    await expect(page.locator("h1")).toHaveText("A teammate in every channel");
    await page.getByTestId("public-docs-link").click();
    await expect(page).toHaveURL(/\/docs\/getting-started$/);
    await expect(page.locator("article h1").first()).toBeVisible();
  });
}

test("the three panels say how it works, and platforms are set as text", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".home-step h2")).toHaveText([
    "Mention it where you work",
    "It remembers the channel",
    "It hands code to a sandbox",
  ]);
  await expect(page.getByTestId("home-platforms")).toContainText(
    "Slack · Linear · Pylon · API",
  );
});

test("the status chip is as wide as its words, not the column", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  const chip = await page.getByTestId("home-status").boundingBox();
  const lede = await page.locator(".home-lede").boundingBox();
  if (!chip || !lede) throw new Error("chip or lede missing");
  expect(chip.width).toBeLessThan(lede.width / 3);
});

test("the footer credits arcade-labs with a link to the repository", async ({
  page,
}) => {
  await page.goto("/");
  const attribution = page.getByTestId("public-footer-attribution");
  await expect(attribution).toHaveText("an arcade-labs project");
  await expect(attribution).toHaveAttribute(
    "href",
    "https://github.com/arcadeai-labs/hypotenuse",
  );
});

test("an unknown path lands on the home page", async ({ page }) => {
  await page.goto("/no/such/page");
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByTestId("home-page")).toBeVisible();
});
