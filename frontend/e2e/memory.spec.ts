import { type APIRequestContext, expect, test } from "@playwright/test";
import {
  api,
  LANDED,
  openTenant,
  type SignedUp,
  signUpApi,
} from "./session.ts";

/**
 * The memory explorer against the real backend. Memory needs no model to be
 * read and written: a bot's channel exists once someone starts a
 * conversation there, so the bot's model points at a closed local port and
 * its turn fails fast and offline — the scripted model, which other specs
 * queue answers on, is never asked.
 */

/**
 * Give a project a model connection that answers nothing, its `default` and
 * `fast` names, a bot, and one API channel of that bot.
 * @param request - The admin's request context.
 * @param tenant - What the admin's sign-up made.
 * @returns The bot's and the channel's ids.
 */
async function botWithChannel(
  request: APIRequestContext,
  tenant: SignedUp,
): Promise<{ botId: number; channelId: number }> {
  const projectId = tenant.project.id;
  const { modelConnection } = await api<{ modelConnection: { id: number } }>(
    request,
    "PUT",
    `/project/${projectId}/model-connection`,
    {
      name: "Nowhere",
      provider: "anthropic",
      baseUrl: "http://127.0.0.1:9/v1",
      apiKey: "sk-ant-nowhere-0000",
    },
  );
  for (const [name, modelId] of [
    ["default", "claude-sonnet-4-5"],
    ["fast", "claude-haiku-4-5"],
  ]) {
    await api(request, "PUT", `/project/${projectId}/model-alias`, {
      name,
      connectionId: modelConnection.id,
      modelId,
    });
  }
  const { bot } = await api<{ bot: { id: number } }>(
    request,
    "PUT",
    `/project/${projectId}/bot`,
    { name: "Mnemo", persona: "You are Mnemo." },
  );
  const { conversation } = await api<{
    conversation: { channelId: number };
  }>(request, "PUT", `/project/${projectId}/bot/${bot.id}/conversation`, {
    text: "The drawbridge opens at dawn.",
    channelKey: "castle",
  });
  return { botId: bot.id, channelId: conversation.channelId };
}

