import { expect, test } from "@playwright/test";
import {
  fromProjectMenu,
  LANDED,
  openSection,
  openSettings,
  signUp,
  uniqueEmail,
} from "./session.ts";

/** The audit log in a real browser: an admin reads it, a member is refused. */

test.describe("audit log", () => {
  test("an admin sees their own changes, with a before/after diff", async ({
    page,
  }) => {
    await signUp(page, "Auditor Anna");
    await openSettings(page);
    await openSection(page, "tags");
    await page.getByTestId("new-tag-name").fill("shipwrights");
    await page.getByTestId("new-tag-submit").click();
    await expect(page.getByTestId("tag-list")).toContainText("shipwrights");

    // Hold `project:view` so the unresolved-standing window is long enough to
    // observe. A refusal printed before standing is known is a claim, and an
    // admin must never see it — not even for the moment before the answer.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => url.pathname === "/api/project",
      async (route) => {
        await held;
        await route.continue();
      },
    );

    await fromProjectMenu(page, "audit-link");
    await expect(page.getByTestId("audit-loading")).toBeVisible();
    await expect(page.getByTestId("audit-forbidden")).toBeHidden();
    release();

    const table = page.getByTestId("audit-table");
    await expect(table).toBeVisible(LANDED);
    // The signup bootstrap's synthetic `project:create`: a project's log opens
    // with its own creation.
    await expect(table).toContainText("project:create");
    await expect(table).toContainText("tag:create");
    await expect(table).toContainText("shipwrights");
    await expect(table).toContainText("Auditor Anna");

    const row = table.locator("tr", { hasText: "tag:create" }).first();
    await row.getByRole("button", { name: "details" }).click();
    const diff = page.getByTestId("audit-diff");
    await expect(diff).toContainText("added");
    await expect(diff).toContainText("shipwrights");
  });

  test("the action filter narrows the table", async ({ page }) => {
    await signUp(page, "Filter Fred");
    await openSettings(page);
    await openSection(page, "tags");
    await page.getByTestId("new-tag-name").fill("carpenters");
    await page.getByTestId("new-tag-submit").click();
    await expect(page.getByTestId("tag-list")).toContainText("carpenters");

    await fromProjectMenu(page, "audit-link");
    const table = page.getByTestId("audit-table");
    await expect(table).toContainText("project:create", LANDED);

    await page.getByTestId("audit-action").fill("tag:create");
    await expect(table).toContainText("tag:create");
    await expect(table).not.toContainText("project:create");

    await page.getByTestId("audit-reset").click();
    await expect(table).toContainText("project:create");
  });

  test("the palette offers the audit log to an admin", async ({ page }) => {
    await signUp(page, "Palette Pam");
    await page.keyboard.press(
      `${process.platform === "darwin" ? "Meta" : "Control"}+k`,
    );
    await page.getByTestId("command-palette-input").fill("audit");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/audit$/, LANDED);
    await expect(page.getByTestId("audit-table")).toBeVisible(LANDED);
  });

  test("a plain member is told they cannot read it", async ({ browser }) => {
    const guestEmail = uniqueEmail("logguest");

    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await signUp(admin, "Log Admin");

    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    await signUp(guest, "Log Guest", guestEmail);

    // Add the guest to the admin's project as a plain member, no tags.
    await openSettings(admin);
    await openSection(admin, "members");
    await admin.getByTestId("new-member-email").fill(guestEmail);
    await admin.getByTestId("new-member-submit").click();
    await expect(admin.getByTestId("members-table")).toContainText(guestEmail);

    await guest.reload();
    await guest.getByTestId("project-switcher-toggle").click();
    await guest
      .getByTestId("project-switcher")
      .locator('[data-testid^="project-option-"]')
      .filter({ hasText: "Log Admin's Project" })
      .click();

    await fromProjectMenu(guest, "audit-link");
    await expect(guest.getByTestId("audit-forbidden")).toBeVisible(LANDED);
    await expect(guest.getByTestId("audit-table")).toHaveCount(0);

    await guestContext.close();
    await adminContext.close();
  });
});
