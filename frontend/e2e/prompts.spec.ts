import { type APIRequestContext, expect, test } from "@playwright/test";
import {
  addMember,
  api,
  LANDED,
  openSettings,
  openTenant,
  type SignedUp,
  signUpApi,
} from "./session.ts";

/**
 * A bot's prompt, goals, and skills in the dashboard, against the real
 * backend: every save is a real `prompt-section:*`, `goal:*`, `skill:*`, or
 * `bot-skill:*` action, and the preview is the server's own assembly.
 */

/**
 * Make a bot over the API.
 * @param request - The admin's request context.
 * @param tenant - What the admin's sign-up made.
 * @param name - The bot's name.
 * @returns The bot's id.
 */
async function makeBot(
  request: APIRequestContext,
  tenant: SignedUp,
  name: string,
): Promise<number> {
  const { bot } = await api<{ bot: { id: number } }>(
    request,
    "PUT",
    `/project/${tenant.project.id}/bot`,
    { name, persona: `You are ${name}. You answer briefly.` },
  );
  return bot.id;
}

test("a person edits a bot's prompt, reads the diff, reverts it, adds a contextual section, and is refused over budget", async ({
  page,
}) => {
  const admin = await signUpApi(page.request, "Prompt Admin");
  const botId = await makeBot(page.request, admin, "Quill");

  // The bot page sizes the prompt, and links to it.
  await page.goto(`/bots/${botId}`);
  await expect(page.getByTestId("bot-prompt-budget")).toHaveValue(
    "8000",
    LANDED,
  );
  await page.getByTestId("bot-prompt-budget").fill("9000");
  await page.getByTestId("save-bot-prompt").click();
  await expect(page.getByTestId("bot-prompt-notice")).toContainText("Saved.");
  await expect(page.getByTestId("bot-property-prompt-budget")).toHaveText(
    "9,000 tokens",
  );
  await page.getByTestId("bot-prompt-page").click();
  await expect(page).toHaveURL(new RegExp(`/bots/${botId}/prompt$`));

  // Its three seed sections, Identity first; the preview is what it is sent.
  const identity = page.getByTestId("prompt-section-bot-identity");
  const howIWork = page.getByTestId("prompt-section-bot-how-i-work");
  await expect(identity).toBeVisible(LANDED);
  await expect(
    page.getByTestId("prompt-sections").locator("> section").first(),
  ).toHaveAttribute("data-testid", "prompt-section-bot-identity");
  await expect(identity).toContainText("You are Quill.");
  // Identity is never the bot's to edit, and is never deleted.
  await expect(
    page.getByTestId("prompt-section-bot-identity-agent-editable"),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("prompt-section-bot-identity-delete"),
  ).toHaveCount(0);
  await expect(page.getByTestId("prompt-preview-system")).toContainText(
    "You are Quill.",
    LANDED,
  );
  await expect(page.getByTestId("prompt-preview-tokens")).toContainText(
    "of 9,000 tokens",
  );

  // Edit How I work: a new version, and the preview follows.
  await page.getByTestId("prompt-section-bot-how-i-work-edit").click();
  await page
    .getByTestId("prompt-section-bot-how-i-work-body-input")
    .fill("Answer in one short paragraph.");
  await page
    .getByTestId("prompt-section-bot-how-i-work-note-input")
    .fill("Shorter answers");
  await page.getByTestId("prompt-section-bot-how-i-work-save").click();
  await expect(
    page.getByTestId("prompt-section-bot-how-i-work-notice"),
  ).toContainText("Saved as version 2.");
  await expect(
    page.getByTestId("prompt-section-bot-how-i-work-body"),
  ).toContainText("Answer in one short paragraph.");
  await expect(page.getByTestId("prompt-preview-system")).toContainText(
    "Answer in one short paragraph.",
  );

  // Its history: v2 by a person, with the diff from v1 and its note.
  await page.getByTestId("prompt-section-bot-how-i-work-history").click();
  const history = page.getByTestId("prompt-history-how-i-work");
  await expect(
    history.getByTestId("prompt-history-how-i-work-v2"),
  ).toContainText("Written by a person");
  await expect(
    history.getByTestId("prompt-history-how-i-work-v2"),
  ).toContainText("Shorter answers");
  const diff = history.getByTestId("prompt-history-how-i-work-diff");
  await expect(diff).toContainText("Changes from v1 to v2");
  await expect(diff.locator(".memory-diff-line.is-add")).toContainText([
    "Answer in one short paragraph.",
  ]);

  // Revert to v1: the old (empty) text comes back as version 3.
  await history.getByTestId("prompt-history-how-i-work-revert-v1").click();
  await expect(
    page.getByTestId("prompt-section-bot-how-i-work-notice"),
  ).toContainText("Reverted");
  await expect(howIWork).toContainText("v3");
  await expect(
    history.getByTestId("prompt-history-how-i-work-v3"),
  ).toContainText("Reverted by a person");
  await expect(
    page.getByTestId("prompt-section-bot-how-i-work-body"),
  ).toContainText("Empty");
  await expect(page.getByTestId("prompt-preview-system")).not.toContainText(
    "Answer in one short paragraph.",
  );

  // Stop the bot editing what it has learned; the switch saves at once.
  const learned = page.getByTestId(
    "prompt-section-bot-things-i-have-learned-agent-editable",
  );
  await expect(learned).toBeChecked();
  await learned.uncheck();
  await expect(
    page.getByTestId("prompt-section-bot-things-i-have-learned-notice"),
  ).toContainText("Only people may edit this section now.");
  await page.reload();
  await expect(learned).not.toBeChecked(LANDED);

  // A contextual section comes in only when its keyword does.
  await page.getByTestId("prompt-new-title").fill("Release notes");
  await page
    .getByTestId("prompt-new-body")
    .fill("Write release notes newest first.");
  await page.getByTestId("prompt-new-loading").selectOption("contextual");
  await page.getByTestId("prompt-new-keywords").fill("release, changelog");
  await page.getByTestId("prompt-new-submit").click();
  await expect(page.getByTestId("prompt-new-notice")).toContainText(
    "Added Release notes.",
  );
  await expect(
    page.getByTestId("prompt-section-bot-release-notes-loading"),
  ).toHaveText("Contextual");
  await expect(
    page.getByTestId("prompt-preview-included-release-notes"),
  ).toHaveCount(0);
  await page
    .getByTestId("prompt-preview-message")
    .fill("Can you draft the release notes for 2.4?");
  await expect(
    page.getByTestId("prompt-preview-included-release-notes"),
  ).toBeVisible();
  await expect(page.getByTestId("prompt-preview-system")).toContainText(
    "Write release notes newest first.",
  );

  // Sections that always load may not outgrow the budget: the save says so.
  const page20k = "Handbook line.\n".repeat(1_300);
  await page.getByTestId("prompt-new-title").fill("Handbook");
  await page.getByTestId("prompt-new-body").fill(page20k);
  await page.getByTestId("prompt-new-submit").click();
  await expect(page.getByTestId("prompt-new-notice")).toContainText(
    "Added Handbook.",
  );
  await page.getByTestId("prompt-new-title").fill("Second handbook");
  await page.getByTestId("prompt-new-body").fill(page20k);
  await page.getByTestId("prompt-new-submit").click();
  await expect(page.getByTestId("prompt-new-error")).toContainText(
    "over its budget of 9000",
  );
  await expect(
    page.getByTestId("prompt-section-bot-second-handbook"),
  ).toHaveCount(0);
});

