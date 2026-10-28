import { expect, test } from "@playwright/test";
import { api, LANDED, signUpApi, uniqueEmail } from "./session.ts";

const mod = process.platform === "darwin" ? "Meta" : "Control";

test("the organization switcher lists every organization and switches between them", async ({
  page,
}) => {
  const me = await signUpApi(page.request, "Switch Owner");
  // Named to sort after the sign-up organization, which is active first.
  const second = await api<{ organization: { id: number } }>(
    page.request,
    "PUT",
    "/organization",
    { name: "Zulu Org" },
  );
  await page.goto("/organization/projects");
  await expect(page.getByTestId("organization-switcher-toggle")).toContainText(
    "Switch Owner",
    LANDED,
  );

  await page.getByTestId("organization-switcher-toggle").click();
  await expect(
    page.getByTestId(`organization-option-${me.organization.id}`),
  ).toHaveAttribute("aria-current", "true");
  await page
    .getByTestId(`organization-option-${second.organization.id}`)
    .click();

  // The new organization has no projects yet, so the page and switcher say so.
  await expect(page.getByTestId("organization-switcher-toggle")).toContainText(
    "Zulu Org",
  );
  await expect(page.getByTestId("page-header")).toContainText("Zulu Org");
  await expect(page.getByTestId("project-switcher-toggle")).toContainText(
    "No project",
  );
  await expect(page.getByTestId("no-projects")).toBeVisible();

  // The choice survives a reload.
  await page.reload();
  await expect(page.getByTestId("organization-switcher-toggle")).toContainText(
    "Zulu Org",
    LANDED,
  );

  await page.getByTestId("organization-switcher-toggle").click();
  await page.getByTestId(`organization-option-${me.organization.id}`).click();
  await expect(page.getByTestId("project-switcher-toggle")).toContainText(
    "Default",
  );
});

test("an owner creates a project from the switcher, and it becomes active", async ({
  page,
}) => {
  await signUpApi(page.request, "Project Maker");
  await page.goto("/organization/projects");
  await page.getByTestId("organization-switcher-toggle").click();
  await page.getByTestId("new-project-link").click();
  await expect(page).toHaveURL(/\/projects\/new$/);

  await page.getByTestId("new-project-name").fill("Support Desk");
  await page.getByTestId("new-project-submit").click();
  await expect(page).toHaveURL(/\/settings\/general$/, LANDED);
  await expect(page.getByTestId("project-switcher-toggle")).toContainText(
    "Support Desk",
  );
  await expect(page.getByTestId("project-name")).toHaveValue("Support Desk");

  await page.getByTestId("project-switcher-toggle").click();
  await expect(
    page
      .getByTestId("project-switcher")
      .locator("[data-testid^='project-option-']"),
  ).toHaveText(["Default", "Support Desk"]);
});

test("a plain member sees New project disabled, with the reason, everywhere it is offered", async ({
  page,
  request,
}) => {
  // The owner works through their own request context; the page is the member.
  const owner = await signUpApi(request, "Org Owner");
  const memberEmail = uniqueEmail("member");
  await api(request, "PUT", `/organization/${owner.organization.id}/invite`, {
    inviteeEmail: memberEmail,
  });
  await signUpApi(page.request, "Plain Member", memberEmail);

  await page.goto("/invites");
  const pending = page.getByTestId("pending-invites");
  await expect(pending).toContainText("Org Owner", LANDED);
  await expect(pending).toContainText("Organization invite");
  await pending.getByRole("button", { name: "Accept" }).click();
  await expect(page.getByTestId("invites-notice")).toContainText(
    "You joined Org Owner",
  );

  // Accepting made the owner's organization active.
  await expect(page.getByTestId("organization-switcher-toggle")).toContainText(
    "Org Owner",
  );
  // An organization membership alone shows no projects.
  await expect(page.getByTestId("project-switcher-toggle")).toContainText(
    "No project",
  );

  const reason = "Only organization owners can do this.";
  await page.getByTestId("organization-switcher-toggle").click();
  const item = page.getByTestId("new-project-link");
  await expect(item).toHaveAttribute("aria-disabled", "true");
  await expect(item).toHaveAttribute("title", reason);
  await page.keyboard.press("Escape");

  await page.goto("/organization/projects");
  const button = page.getByTestId("organization-new-project");
  await expect(button).toBeDisabled(LANDED);
  await expect(button).toHaveAttribute("title", reason);
  await expect(page.getByTestId("organization-role")).toHaveText("Member");

  await page.keyboard.press(`${mod}+k`);
  await page.getByTestId("command-palette-input").fill("New project");
  const command = page.getByTestId("command-new-project");
  await expect(command).toHaveAttribute("data-disabled", "true");
  await expect(command).toContainText(reason);
});

