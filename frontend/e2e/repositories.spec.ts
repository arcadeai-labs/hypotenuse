import { expect, test } from "@playwright/test";
import { api, LANDED, openTenant, signUpApi } from "./session.ts";

// The suite's backend has no GitHub App configured, so nothing here reaches
// GitHub: these specs cover what the page says before an installation exists,
// the way back from GitHub's install flow, and a bot's wake setting.

test("an admin sees an empty Repositories page, and Install says which App settings the operator must set", async ({
  page,
}) => {
  const admin = await signUpApi(page.request, "Repo Admin");
  await openTenant(page, admin);
  await page.goto("/repositories");

  await expect(page.getByTestId("no-installations")).toBeVisible(LANDED);
  await expect(page.getByTestId("no-grants")).toBeVisible();
  // With no installation there is nothing to grant through.
  await expect(page.getByTestId("grant-submit")).toBeDisabled();
  await expect(page.getByTestId("grant-installation")).toContainText(
    "No active installation",
  );

  await page.getByTestId("install-github-app").click();
  const missing = page.getByTestId("github-app-missing");
  await expect(missing).toContainText("GITHUB_APP_ID");
  await expect(missing).toContainText("GITHUB_APP_PRIVATE_KEY");

  // The sidebar has it, on its own destination.
  await expect(page.getByTestId("nav-repositories")).toHaveAttribute(
    "href",
    "/repositories",
  );
});

test("GitHub's way back names the project: it is selected, and the page says how the install went", async ({
  page,
}) => {
  const admin = await signUpApi(page.request, "Repo Return");
  // A second project in the same organization, so the return must switch to it.
  const { project } = await api<{ project: { id: number; name: string } }>(
    page.request,
    "PUT",
    "/project",
    { organizationId: admin.organization.id, name: "Platform" },
  );
  await openTenant(page, admin);
  await page.goto(
    `/projects/${project.id}/repositories?error=${encodeURIComponent("That install link expired. Start again from Repositories.")}`,
  );

  await expect(page).toHaveURL(/\/repositories\?error=/, LANDED);
  await expect(page.getByTestId("install-notice")).toContainText(
    "That install link expired",
  );
  await expect(page.getByTestId("project-switcher-toggle")).toContainText(
    "Platform",
  );
  await page.getByTestId("install-notice").getByRole("button").click();
  await expect(page).toHaveURL(/\/repositories$/);
});

test("a bot with no grant says so, and its pull-request wake events save", async ({
  page,
}) => {
  const admin = await signUpApi(page.request, "Wake Admin");
  await openTenant(page, admin);
  const { bot } = await api<{ bot: { id: number } }>(
    page.request,
    "PUT",
    `/project/${admin.project.id}/bot`,
    { name: "Robin", persona: "You are Robin." },
  );
  await page.goto(`/bots/${bot.id}`);

  const section = page.getByTestId("bot-bot-repositories");
  await expect(section.getByTestId("bot-no-repositories")).toBeVisible(LANDED);
  // The default: a review asking for changes, and a failed check.
  await expect(page.getByTestId("bot-wake-changes_requested")).toBeChecked();
  await expect(page.getByTestId("bot-wake-check_failed")).toBeChecked();
  await expect(page.getByTestId("bot-wake-merged")).not.toBeChecked();
  await expect(page.getByTestId("save-bot-repositories")).toBeDisabled();

  await page.getByTestId("bot-wake-merged").check();
  await page.getByTestId("bot-wake-check_failed").uncheck();
  await page.getByTestId("save-bot-repositories").click();
  await expect(page.getByTestId("bot-repositories-notice")).toContainText(
    "Saved.",
  );

  await page.reload();
  await expect(page.getByTestId("bot-wake-merged")).toBeChecked(LANDED);
  await expect(page.getByTestId("bot-wake-check_failed")).not.toBeChecked();
  const saved = await api<{ bot: { githubWakeEvents: string[] } }>(
    page.request,
    "GET",
    `/project/${admin.project.id}/bot/${bot.id}`,
  );
  expect(saved.bot.githubWakeEvents).toEqual(["changes_requested", "merged"]);
});
