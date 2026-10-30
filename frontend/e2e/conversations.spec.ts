import { type APIRequestContext, expect, test } from "@playwright/test";
import { MODEL_CONTROL_URL } from "./env.ts";
import {
  api,
  LANDED,
  openTenant,
  type SignedUp,
  signUpApi,
} from "./session.ts";

/**
 * Conversations in the dashboard, against the real loop: the suite's backend
 * runs a queue worker, so every tick is a real `agent:tick`, and the bot's
 * model is the scripted model server speaking Anthropic's API, driven over
 * its control port. Nothing about the conversation is faked in the browser.
 *
 * The scripted model answers in the order answers were queued, for any
 * conversation, so these run one at a time.
 */
test.describe.configure({ mode: "serial" });

/** One scripted answer, as the scripted model server takes it. */
interface ScriptedResponse {
  toolCalls?: { name: string; input: Record<string, unknown> }[];
  text?: string;
  hang?: boolean;
}

/**
 * Call the scripted model's control server.
 * @param method - The HTTP verb.
 * @param path - The route.
 * @param body - A JSON body.
 * @returns The parsed answer.
 * @throws {Error} When the control server is not running.
 */
async function model<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${MODEL_CONTROL_URL}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(
      `The scripted model is not answering at ${MODEL_CONTROL_URL}; scripts/e2e-backend.ts starts it.`,
    );
  }
  return (await res.json()) as T;
}

/**
 * Forget anything queued, then queue what the bot's model answers next.
 * @param responses - The answers, one per model step.
 */
async function script(responses: ScriptedResponse[]): Promise<void> {
  await model("POST", "/reset");
  await model("POST", "/play", { responses });
}

/**
 * Give a project a model connection pointing at the scripted model, its
 * `default` and `fast` names, and a bot.
 * @param request - The admin's request context.
 * @param tenant - What the admin's sign-up made.
 * @param name - The bot's name.
 * @returns The bot's id.
 */
async function botWithScriptedModel(
  request: APIRequestContext,
  tenant: SignedUp,
  name: string,
): Promise<number> {
  const projectId = tenant.project.id;
  const { baseUrl, apiKey } = await model<{ baseUrl: string; apiKey: string }>(
    "GET",
    "/connection?provider=anthropic",
  );
  const { modelConnection } = await api<{ modelConnection: { id: number } }>(
    request,
    "PUT",
    `/project/${projectId}/model-connection`,
    { name: "Scripted", provider: "anthropic", baseUrl, apiKey },
  );
  for (const [alias, modelId] of [
    ["default", "scripted-large"],
    ["fast", "scripted-small"],
  ]) {
    await api(request, "PUT", `/project/${projectId}/model-alias`, {
      name: alias,
      connectionId: modelConnection.id,
      modelId,
    });
  }
  const { bot } = await api<{ bot: { id: number } }>(
    request,
    "PUT",
    `/project/${projectId}/bot`,
    { name, persona: `You are ${name}. You are brief.` },
  );
  return bot.id;
}