test("an admin writes, finds, edits, and compares project memory, and promotes a channel's memory into it", async ({
  page,
}) => {
  const admin = await signUpApi(page.request, "Memory Admin");
  await openTenant(page, admin);
  const projectId = admin.project.id;
  const { botId, channelId } = await botWithChannel(page.request, admin);
  await api(page.request, "PUT", `/project/${projectId}/memory/document`, {
    scope: "channel",
    channelId,
    path: "facts/drawbridge.md",
    content: "# Drawbridge\n\nThe drawbridge opens at dawn.",
    changeNote: "Told in the castle channel",
  });

  // Project memory is a live destination, titled as such, with the channels
  // beside it; with no embedding model, it says search matches words only.
  await page.goto("/status");
  await page.getByTestId("nav-memory").click();
  await expect(page).toHaveURL(/\/memory$/);
  await expect(page.getByTestId("memory-empty")).toBeVisible(LANDED);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(
    "Project memory",
  );
  await expect(page.getByTestId("memory-scope-project")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByTestId("memory-index-banner")).toContainText(
    "Search matches words only",
  );

  // Write a document from the explorer; it opens.
  await page.getByTestId("memory-new-document").click();
  await page.getByTestId("memory-editor-path").fill("facts/moat.md");
  await page
    .getByTestId("memory-editor-description")
    .fill("When the moat is inspected");
  await page
    .getByTestId("memory-editor-content")
    .fill("# Moat\n\nThe moat is inspected on Fridays.");
  await page.getByTestId("memory-editor-save").click();
  await expect(page).toHaveURL(/\/memory\/document\?path=facts%2Fmoat\.md$/);
  await expect(page.getByTestId("memory-content")).toContainText(
    "inspected on Fridays",
  );
  await expect(page.getByTestId("memory-source")).toHaveText(
    "Written by a person",
  );

  // The explorer lists it with its decay, and search finds it by its words.
  await page.goto("/memory");
  const row = page.getByTestId("memory-row-facts/moat.md");
  await expect(row).toContainText("When the moat is inspected", LANDED);
  await expect(row.getByRole("meter")).toHaveAttribute(
    "title",
    /fresh — unused, it loses half its weight every 180 days/,
  );
  await page.getByTestId("memory-search-input").fill("moat inspected");
  await page.getByTestId("memory-search-submit").click();
  await expect(page).toHaveURL(/q=moat\+inspected/);
  await expect(page.getByTestId("memory-search-mode")).toHaveText("Words only");
  const hit = page.getByTestId("memory-hit-facts/moat.md");
  await expect(hit).toContainText("relevance");
  await expect(hit).toContainText("decay");

  // Edit it: a new version, and the diff with the one before.
  await hit.getByRole("link", { name: "facts/moat.md" }).click();
  await page.getByTestId("memory-edit").click();
  await page
    .getByTestId("memory-document-editor-content")
    .fill("# Moat\n\nThe moat is inspected on Thursdays.");
  await page.getByTestId("memory-document-editor-note").fill("Moved a day");
  await page.getByTestId("memory-document-editor-save").click();
  await expect(page.getByTestId("memory-document-notice")).toContainText(
    "Saved a new version",
  );
  await expect(page.getByTestId("memory-version-2")).toContainText(
    "Moved a day",
  );
  const diff = page.getByTestId("memory-diff");
  await expect(diff.locator(".is-remove")).toContainText("Fridays");
  await expect(diff.locator(".is-add")).toContainText("Thursdays");

  // Pin it: it never fades.
  await page.getByTestId("memory-pin").click();
  await expect(page.getByTestId("memory-pin")).toHaveText("Unpin");
  await expect(page.getByTestId("memory-properties")).toContainText(
    "Pinned: never fades",
  );

  // The bot's page opens the same explorer; the channel is beside project
  // memory, and its page is titled as a channel's.
  await page.goto(`/bots/${botId}`);
  await page.getByTestId("bot-memory-explorer").click();
  await expect(page).toHaveURL(/\/memory$/, LANDED);
  await page.getByTestId(`memory-channel-${channelId}`).click();
  await expect(page).toHaveURL(
    new RegExp(`/memory/channels/${channelId}$`),
    LANDED,
  );
  await expect(page.getByTestId(`memory-channel-${channelId}`)).toContainText(
    "castle",
  );
  await expect(page.getByRole("heading", { level: 1 })).toContainText(
    "Channel memory",
  );
  await expect(page.getByTestId("memory-channel-title")).toHaveText("castle");
  await page.getByTestId("memory-row-facts/drawbridge.md").click();
  await expect(page.getByTestId("memory-document-title")).toHaveText(
    "facts/drawbridge.md",
    LANDED,
  );

  // Promote it: the copy lands in project memory and says where it came from.
  await page.getByTestId("memory-promote").click();
  await page.getByTestId("memory-promote-confirm").click();
  await expect(page).toHaveURL(
    /\/memory\/document\?path=facts%2Fdrawbridge\.md$/,
    LANDED,
  );
  await expect(page.getByTestId("memory-source")).toHaveText(
    "Promoted from a channel",
  );
  await expect(page.getByTestId("memory-provenance-promoted")).toHaveAttribute(
    "href",
    `/memory/channels/${channelId}`,
  );

  // An old address of a bot's memory of a channel lands on that channel.
  await page.goto(`/bots/${botId}/memory/${channelId}`);
  await expect(page).toHaveURL(
    new RegExp(`/memory/channels/${channelId}$`),
    LANDED,
  );
  await page.goto("/memory/document?path=facts%2Fdrawbridge.md");

  // Forget it: it leaves the list, and comes back under Show forgotten.
  await page.getByTestId("memory-forget").click();
  await page.getByTestId("memory-forget-confirm").click();
  await expect(page).toHaveURL(/\/memory$/, LANDED);
  await expect(page.getByTestId("memory-row-facts/moat.md")).toBeVisible();
  await expect(page.getByTestId("memory-row-facts/drawbridge.md")).toHaveCount(
    0,
  );
  await page.getByTestId("memory-show-forgotten").check();
  await expect(
    page.getByTestId("memory-row-facts/drawbridge.md"),
  ).toContainText("Forgotten");
});

test("a bot's memory half-lives are set on its page", async ({ page }) => {
  const admin = await signUpApi(page.request, "Half-life Admin");
  await openTenant(page, admin);
  const { bot } = await api<{ bot: { id: number } }>(
    page.request,
    "PUT",
    `/project/${admin.project.id}/bot`,
    { name: "Fading", persona: "You are Fading." },
  );
  await page.goto(`/bots/${bot.id}/retention`);
  await expect(page.getByTestId("bot-memory-channel")).toHaveValue(
    "30",
    LANDED,
  );
  await expect(page.getByTestId("bot-memory-project")).toHaveValue("180");
  await page.getByTestId("bot-memory-channel").fill("45");
  await page.getByTestId("save-bot-memory").click();
  await expect(page.getByTestId("bot-property-memory")).toContainText(
    "45d channel",
  );
  await page.reload();
  await expect(page.getByTestId("bot-memory-channel")).toHaveValue(
    "45",
    LANDED,
  );
  await expect(page.getByTestId("bot-memory-link")).toHaveAttribute(
    "href",
    "/memory",
  );
});
