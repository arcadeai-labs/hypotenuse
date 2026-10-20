import { expect, test } from "@playwright/test";
import {
  fromProjectMenu,
  LANDED,
  openSection,
  openSettings,
  PASSWORD,
  signIn,
  signUp,
  uniqueEmail,
} from "./session.ts";

/**
 * The tenancy walkthrough, in a real browser: sign up → land in your own
 * project as its admin → create a tag → invite a second address → sign up as
 * that address → accept → appear in Members with the tag.
 */

test.describe("tenancy", () => {
  test("signup lands the user in their own project as its admin", async ({
    page,
  }) => {
    await signUp(page, "Owner One");

    // The signup bootstrap named the project after them…
    await expect(page.getByTestId("project-switcher-toggle")).toContainText(
      "Owner One's Project",
    );
    // …made them its admin, so the admin-only rename control is present…
    await openSettings(page);
    await expect(page.getByTestId("project-name")).toBeVisible(LANDED);
    // …and gave them the reserved tag, which has no delete affordance.
    await openSection(page, "tags");
    await expect(page.getByTestId("tag-list")).toContainText("admin");
    await expect(
      page.getByRole("button", { name: "Delete the admin tag" }),
    ).toHaveCount(0);
    // The sidebar knows who they are.
    await expect(page.getByTestId("account-name")).toHaveText("Owner One");
  });

  test("the full invite lifecycle, admin to invitee", async ({ browser }) => {
    const adminEmail = uniqueEmail("admin");
    const guestEmail = uniqueEmail("guest");

    const adminContext = await browser.newContext();
    const admin = await adminContext.newPage();
    await signUp(admin, "Admin Ada", adminEmail);

    // Create a tag to grant with the invite.
    await openSettings(admin);
    await openSection(admin, "tags");
    await admin.getByTestId("new-tag-name").fill("operators");
    await admin.getByTestId("new-tag-submit").click();
    await expect(admin.getByTestId("tag-list")).toContainText("operators");

    // Invite the guest, granting that tag.
    await fromProjectMenu(admin, "invites-link");
    await admin.getByTestId("invite-email").fill(guestEmail);
    await admin.getByLabel("operators").check();
    await admin.getByTestId("invite-submit").click();
    await expect(admin.getByTestId("invites-notice")).toBeVisible(LANDED);
    await expect(admin.getByTestId("sent-invites")).toContainText(guestEmail);
    await expect(admin.getByTestId("sent-invites")).toContainText("pending");

    // A separate browser context: the guest is a different session, not a tab.
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    await signUp(guest, "Guest Gus", guestEmail);

    // The invite is waiting for them, keyed on their email, on their first visit.
    await fromProjectMenu(guest, "invites-link");
    const pending = guest.getByTestId("pending-invites");
    await expect(pending).toContainText("Admin Ada's Project", LANDED);
    await expect(pending).toContainText(adminEmail);

    await pending.getByRole("button", { name: "Accept" }).click();
    await expect(pending).toContainText("No pending invitations.");

    // Accepting joined them, so the switcher offers both projects.
    await guest.getByTestId("project-switcher-toggle").click();
    const options = guest
      .getByTestId("project-switcher")
      .locator('[data-testid^="project-option-"]');
    await expect(options).toHaveCount(2);
    await options.filter({ hasText: "Admin Ada's Project" }).click();
    await expect(guest).toHaveURL(/\/home$/, LANDED);
    await openSettings(guest);

    // They are a plain member: every section is still listed, and each says for
    // itself what a member may do there.
    await expect(guest.getByTestId("project-name-readonly")).toBeVisible(
      LANDED,
    );
    await openSection(guest, "members");
    await expect(guest.getByTestId("members-table")).toContainText(guestEmail);
    await openSection(guest, "tags");
    await expect(guest.getByTestId("tag-list")).toBeVisible();
    await expect(guest.getByTestId("new-tag-name")).toHaveCount(0);
    await openSection(guest, "danger");
    await expect(guest.getByTestId("danger-card")).toHaveCount(0);
    await expect(guest.getByTestId("danger-admin-only")).toBeVisible();

    // And from the admin's side, they show up with the tag the invite granted.
    await openSettings(admin);
    await openSection(admin, "members");
    const guestRow = admin
      .getByTestId("members-table")
      .locator("tr", { hasText: guestEmail });
    await expect(guestRow).toContainText("operators");

    await guestContext.close();
    await adminContext.close();
  });

  test("signing out closes the app and signing in reopens it", async ({
    page,
  }) => {
    const email = await signUp(page, "Returning Rita");

    await page.getByTestId("account-menu").click();
    await page.getByTestId("sign-out").click();
    await expect(page).toHaveURL(/\/sign-in$/, LANDED);

    // A protected route now bounces to the sign-in form.
    await page.goto("/settings");
    await expect(page.getByTestId("sign-in-form")).toBeVisible(LANDED);

    await signIn(page, email);
    await expect(page.getByTestId("account-name")).toHaveText("Returning Rita");
  });

  test("a wrong password is refused with the backend's own wording", async ({
    page,
  }) => {
    const email = await signUp(page, "Careful Carl");
    await page.getByTestId("account-menu").click();
    await page.getByTestId("sign-out").click();
    await expect(page).toHaveURL(/\/sign-in$/, LANDED);

    await page.goto("/sign-in");
    await page.getByTestId("sign-in-email").fill(email);
    await page.getByTestId("sign-in-password").fill("not-the-password");
    await page.getByTestId("sign-in-submit").click();

    // The same message the backend gives for an unknown email.
    await expect(page.getByTestId("form-error")).toContainText(
      "Invalid email or password",
      LANDED,
    );
  });

  test("a duplicate email is refused at sign-up", async ({ page, browser }) => {
    const email = await signUp(page, "First Fiona");
    const other = await browser.newContext();
    const second = await other.newPage();
    await second.goto("/sign-up");
    await second.getByTestId("sign-up-name").fill("Second Sam");
    await second.getByTestId("sign-up-email").fill(email);
    await second.getByTestId("sign-up-password").fill(PASSWORD);
    await second.getByTestId("sign-up-submit").click();
    await expect(second.getByTestId("form-error")).toBeVisible(LANDED);
    await expect(second).toHaveURL(/\/sign-up$/);
    await other.close();
  });

  test("the account form never renders empty, and saves a new name", async ({
    page,
  }) => {
    await signUp(page, "Account Ann");

    await page.getByTestId("account-menu").click();
    await page.getByTestId("account-link").click();

    // Two empty boxes labelled Name and Email are not a loading state — they are
    // an account with no name, which a fast typist could have submitted.
    await expect(page.getByTestId("account-name-input")).not.toHaveValue("");
    await expect(page.getByTestId("account-name-input")).toHaveValue(
      "Account Ann",
      LANDED,
    );

    await page.getByTestId("account-name-input").fill("Account Annie");
    await page.getByTestId("account-submit").click();
    await expect(page.getByTestId("form-saved")).toBeVisible(LANDED);
    await expect(page.getByTestId("account-name")).toHaveText("Account Annie");
  });
});
