import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";
import { CHAT_MODEL_CONTROL_URL, MCP_CONTROL_URL } from "./env.ts";
import {
  api,
  LANDED,
  openTenant,
  type SignedUp,
  signUpApi,
} from "./session.ts";

/**
 * The dashboard chat, against the real loop: every tick is a real
 * `agent:tick` on the suite's queue worker, the bot's model is this spec's
 * own scripted model speaking Anthropic's API, and the gated call is a real
 * call to the suite's MCP fixture. Nothing about the conversation is faked in
 * the browser.
 *
 * The scripted model answers in the order answers were queued, so these run
 * one at a time.
 */
test.describe.configure({ mode: "serial" });

/** One scripted answer, as the scripted model server takes it. */
interface ScriptedResponse {
  toolCalls?: { name: string; input: Record<string, unknown> }[];
  text?: string;
  hang?: boolean;
}

/**
 * Call a control server.
 * @param base - The control server's origin.
 * @param method - The HTTP verb.
 * @param path - The route.
 * @param body - A JSON body.
 * @returns The parsed answer.
 * @throws {Error} When it is not running.
 */
async function control<T>(
  base: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error(
      `Nothing answers at ${base}; scripts/e2e-backend.ts starts it.`,
    );
  }
  return (await res.json()) as T;
}

/**
 * Forget anything queued, then queue what the bot's model answers next.
 * @param responses - The answers, one per model step.
 */
async function script(responses: ScriptedResponse[]): Promise<void> {
  await control(CHAT_MODEL_CONTROL_URL, "POST", "/reset");
  await control(CHAT_MODEL_CONTROL_URL, "POST", "/play", { responses });
}

/**
 * Give a project a model connection pointing at this spec's scripted model,
 * its `default` and `fast` names, a bot, and the suite's mailbox MCP server
 * given to the bot with nothing allowlisted, so every call waits.
 * @param request - The admin's request context.
 * @param tenant - What the admin's sign-up made.
 * @param name - The bot's name.
 * @returns The bot's id.
 */
async function botWithMailbox(
  request: APIRequestContext,
  tenant: SignedUp,
  name: string,
): Promise<number> {
  const projectId = tenant.project.id;
  const { baseUrl, apiKey } = await control<{
    baseUrl: string;
    apiKey: string;
  }>(CHAT_MODEL_CONTROL_URL, "GET", "/connection?provider=anthropic");
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
  const { url } = await control<{ url: string }>(
    MCP_CONTROL_URL,
    "GET",
    "/urls",
  );
  const { mcpServer } = await api<{ mcpServer: { id: number } }>(
    request,
    "PUT",
    `/project/${projectId}/mcp-server`,
    { name: "mail", url, authMode: "none" },
  );
  await api(request, "PUT", `/project/${projectId}/bot/${bot.id}/mcp-server`, {
    mcpServerId: mcpServer.id,
  });
  return bot.id;
}

/**
 * Screenshot the page in both themes, into the test's output, and leave it
 * light.
 * @param page - The page.
 * @param name - The file's stem.
 */
async function bothThemes(page: Page, name: string): Promise<void> {
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator("html")).toHaveAttribute("data-theme", scheme);
    await page.screenshot({
      path: test.info().outputPath(`${name}-${scheme}.png`),
      fullPage: true,
    });
  }
  await page.emulateMedia({ colorScheme: "light" });
}