test("a member writes a skill, a bot is given it pinned to a version, and gets a goal", async ({
  page,
}) => {
  const admin = await signUpApi(page.request, "Skill Admin");
  const botId = await makeBot(page.request, admin, "Scribe");

  // Write a skill with a required argument.
  await openSettings(page, "skills");
  await expect(page.getByTestId("no-skills")).toBeVisible(LANDED);
  await page.getByTestId("skill-new-name").fill("release-notes");
  await page
    .getByTestId("skill-new-description")
    .fill("Drafts release notes for a version");
  await page.getByTestId("skill-new-arg-add").click();
  await page.getByTestId("skill-new-arg-0-name").fill("version");
  await page.getByTestId("skill-new-arg-0-required").check();
  await expect(page.getByTestId("skill-new-usage")).toHaveText(
    "/release-notes <version>",
  );
  await page
    .getByTestId("skill-new-body")
    .fill("Draft release notes for $version.");
  await page.getByTestId("skill-new-submit").click();
  await expect(page.getByTestId("skills-new-notice")).toContainText(
    "Added /release-notes.",
  );
  const row = page.getByTestId("skill-row-release-notes");
  await expect(row).toContainText("/release-notes <version>");
  await expect(row).toContainText("v1");

  // Edit it: version 2, with a diff from version 1.
  await page.getByTestId("skill-edit-release-notes-open").click();
  await page
    .getByTestId("skill-edit-release-notes-body")
    .fill("Draft release notes for $version, newest change first.");
  await page.getByTestId("skill-edit-release-notes-note").fill("Order");
  await page.getByTestId("skill-edit-release-notes-submit").click();
  await expect(row).toContainText("v2", LANDED);
  await expect(page.getByTestId("skill-diff-release-notes")).toContainText(
    "newest change first",
  );

  // A name the server would refuse is refused before it is sent.
  await page.getByTestId("skill-new-name").fill("Release Notes");
  await page.getByTestId("skill-new-description").fill("x");
  await page.getByTestId("skill-new-body").fill("x");
  await page.getByTestId("skill-new-submit").click();
  await expect(page.getByTestId("skill-new-problem")).toContainText("hyphens");

  // Give it to the bot, then pin it to version 1.
  await page.goto(`/bots/${botId}`);
  await expect(page.getByTestId("bot-skills-empty")).toBeVisible(LANDED);
  await page.getByTestId("bot-skills-add-select").selectOption({
    label: "/release-notes — Drafts release notes for a version",
  });
  await page.getByTestId("bot-skills-add-submit").click();
  await expect(page.getByTestId("bot-skill-version-release-notes")).toHaveText(
    "Latest (v2)",
  );
  await page.getByTestId("bot-skill-pin-release-notes").selectOption("1");
  await expect(page.getByTestId("bot-skill-version-release-notes")).toHaveText(
    "Pinned to v1 of 2",
  );
  await page.reload();
  await expect(page.getByTestId("bot-skill-version-release-notes")).toHaveText(
    "Pinned to v1 of 2",
    LANDED,
  );

  // Its prompt names the skill.
  await page.goto(`/bots/${botId}/prompt`);
  await expect(page.getByTestId("prompt-preview-system")).toContainText(
    "release-notes",
    LANDED,
  );

  // A goal: added, then achieved with notes.
  await page.goto(`/bots/${botId}`);
  await expect(page.getByTestId("bot-goals-empty")).toBeVisible(LANDED);
  await page
    .getByTestId("goal-new-title")
    .fill("Ship release notes the day of every release");
  await page.getByTestId("goal-new-priority").selectOption("high");
  await page.getByTestId("goal-new-review").selectOption("604800");
  await page.getByTestId("goal-new-submit").click();
  await expect(page.getByTestId("bot-goals-notice")).toContainText("Added");
  const goal = page.locator("[data-testid^=goal-][data-status]").first();
  await expect(goal).toContainText(
    "Ship release notes the day of every release",
  );
  await expect(goal).toContainText("High priority");
  await expect(goal).toContainText("Reviewed every 7 days");
  await expect(goal).toHaveAttribute("data-status", "active");
  const goalId = (await goal.getAttribute("data-testid"))?.replace("goal-", "");
  await page.getByTestId(`goal-${goalId}-edit`).click();
  await page
    .getByTestId(`goal-${goalId}-status-input`)
    .selectOption("achieved");
  await page
    .getByTestId(`goal-${goalId}-notes-input`)
    .fill("Done for 2.4 and 2.5.");
  await page.getByTestId(`goal-${goalId}-save`).click();
  await expect(page.getByTestId(`goal-${goalId}-status`)).toHaveText(
    "Achieved",
  );
  await expect(page.getByTestId(`goal-${goalId}-notes`)).toContainText(
    "Done for 2.4 and 2.5.",
  );
  await expect(page.getByTestId("bot-goals-count")).toContainText(
    "0 active goals of 1",
  );

  // Detach the skill.
  await page.getByTestId("bot-skill-detach-release-notes").click();
  await expect(page.getByTestId("bot-skills-empty")).toBeVisible();
});