test("a member starts a conversation from a bot's page, reads each turn live, and finds it in the lists", async ({
  page,
}) => {
  const admin = await signUpApi(page.request, "Conversation Admin");
  await openTenant(page, admin);
  const botId = await botWithScriptedModel(page.request, admin, "Ada");
  await script([
    {
      toolCalls: [
        {
          name: "reply_and_wait",
          input: { text: "Refunds take **five** business days." },
        },
      ],
    },
  ]);

  // The bot page links to its conversations; there are none yet.
  await page.goto(`/bots/${botId}`);
  await page.getByTestId("bot-conversations").click();
  await expect(page).toHaveURL(new RegExp(`/bots/${botId}/conversations$`));
  await expect(page.getByTestId("no-conversations")).toContainText(
    "No conversations with Ada yet",
    LANDED,
  );

  // Start one: the page opens it, and the reply arrives over the channel.
  await page
    .getByTestId("new-conversation-input")
    .fill("How long do refunds take?");
  await page.getByTestId("new-conversation-send").click();
  await expect(page).toHaveURL(/\/conversations\/\d+$/, LANDED);
  const conversationPath = new URL(page.url()).pathname;
  const conversationId = conversationPath.split("/").at(-1);
  // No title was given, so the page names it by its first message.
  await expect(page.getByTestId("conversation-title")).toHaveText(
    "How long do refunds take?",
  );
  await expect(page.getByTestId("tx-person").first()).toContainText(
    "Conversation Admin",
  );
  const reply = page.getByTestId("tx-bot").first();
  await expect(reply).toContainText("Refunds take five business days.", LANDED);
  // Markdown, and always visibly a bot.
  await expect(reply.locator("strong")).toHaveText("five");
  await expect(reply.locator(".ui-bot-badge[data-bot='Ada']")).toBeVisible();
  await expect(page.getByTestId("conversation-state")).toHaveAttribute(
    "data-state",
    "hibernating",
  );
  await expect(page.getByTestId("tx-status").last()).toHaveText(
    "Resting until someone writes",
  );

  // A second turn with a tool call before the bot finishes.
  await script([
    { toolCalls: [{ name: "search_history", input: { query: "refund" } }] },
    {
      toolCalls: [
        {
          name: "complete",
          input: { summary: "Answered the refund question." },
        },
      ],
    },
  ]);
  await page
    .getByTestId("conversation-composer-input")
    .fill("Thanks, that is all.");
  await page.getByTestId("conversation-composer-send").click();
  await expect(page.getByTestId("conversation-composer-input")).toHaveValue("");
  const call = page.locator(
    "[data-testid=tx-tool-call][data-tool=search_history]",
  );
  await expect(call).toBeVisible(LANDED);
  await expect(call).toHaveAttribute("data-status", "ok");
  // Collapsed to one row; opening it shows the input and the result.
  await expect(call.getByText("Input")).toBeHidden();
  await call.locator("summary").click();
  await expect(call.locator(".json-block").first()).toContainText('"refund"');
  await expect(call.locator(".json-block").nth(1)).toContainText("entries");
  await expect(
    page.locator("[data-testid=tx-bot][data-tool=complete]"),
  ).toContainText("Answered the refund question.", LANDED);
  const state = page.getByTestId("conversation-state");
  await expect(state).toHaveAttribute("data-state", "ended");
  await expect(state).toHaveAttribute("data-outcome", "completed");
  // Nothing left to cancel: disabled, and it says why.
  const cancel = page.getByTestId("cancel-conversation");
  await expect(cancel).toBeDisabled();
  await expect(cancel).toHaveAttribute("title", /has ended/);

  // The bot's list shows it ended, and the state filters narrow it.
  await page.goto(`/bots/${botId}/conversations`);
  const row = page.locator(`a[href='${conversationPath}']`);
  // The list does not read transcripts, so an untitled row is named by its id.
  await expect(row).toContainText(`Conversation #${conversationId}`, LANDED);
  await expect(row).toContainText("Completed");
  await expect(row).toHaveAttribute("data-state", "ended");
  await page.getByTestId("conversation-filter-working").click();
  await expect(page.getByTestId("no-conversations")).toHaveText(
    "No conversations in this state.",
  );
  await page.getByTestId("conversation-filter-ended").click();
  await expect(row).toBeVisible();

  // The project-wide list, from the sidebar, names the bot on each row.
  await page.getByTestId("nav-conversations").click();
  await expect(page).toHaveURL(/\/conversations$/);
  await expect(row.locator(".ui-bot-badge[data-bot='Ada']")).toBeVisible(
    LANDED,
  );
  await row.click();
  await expect(page).toHaveURL(new RegExp(`${conversationPath}$`));
  await expect(page.getByTestId("tx-bot")).toHaveCount(2);
});

test("Cancel stops a bot in the middle of a step", async ({ page }) => {
  const admin = await signUpApi(page.request, "Cancel Admin");
  await openTenant(page, admin);
  const botId = await botWithScriptedModel(page.request, admin, "Kit");
  // The model takes as long as it likes: the step is in flight until cancelled.
  await script([
    {
      hang: true,
      toolCalls: [{ name: "reply_and_wait", input: { text: "Never sent." } }],
    },
  ]);

  await page.goto(`/bots/${botId}/conversations`);
  await page.getByTestId("new-conversation-input").fill("Count to a billion.");
  await page.getByTestId("new-conversation-send").click();
  await expect(page).toHaveURL(/\/conversations\/\d+$/, LANDED);
  const state = page.getByTestId("conversation-state");
  await expect(state).toHaveAttribute("data-state", "working", LANDED);

  await page.getByTestId("cancel-conversation").click();
  await expect(state).toHaveAttribute("data-state", "ended", LANDED);
  await expect(state).toHaveAttribute("data-outcome", "cancelled");
  await expect(state).toContainText("Cancelled");
  await expect(page.getByTestId("tx-status").last()).toHaveText("Cancelled");
  await expect(page.getByTestId("tx-bot")).toHaveCount(0);
  await expect(page.getByTestId("cancel-conversation")).toBeDisabled();
  await model("POST", "/release");
});
