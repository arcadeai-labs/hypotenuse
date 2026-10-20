import { expect, test } from "@playwright/test";
import { LANDED, openSection, openSettings, signUp } from "./session.ts";

/**
 * The project settings area in a real browser: the section sidebar, renaming,
 * tags, the MCP endpoint, the unsaved-edits guard, and deleting a project.
 */

test.describe("project settings", () => {
  test("every section is listed, and one is mounted at a time", async ({
    page,
  }) => {
    await signUp(page, "Navvy Nadia");
    await openSettings(page);

    for (const slug of ["general", "mcp", "members", "tags", "danger"]) {
      await expect(page.getByTestId(`section-${slug}`)).toBeVisible();
    }

    // `/settings` redirects to the default section rather than rendering all.
    await expect(page.getByTestId("project-name-card")).toBeVisible(LANDED);
    await expect(page.getByTestId("tags-card")).toHaveCount(0);

    // A typo'd bookmark says so, inside the settings chrome.
    await page.goto("/settings/nonsense");
    await expect(page.getByTestId("no-such-section")).toBeVisible(LANDED);
    await expect(page.getByTestId("settings-section-nav")).toBeVisible();
  });

  test("renaming the project moves the sidebar's switcher with it", async ({
    page,
  }) => {
    // The switcher reads `AuthContext`, not this page, so a rename that skips
    // `refresh()` succeeds everywhere except the one place the user is looking.
    await signUp(page, "Rena Namer");
    await openSettings(page);

    await page.getByTestId("project-name").fill("Renamed by e2e");
    await page.getByTestId("save-general").click();
    await expect(page.getByTestId("general-notice")).toBeVisible(LANDED);
    await expect(page.getByTestId("project-switcher-toggle")).toHaveText(
      "Renamed by e2e",
      LANDED,
    );
  });

  test("tags are created and deleted, and the admin tag cannot be", async ({
    page,
  }) => {
    await signUp(page, "Tagger Tess");
    await openSettings(page);
    await openSection(page, "tags");

    await page.getByTestId("new-tag-name").fill("reviewers");
    await page.getByTestId("new-tag-submit").click();
    await expect(page.getByTestId("tag-list")).toContainText("reviewers");

    await page
      .getByRole("button", { name: "Delete the reviewers tag" })
      .click();
    await expect(page.getByTestId("tag-list")).not.toContainText("reviewers");
    await expect(
      page.getByRole("button", { name: "Delete the admin tag" }),
    ).toHaveCount(0);
  });

  test("the MCP endpoint is the server's own URL", async ({ page }) => {
    await signUp(page, "Mcp Mira");
    await openSettings(page);
    await openSection(page, "mcp");
    await expect(page.getByTestId("mcp-url")).toHaveValue(/\/mcp$/, LANDED);
  });

  test("leaving a section with unsaved edits asks first", async ({ page }) => {
    await signUp(page, "Dirty Dora");
    await openSettings(page);

    await page.getByTestId("project-name").fill("Half-typed name");
    await expect(page.getByTestId("section-dirty")).toBeVisible();

    await page.getByTestId("section-members").click();
    await expect(page.getByTestId("discard-changes-modal")).toBeVisible();

    // Staying keeps both the URL and the draft.
    await page.getByTestId("discard-cancel").click();
    await expect(page).toHaveURL(/\/settings\/general$/);
    await expect(page.getByTestId("project-name")).toHaveValue(
      "Half-typed name",
    );

    await page.getByTestId("section-members").click();
    await page.getByTestId("discard-confirm").click();
    await expect(page).toHaveURL(/\/settings\/members$/, LANDED);
    await expect(page.getByTestId("members-table")).toBeVisible(LANDED);

    // …and the draft is gone, rather than waiting to be posted by the next save.
    await page.getByTestId("section-general").click();
    await expect(page.getByTestId("project-name")).not.toHaveValue(
      "Half-typed name",
      LANDED,
    );
  });

  test("the narrow disclosure closes even when the guard answers first", async ({
    page,
  }) => {
    await signUp(page, "Narrow Nadia");
    await openSettings(page);
    await page.setViewportSize({ width: 390, height: 844 });

    const list = page.locator(".section-nav");
    const toggle = page.getByTestId("section-nav-toggle");

    await page.getByTestId("project-name").fill("Half-typed name");
    await toggle.click();
    await expect(list).toBeVisible();
    await expect(page.getByTestId("section-dirty")).toBeVisible();

    await page.getByTestId("section-members").click();
    await expect(page.getByTestId("discard-changes-modal")).toBeVisible();
    await page.getByTestId("discard-confirm").click();

    await expect(page).toHaveURL(/\/settings\/members$/, LANDED);
    await expect(page.getByTestId("members-table")).toBeVisible(LANDED);
    await expect(list).toBeHidden();
    await expect(toggle).toHaveText("Members");
  });

  test("deleting a project needs its name, and lands somewhere that exists", async ({
    page,
  }) => {
    await signUp(page, "Delia Deleter");

    // A second project, so deleting the first leaves somewhere to land.
    await page.getByTestId("project-switcher-toggle").click();
    await page.getByTestId("new-project-link").click();
    await page.getByTestId("new-project-name").fill("Doomed project");
    await page.getByTestId("new-project-submit").click();
    await expect(page.getByTestId("project-switcher-toggle")).toHaveText(
      "Doomed project",
      LANDED,
    );

    await openSettings(page);
    await openSection(page, "danger");
    const confirm = page.getByTestId("delete-project-confirm");
    await expect(confirm).toBeDisabled();
    await page.getByTestId("delete-project-name").fill("Doomed project");
    await confirm.click();

    await expect(page.getByTestId("project-switcher-toggle")).toHaveText(
      "Delia Deleter's Project",
      LANDED,
    );
  });
});
