import { expect, test } from "@playwright/test";
import { addMember, api, LANDED, openTenant, signUpApi } from "./session.ts";

/** A 1×1 PNG: the smallest square image the server accepts. */
const SQUARE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

test("a member makes a bot, gives it an avatar and a persona; restricting who may read it hides it from another member", async ({
  page,
  browser,
}) => {
  const admin = await signUpApi(page.request, "Bot Admin");
  await api(page.request, "PUT", `/project/${admin.project.id}/tag`, {
    name: "castle-staff",
  });
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await addMember(page.request, admin, other.request, "Toad");
  await openTenant(other, admin);

  // The list says no bot can run until both model names exist, and an admin
  // is linked to where they are set.
  await page.goto("/bots");
  await expect(page.getByTestId("missing-aliases")).toContainText(
    '"default" and "fast"',
    LANDED,
  );
  await expect(page.getByTestId("missing-aliases-link")).toHaveAttribute(
    "href",
    "/settings/models",
  );
  await expect(page.getByTestId("no-bots")).toBeVisible();

  // Create.
  await page.getByTestId("new-bot").click();
  await expect(page).toHaveURL(/\/bots\/new$/);
  await page.getByTestId("new-bot-name").fill("Kit");
  await page.getByTestId("new-bot-description").fill("Answers castle mail");
  await page.getByTestId("new-bot-persona").fill("You are Kit.");
  await page.getByTestId("new-bot-submit").click();
  await expect(page).toHaveURL(/\/bots\/\d+$/, LANDED);
  const botPath = new URL(page.url()).pathname;
  await expect(page.getByTestId("bot-title")).toHaveText("Kit");
  // A bot is always visibly a bot.
  await expect(
    page.locator(".ui-bot-badge[data-bot='Kit']").first(),
  ).toBeVisible();
  // What the page does not configure yet is there, disabled, and says so.
  for (const slug of ["channels", "tools", "skills", "prompts", "goals"]) {
    const section = page.getByTestId(`bot-section-${slug}`);
    await expect(section).toHaveAttribute("aria-disabled", "true");
    await expect(section).toContainText("Not available yet");
  }

  // Upload an avatar: it goes up at once and is drawn from the API.
  await page.getByTestId("bot-avatar-file").setInputFiles({
    name: "kit.png",
    mimeType: "image/png",
    buffer: SQUARE_PNG,
  });
  await expect(page.getByTestId("bot-identity-notice")).toContainText(
    "Avatar updated.",
  );
  const avatar = page.getByTestId("bot-avatar").locator("img");
  await expect(avatar).toHaveAttribute(
    "src",
    /\/api\/project\/\d+\/bot\/\d+\/avatar\?v=\d+$/,
  );
  await expect
    .poll(() => avatar.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
  // A file the server would refuse is refused before it is sent.
  await page.getByTestId("bot-avatar-file").setInputFiles({
    name: "kit.gif",
    mimeType: "image/gif",
    buffer: Buffer.from("GIF89a"),
  });
  await expect(page.getByTestId("bot-identity-error")).toContainText(
    "PNG or JPEG",
  );

  // Edit the persona, preview it, save it, and find it after a reload.
  await page
    .getByTestId("bot-persona")
    .fill("## Kit\n\nYou answer **castle mail**, briefly.");
  await page.getByTestId("bot-persona-show-preview").click();
  await expect(
    page
      .getByTestId("bot-persona-preview")
      .getByRole("heading", { name: "Kit" }),
  ).toBeVisible();
  await expect(
    page.getByTestId("bot-persona-preview").locator("strong"),
  ).toHaveText("castle mail");
  await page.getByTestId("save-bot-identity").click();
  await expect(page.getByTestId("bot-identity-notice")).toContainText("Saved.");
  await page.reload();
  await expect(page.getByTestId("bot-persona")).toHaveValue(
    "## Kit\n\nYou answer **castle mail**, briefly.",
    LANDED,
  );

  // The other member sees it in the list, with its badge, and may change it.
  await other.goto("/bots");
  const row = other.getByTestId("bot-row-kit");
  await expect(row).toContainText("Answers castle mail", LANDED);
  await expect(row.locator(".ui-bot-badge")).toContainText("Kit");
  await other.goto(botPath);
  await expect(other.getByTestId("bot-property-standing")).toHaveText(
    "Can read and change",
    LANDED,
  );

  // Limit who may change it: the other member can still read, not change.
  await page.getByTestId("bot-access-write-castle-staff").check();
  await page.getByTestId("save-bot-access").click();
  await expect(page.getByTestId("bot-access-notice")).toContainText("Saved.");
  await other.reload();
  await expect(other.getByTestId("bot-read-only")).toBeVisible(LANDED);
  await expect(other.getByTestId("bot-name")).toBeDisabled();
  await expect(other.getByTestId("save-bot-identity")).toBeDisabled();
  await expect(other.getByTestId("delete-bot")).toHaveAttribute(
    "title",
    /write access tags/,
  );

  // Limit who may read it: it is gone for them, list and page alike.
  await page.getByTestId("bot-access-read-castle-staff").check();
  await page.getByTestId("save-bot-access").click();
  await expect(page.getByTestId("bot-access-notice")).toContainText("Saved.");
  await expect(page.getByTestId("bot-property-read")).toHaveText(
    "castle-staff",
  );
  await other.goto("/bots");
  await expect(other.getByTestId("no-bots")).toBeVisible(LANDED);
  await expect(other.getByTestId("bot-row-kit")).toHaveCount(0);
  await other.goto(botPath);
  await expect(other.getByTestId("bot-missing")).toBeVisible(LANDED);

  // The admin still sees it, and deletes it behind a confirmation.
  await page.getByTestId("delete-bot").click();
  await expect(page.getByTestId("delete-bot-dialog")).toBeVisible();
  await page.getByTestId("delete-bot-confirm").click();
  await expect(page).toHaveURL(/\/bots$/);
  await expect(page.getByTestId("no-bots")).toBeVisible(LANDED);

  await otherContext.close();
});
