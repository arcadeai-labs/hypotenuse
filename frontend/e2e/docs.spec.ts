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

test.describe("docs diagrams", () => {
  for (const width of [1280, 375]) {
    test(`the architecture diagram draws as an SVG that fits the column at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/docs");
      const svg = page.getByTestId("mermaid-diagram").locator("svg");
      await expect(svg).toBeVisible();
      const [box, column] = await Promise.all([
        svg.boundingBox(),
        page.getByTestId("mermaid-diagram").boundingBox(),
      ]);
      if (!box || !column) throw new Error("diagram missing");
      expect(box.width).toBeLessThanOrEqual(column.width + 0.5);
      for (const label of ["webhooks", "activities", "work", "events"]) {
        await expect(svg.getByText(label, { exact: true })).toBeVisible();
      }
      const pageScrolls = () =>
        page.evaluate(
          () =>
            document.documentElement.scrollWidth >
            document.documentElement.clientWidth,
        );
      expect(await pageScrolls()).toBe(false);
      // The worktree tree is text, but it is a picture too: it must fit as well.
      await page.goto("/docs/worktrees");
      const tree = page.locator(".markdown pre").first();
      await expect(tree).toContainText("_scratch/");
      expect(
        await tree.evaluate((pre) => pre.scrollWidth > pre.clientWidth),
      ).toBe(false);
      expect(await pageScrolls()).toBe(false);
    });
  }

  test("the diagram redraws in the new theme's tokens", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/docs");
    const drawn = page.locator(".mermaid-diagram-svg");
    await expect(drawn).toHaveAttribute("data-theme-variant", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(drawn).toHaveAttribute("data-theme-variant", "dark");
    const [fill, token] = await page.evaluate(() => [
      getComputedStyle(
        document.querySelector(".mermaid-diagram svg .node rect") as Element,
      ).fill,
      getComputedStyle(document.documentElement)
        .getPropertyValue("--bg-raised")
        .trim(),
    ]);
    const probe = await page.evaluate((color) => {
      const el = document.createElement("div");
      el.style.color = color;
      document.body.append(el);
      const value = getComputedStyle(el).color;
      el.remove();
      return value;
    }, token);
    expect(fill).toBe(probe);
  });

  test("a docs page without a diagram never fetches mermaid", async ({
    page,
  }) => {
    // The package, not our `MermaidDiagram` component that imports it lazily.
    const fetched: string[] = [];
    page.on("request", (request) => {
      if (/[/.]mermaid[./@-]/.test(request.url())) fetched.push(request.url());
    });
    await page.goto("/docs/runners");
    await expect(page.getByTestId("docs-page-runners")).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(fetched).toEqual([]);
    // …and the page that has one does, so the filter above is not vacuous.
    await page.getByTestId("docs-section-index").click();
    await expect(
      page.getByTestId("mermaid-diagram").locator("svg"),
    ).toBeVisible();
    expect(fetched).not.toEqual([]);
  });
});