test("an owner sees every project of the organization, with admin standing in each", async ({
  page,
  request,
}) => {
  // A project the owner does not belong to: created by a second owner.
  const owner = await signUpApi(page.request, "Seeing Owner");
  const coOwnerEmail = uniqueEmail("coowner");
  await api(
    page.request,
    "PUT",
    `/organization/${owner.organization.id}/invite`,
    {
      inviteeEmail: coOwnerEmail,
    },
  );
  const coOwner = await signUpApi(request, "Co Owner", coOwnerEmail);
  const invites = await api<{ invites: Array<{ id: number }> }>(
    request,
    "GET",
    "/invites/pending",
  );
  await api(request, "POST", `/invite/${invites.invites[0]?.id}/accept`);
  await api(
    page.request,
    "POST",
    `/organization/${owner.organization.id}/member/${coOwner.user.id}`,
    { role: "owner" },
  );
  const made = await api<{ project: { id: number } }>(
    request,
    "PUT",
    "/project",
    {
      organizationId: owner.organization.id,
      name: "Not Mine",
    },
  );

  await page.goto("/organization/projects");
  await expect(
    page.getByTestId(`organization-project-${made.project.id}`),
  ).toContainText("Not Mine", LANDED);
  await page.getByTestId(`open-project-${made.project.id}`).click();
  await expect(page).toHaveURL(/\/settings\/general$/);
  await expect(page.getByTestId("owner-standing")).toBeVisible(LANDED);
  await expect(page.getByTestId("project-name")).toBeEnabled();
});

test("anyone signed in starts a new organization from the switcher, and owns it", async ({
  page,
}) => {
  await signUpApi(page.request, "Founder");
  await page.goto("/organization/projects");
  await page.getByTestId("organization-switcher-toggle").click(LANDED);
  await page.getByTestId("new-organization-link").click();
  await expect(page).toHaveURL(/\/organizations\/new$/);

  await page.getByTestId("new-organization-name").fill("Second Shop");
  await page.getByTestId("new-organization-submit").click();

  // It is active, empty, and its owner may create its first project.
  await expect(page).toHaveURL(/\/organization\/projects$/, LANDED);
  await expect(page.getByTestId("organization-switcher-toggle")).toContainText(
    "Second Shop",
  );
  await expect(page.getByTestId("no-projects")).toContainText(
    "Create one with New project",
  );
  await expect(page.getByTestId("organization-new-project")).toBeEnabled();
});

test("the Projects page names your role in each project", async ({
  page,
  request,
}) => {
  const owner = await signUpApi(request, "Role Owner");
  const email = uniqueEmail("teammate");
  const sent = await api<{ invite: { id: number } }>(
    request,
    "PUT",
    `/organization/${owner.organization.id}/invite`,
    { projectId: owner.project.id, inviteeEmail: email },
  );
  const teammate = await signUpApi(page.request, "Role Teammate", email);
  await api(page.request, "POST", `/invite/${sent.invite.id}/accept`);

  await page.goto("/organization/projects");
  await page.getByTestId("organization-switcher-toggle").click(LANDED);
  await page
    .getByTestId(`organization-option-${owner.organization.id}`)
    .click();
  const role = page.getByTestId(
    `organization-project-role-${owner.project.id}`,
  );
  await expect(role).toHaveText("Member", LANDED);

  // Made an owner, the teammate administers the project without its admin
  // tag, and the badge says where that comes from.
  await api(
    request,
    "POST",
    `/organization/${owner.organization.id}/member/${teammate.user.id}`,
    { role: "owner" },
  );
  await page.reload();
  await expect(role).toHaveText("Admin (owner)", LANDED);
  await expect(role).toHaveAttribute("title", /own this organization/);
});