test("a member chats with a bot from its page: the reply arrives live, a question is answered by button, a gated call is approved from its card, and the steps open the transcript", async ({
  page,
}) => {
  const admin = await signUpApi(page.request, "Chat Admin");
  await openTenant(page, admin);
  const botId = await botWithMailbox(page.request, admin, "Ada");

  // The first step hangs, so the live surface is there to see.
  await script([
    {
      hang: true,
      text: "Refunds take five business days.",
      toolCalls: [
        {
          name: "reply_and_wait",
          input: { text: "Refunds take **five** business days." },
        },
      ],
    },
  ]);

  // The bot page opens its chat; the person has none yet, so it is blank.
  await page.goto(`/bots/${botId}`);
  await page.getByTestId("bot-chat").click();
  await expect(page).toHaveURL(new RegExp(`/bots/${botId}/chat$`));
  await expect(page.getByTestId("chat-blank")).toBeVisible(LANDED);

  // The first message starts the conversation on the dashboard channel.
  await page
    .getByTestId("chat-composer-input")
    .fill("How long do refunds take?");
  await page.getByTestId("chat-composer-send").click();
  await expect(page).toHaveURL(/\/chat\?c=\d+$/, LANDED);
  const conversationId = Number(new URL(page.url()).searchParams.get("c"));
  await expect(page.getByTestId("chat-where")).toContainText("dashboard");
  await expect(page.getByTestId("chat-person")).toContainText(
    "How long do refunds take?",
  );

  // While the step is in flight, the status line says what it is doing.
  await expect(page.getByTestId("chat-status")).toBeVisible(LANDED);
  await control(CHAT_MODEL_CONTROL_URL, "POST", "/release");

  // The reply arrives as a bot bubble, with the bot's badge and its details.
  const reply = page.getByTestId("chat-bot").first();
  await expect(reply).toContainText("Refunds take five business days.", LANDED);
  await expect(reply.locator(".ui-bot-badge[data-bot='Ada']")).toBeVisible();
  await expect(page.getByTestId("chat-status")).toHaveCount(0, LANDED);
  await reply.getByTestId("chat-diagnostics").locator("summary").click();
  await expect(reply.getByTestId("chat-diagnostics")).toContainText(
    "scripted-large",
  );

  // A question: its options are buttons, and a click is the answer.
  await script([
    {
      toolCalls: [
        {
          name: "ask_question",
          input: {
            question: "Which region is Globex billed in?",
            options: ["EU", "US"],
          },
        },
      ],
    },
    { toolCalls: [{ name: "mcp_info", input: { name: "mail/send_email" } }] },
    {
      toolCalls: [
        {
          name: "mcp_exec",
          input: {
            name: "mail/send_email",
            args: { to: "billing-eu@globex.example", subject: "Refund" },
          },
        },
      ],
    },
    {
      toolCalls: [
        { name: "complete", input: { summary: "Emailed Globex's EU team." } },
      ],
    },
  ]);
  await page.getByTestId("chat-composer-input").fill("Refund Globex, please.");
  await page.getByTestId("chat-composer-send").click();
  const question = page.getByTestId("chat-question");
  await expect(question).toContainText("Which region", LANDED);
  await expect(question).toContainText("Needs an answer", LANDED);
  await question.getByTestId("chat-option").filter({ hasText: "EU" }).click();
  await expect(
    page.getByTestId("chat-person").filter({ hasText: "EU" }),
  ).toHaveCount(1, LANDED);
  await expect(question.getByTestId("chat-option").first()).toBeDisabled(
    LANDED,
  );

  // The gated call waits in a card, decidable here.
  const card = page.getByTestId("chat-approval");
  await expect(card).toContainText("mail/send_email", LANDED);
  await expect(card).toContainText("billing-eu@globex.example");
  await bothThemes(page, "chat-approval");
  await card.getByTestId("chat-approve").click();

  // Approved once, it runs, and the bot finishes with an outcome chip.
  const done = page.getByTestId("chat-bot").filter({ hasText: "Emailed" });
  await expect(done).toBeVisible(LANDED);
  await expect(done.getByTestId("chat-outcome")).toHaveText("Completed");
  await expect(card.getByTestId("chat-approval-status")).toBeVisible(LANDED);
  const { approvals } = await api<{
    approvals: { status: string; decidedVia: string | null }[];
  }>(
    page.request,
    "GET",
    `/project/${admin.project.id}/approvals?conversationId=${conversationId}`,
  );
  expect(approvals.map((a) => a.decidedVia)).toEqual(["dashboard"]);
  await bothThemes(page, "chat");

  // The work between the answer and the approval is one line; it opens the
  // transcript at those steps.
  const steps = page.getByTestId("chat-steps-link").last();
  await expect(steps).toContainText(/Worked through \d+ steps?/);
  await steps.click();
  await expect(page).toHaveURL(
    new RegExp(`/conversations/${conversationId}\\?view=transcript&seqs=`),
    LANDED,
  );
  await expect(page.getByTestId("transcript")).toBeVisible(LANDED);
  await expect(page.getByTestId("tx-highlight").first()).toBeVisible();
  await expect(page.getByTestId("conversation-channel-platform")).toHaveText(
    "Dashboard",
  );

  // The conversation page toggles back to the chat.
  await page.getByTestId("conversation-view-chat").click();
  await expect(page.getByTestId("chat")).toBeVisible();

  // Coming back to the bot's chat opens this conversation again.
  await page.goto(`/bots/${botId}/chat`);
  await expect(page).toHaveURL(new RegExp(`\\?c=${conversationId}$`), LANDED);
});

test("a fresh channel starts empty, and the palette offers a chat with each bot", async ({
  page,
}) => {
  const admin = await signUpApi(page.request, "Fresh Chat Admin");
  await openTenant(page, admin);
  const botId = await botWithMailbox(page.request, admin, "Kit");
  await script([
    {
      toolCalls: [{ name: "reply_and_wait", input: { text: "Hello again." } }],
    },
  ]);

  // The palette's "Chat with Kit" opens Kit's chat.
  // Wait for the list, so the shell's keymap is listening.
  await page.goto("/bots");
  await expect(page.getByTestId("bot-row-kit")).toBeVisible(LANDED);
  await page.keyboard.press(
    process.platform === "darwin" ? "Meta+k" : "Control+k",
  );
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.getByTestId("command-palette-input").fill("Chat with Kit");
  await page.getByTestId("command-chat-with-kit").click();
  await expect(page).toHaveURL(new RegExp(`/bots/${botId}/chat`), LANDED);

  // A fresh channel says what it does to memory, and is not the dashboard.
  await page.getByTestId("chat-new-fresh").click();
  await expect(page.getByTestId("chat-blank")).toContainText("fresh channel");
  await page.getByTestId("chat-composer-input").fill("Hi");
  await page.getByTestId("chat-composer-input").press("Enter");
  await expect(page.getByTestId("chat-where")).toContainText(
    "scratch-",
    LANDED,
  );
  await expect(page.getByTestId("chat-bot")).toContainText(
    "Hello again.",
    LANDED,
  );
});
