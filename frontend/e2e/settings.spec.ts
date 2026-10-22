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

    for (const slug of [
      "general",
      "integrations",
      "routing",
      "mcp",
      "telemetry",
      "members",
      "tags",
      "danger",
    ]) {
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

  test("an unconnected project offers Connect Linear under Integrations, and a callback refusal is explained once", async ({
    page,
  }) => {
    await signUp(page, "Linear Lina");
    await openSettings(page);
    await openSection(page, "integrations");
    await expect(page.getByTestId("linear-disconnected")).toBeVisible(LANDED);
    await expect(page.getByTestId("linear-connect")).toBeEnabled();

    // What Linear's redirect back looks like when the workspace is taken.
    await page.goto("/settings/integrations?type=linear&error=workspace_taken");
    await expect(page.getByTestId("linear-error")).toContainText(
      "already connected to another Hypotenuse project",
      LANDED,
    );
    // Stripped, so a reload does not repeat it.
    await expect(page).toHaveURL(/\/settings\/integrations$/);
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

  test("a telemetry exporter is added with write-only headers, tested, edited, and deleted", async ({
    page,
  }) => {
    await signUp(page, "Otel Otto");
    await openSettings(page);
    await openSection(page, "telemetry");
    await expect(page.getByTestId("telemetry-empty")).toBeVisible(LANDED);
    await expect(page.getByTestId("content-levels")).toContainText(
      "third party",
    );
    await expect(page.getByTestId("telemetry-runners-empty")).toBeVisible();

    await page.getByTestId("telemetry-new").click();
    await page.getByTestId("telemetry-name").fill("local-collector");
    // The e2e backend allows private endpoints; nothing listens on port 9, so
    // the test below reports every signal refused.
    await page.getByTestId("telemetry-endpoint").fill("http://127.0.0.1:9");
    await page.getByTestId("telemetry-header-add").click();
    await page.getByTestId("telemetry-header-name-0").fill("x-api-key");
    await page.getByTestId("telemetry-header-value-0").fill("s3cret-value");
    await page.getByTestId("telemetry-submit").click();

    const list = page.getByTestId("telemetry-exporters");
    await expect(page.getByTestId("telemetry-notice")).toBeVisible(LANDED);
    await expect(list).toContainText("local-collector");
    await expect(list).toContainText("x-api-key");
    await expect(page.getByText("s3cret-value")).toHaveCount(0);

    await list.getByRole("button", { name: "Test" }).click();
    await expect(
      list.locator('[data-testid^="telemetry-test-result-"]'),
    ).toContainText("traces", LANDED);
    await expect(
      list.getByRole("img", { name: "Refused" }).first(),
    ).toBeVisible();

    // An edit names the headers it holds and never fills a value in.
    await list.getByRole("button", { name: "Edit" }).click();
    await expect(page.getByTestId("telemetry-header-names")).toContainText(
      "x-api-key",
    );
    await expect(page.getByTestId("telemetry-header-value-0")).toHaveCount(0);
    await page.getByTestId("telemetry-content").selectOption("full");
    await page.getByTestId("telemetry-header-mode-clear").check();
    await page.getByTestId("telemetry-submit").click();
    await expect(page.getByTestId("telemetry-notice")).toBeVisible(LANDED);
    await expect(list).toContainText("full");
    await expect(list).not.toContainText("x-api-key");

    await list.getByRole("button", { name: "Delete" }).click();
    await page.getByTestId("telemetry-delete-confirm").click();
    await expect(page.getByTestId("telemetry-empty")).toBeVisible(LANDED);
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