test("an admin adds a section every bot includes; a member reads it and cannot change it", async ({
  page,
  browser,
}) => {
  const admin = await signUpApi(page.request, "Section Admin");
  const botId = await makeBot(page.request, admin, "Echo");
  const memberContext = await browser.newContext();
  const member = await memberContext.newPage();
  await addMember(page.request, admin, member.request, "Section Member");
  await openTenant(member, admin);

  await openSettings(page, "prompt-sections");
  await expect(page.getByTestId("no-prompt-sections")).toBeVisible(LANDED);
  await page.getByTestId("prompt-new-title").fill("House style");
  await page
    .getByTestId("prompt-new-body")
    .fill("Write in plain words. Never promise dates.");
  await page.getByTestId("prompt-new-submit").click();
  await expect(
    page.getByTestId("prompt-section-project-house-style"),
  ).toBeVisible();
  // No bot may edit a project section, so there is no switch to offer.
  await expect(
    page.getByTestId("prompt-section-project-house-style-agent-editable"),
  ).toHaveCount(0);

  // It is in the bot's prompt, after its Identity, marked as every bot's.
  await page.goto(`/bots/${botId}/prompt`);
  const shared = page.getByTestId("prompt-section-project-house-style");
  await expect(shared).toBeVisible(LANDED);
  await expect(
    page.getByTestId("prompt-section-project-house-style-scope"),
  ).toHaveText("Every bot");
  await expect(
    page.getByTestId("prompt-sections").locator("> section").nth(1),
  ).toHaveAttribute("data-testid", "prompt-section-project-house-style");
  await expect(page.getByTestId("prompt-preview-system")).toContainText(
    "Never promise dates.",
  );

  // A member reads it, and may still change the bot's own sections.
  await member.goto(`/bots/${botId}/prompt`);
  await expect(
    member.getByTestId("prompt-section-project-house-style"),
  ).toBeVisible(LANDED);
  await expect(
    member.getByTestId("prompt-section-project-house-style-edit"),
  ).toHaveAttribute("title", /Only a project admin/);
  await expect(
    member.getByTestId("prompt-section-project-house-style-edit"),
  ).toBeDisabled();
  await expect(
    member.getByTestId("prompt-section-bot-how-i-work-edit"),
  ).toBeEnabled();
  await member.goto("/settings/prompt-sections");
  await expect(member.getByTestId("prompt-new-submit")).toBeDisabled(LANDED);
  await memberContext.close();
});
