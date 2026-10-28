import { expect, test } from "@playwright/test";
import {
  api,
  LANDED,
  openSettings,
  signUpApi,
  uniqueEmail,
} from "./session.ts";

test("an admin invites by email with a tag; the invitee accepts and appears in Members holding it", async ({
  page,
  browser,
}) => {
  const admin = await signUpApi(page.request, "Admin Ada");
  const guestEmail = uniqueEmail("guest");

  // A tag to grant with the invite.
  await openSettings(page, "tags");
  await page.getByTestId("new-tag-name").fill("support");
  await page.getByTestId("new-tag-submit").click();
  await expect(page.getByTestId("tag-row-support")).toBeVisible();

  // Invite the guest into the project, granting it.
  await openSettings(page, "members");
  await page.getByTestId("invite-email").fill(guestEmail);
  await page.getByTestId("invite-tag-support").check();
  await page.getByTestId("invite-submit").click();
  await expect(page.getByTestId("project-invite-notice")).toContainText(
    `Invited ${guestEmail}`,
  );
  const sent = page.getByTestId("project-invites");
  await expect(sent).toContainText(guestEmail);
  await expect(sent).toContainText("pending");

  // The guest is a separate session.
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await signUpApi(guest.request, "Guest Gus", guestEmail);
  await guest.goto("/invites");
  const pending = guest.getByTestId("pending-invites");
  await expect(pending).toContainText(
    `Default in ${admin.organization.name}`,
    LANDED,
  );
  await expect(pending).toContainText(admin.email);
  await pending.getByRole("button", { name: "Accept" }).click();
  await expect(guest.getByTestId("invites-notice")).toContainText(
    `You joined Default in ${admin.organization.name}`,
  );
  await expect(guest.getByTestId("no-pending-invites")).toBeVisible();
  // Accepting a project invite brought them into the organization and the project.
  await expect(guest.getByTestId("organization-switcher-toggle")).toContainText(
    admin.organization.name,
  );
  await expect(guest.getByTestId("project-switcher-toggle")).toContainText(
    "Default",
  );

  // The admin sees them, holding the tag the invite granted.
  await page.reload();
  const row = page
    .getByTestId("members-table")
    .locator("tr", { hasText: guestEmail });
  await expect(row).toContainText("support", LANDED);
  await expect(sent).toContainText("accepted");

  // As a plain member, the guest sees every control — disabled, with the reason.
  await openSettings(guest, "members");
  await expect(guest.getByTestId("members-table")).toContainText(admin.email);
  const remove = guest.locator("[data-testid^='remove-member-']").first();
  await expect(remove).toBeDisabled();
  await expect(remove).toHaveAttribute(
    "title",
    "Only project admins can do this.",
  );
  await expect(guest.getByTestId("invite-submit")).toBeDisabled();
  await expect(guest.getByTestId("project-invites-denied")).toBeVisible();
  await openSettings(guest, "tags");
  await expect(guest.getByTestId("new-tag-submit")).toBeDisabled();
  await openSettings(guest, "danger");
  await expect(guest.getByTestId("delete-project-confirm")).toHaveAttribute(
    "title",
    "Only project admins can do this.",
  );

  await guestContext.close();
});

test("an admin grants and revokes a tag; the reserved admin tag is locked", async ({
  page,
  request,
}) => {
  const admin = await signUpApi(page.request, "Tag Admin");
  const memberEmail = uniqueEmail("tagged");
  // Bring a second person into the project through the API.
  await api(
    page.request,
    "PUT",
    `/organization/${admin.organization.id}/invite`,
    {
      projectId: admin.project.id,
      inviteeEmail: memberEmail,
    },
  );
  const member = await signUpApi(request, "Tagged Tom", memberEmail);
  const invites = await api<{ invites: Array<{ id: number }> }>(
    request,
    "GET",
    "/invites/pending",
  );
  await api(request, "POST", `/invite/${invites.invites[0]?.id}/accept`);

  await openSettings(page, "tags");
  await page.getByTestId("new-tag-name").fill("eng");
  await page.getByTestId("new-tag-submit").click();
  await expect(page.getByTestId("tag-row-eng")).toBeVisible();

  // The reserved tag: listed, locked, saying why.
  const adminRow = page.getByTestId("tag-row-admin");
  await expect(adminRow.getByTestId("reserved-tag-lock")).toBeVisible();
  await expect(page.getByTestId("rename-tag-admin")).toBeDisabled();
  await expect(page.getByTestId("delete-tag-admin")).toHaveAttribute(
    "title",
    /reserved/,
  );

  // Rename a tag of ours.
  await page.getByTestId("rename-tag-eng").click();
  await page.getByTestId("rename-tag-input-eng").fill("engineering");
  await page.getByTestId("rename-tag-save-eng").click();
  await expect(page.getByTestId("tag-row-engineering")).toBeVisible();

  // Grant it in Members, then revoke it.
  await openSettings(page, "members");
  await page.getByTestId(`grant-tag-${member.user.id}`).click();
  await page.getByTestId(`grant-tag-${member.user.id}-engineering`).click();
  const chip = page.getByTestId(`member-tag-${member.user.id}-engineering`);
  await expect(chip).toBeVisible();
  await expect(page.getByTestId("members-notice")).toContainText(
    "Granted engineering to Tagged Tom.",
  );
  await chip
    .getByRole("button", { name: "Revoke engineering from Tagged Tom" })
    .click();
  await expect(chip).toHaveCount(0);
});

test("an owner promotes and demotes in Organization → Members", async ({
  page,
  request,
}) => {
  const owner = await signUpApi(page.request, "Org Admin");
  const email = uniqueEmail("promoted");
  await api(
    page.request,
    "PUT",
    `/organization/${owner.organization.id}/invite`,
    {
      inviteeEmail: email,
    },
  );
  const member = await signUpApi(request, "Promoted Pat", email);
  const invites = await api<{ invites: Array<{ id: number }> }>(
    request,
    "GET",
    "/invites/pending",
  );
  await api(request, "POST", `/invite/${invites.invites[0]?.id}/accept`);

  await page.goto("/organization/members");
  const row = page.getByTestId(`organization-member-${member.user.id}`);
  await expect(row.getByTestId("organization-member-role")).toHaveText(
    "member",
    LANDED,
  );
  await page.getByTestId(`organization-role-${member.user.id}`).click();
  await expect(row.getByTestId("organization-member-role")).toHaveText("owner");
  await page.getByTestId(`organization-role-${member.user.id}`).click();
  await expect(row.getByTestId("organization-member-role")).toHaveText(
    "member",
  );
  // The organization's invites list the one that brought them in.
  await expect(page.getByTestId("organization-invites")).toContainText(email);
  await expect(page.getByTestId("organization-invites")).toContainText(
    "accepted",
  );
});
