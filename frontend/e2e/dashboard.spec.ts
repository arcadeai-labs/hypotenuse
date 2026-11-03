import { type APIRequestContext, expect, test } from "@playwright/test";
import { DASHBOARD_MODEL_CONTROL_URL as MODEL_CONTROL_URL } from "./env.ts";
import {
  api,
  LANDED,
  openTenant,
  type SignedUp,
  signUpApi,
} from "./session.ts";

/**
 * Mission control against the real loop: the suite's backend runs a queue
 * worker, so every tick is a real `agent:tick` on the scripted model. The
 * pages are opened first and never reloaded — what they show next arrives
 * over the bot's dashboard channel and the re-read it triggers.
 *
 * The scripted model is this spec's own (no other spec's answers meet its
 * queue), and answers in the order answers were queued, so these run one at
 * a time.
 */
test.describe.configure({ mode: "serial" });

/** One scripted answer. */
interface ScriptedResponse {
  toolCalls?: { name: string; input: Record<string, unknown> }[];
}

/**
 * Call the scripted model's control server.
 * @param method - The HTTP verb.
 * @param path - The route.
 * @param body - A JSON body.
 * @returns The parsed answer.
 */
async function model<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${MODEL_CONTROL_URL}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
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
 * A model connection on the scripted model, its two names, and a bot.
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

test("Home and the inbox follow a bot live, and a failed turn is retried from its page", async ({
  page,
}) => {
  const admin = await signUpApi(page.request, "Dashboard Admin");
  await openTenant(page, admin);
  const projectId = admin.project.id;
  const botId = await botWithScriptedModel(page.request, admin, "Grace");

  await page.goto("/home");
  await expect(page.getByTestId(`home-bot-${botId}`)).toBeVisible(LANDED);
  await expect(page.getByTestId("home-working")).toContainText("0");
  await expect(page.getByTestId("home-inbox-empty")).toBeVisible();

  // A conversation the bot fails: the home page's feed shows it, unreloaded.
  await script([
    { toolCalls: [{ name: "fail", input: { reason: "The key is missing." } }] },
  ]);
  const { conversation } = await api<{ conversation: { id: number } }>(
    page.request,
    "PUT",
    `/project/${projectId}/bot/${botId}/conversation`,
    { text: "Open the vault." },
  );
  const recent = page.getByTestId(`home-recent-${conversation.id}`);
  await expect(recent).toHaveAttribute("data-state", "ended", LANDED);
  await expect(recent).toContainText("Failed");

  // An escalation lands in Needs a person, and in the inbox.
  await script([
    {
      toolCalls: [
        {
          name: "escalate_to_human",
          input: { question: "Which vault is it?", context: "Two vaults." },
        },
      ],
    },
  ]);
  const asked = await api<{ conversation: { id: number } }>(
    page.request,
    "PUT",
    `/project/${projectId}/bot/${botId}/conversation`,
    { text: "Open the other vault." },
  );
  await expect(page.locator("[data-testid^=home-inbox-help-]")).toContainText(
    "Which vault is it?",
    LANDED,
  );
  await expect(page.getByTestId(`home-bot-${botId}-waiting`)).toHaveText(
    "1",
    LANDED,
  );

  await page.getByTestId("nav-inbox").click();
  await expect(page).toHaveURL(/\/inbox$/);
  const row = page.locator("[data-kind=help]").first();
  await expect(row).toContainText("Which vault is it?", LANDED);
  await page.getByTestId("inbox-filter-approval").click();
  await expect(page.getByTestId("inbox-empty")).toBeVisible(LANDED);
  await page.getByTestId("inbox-filter-all").click();

  // The conversations list filters by what a waiting one waits on.
  await page.goto("/conversations?waitingKind=help");
  await expect(
    page.getByTestId(`conversation-row-${asked.conversation.id}`),
  ).toBeVisible(LANDED);
  await expect(
    page.getByTestId(`conversation-row-${conversation.id}`),
  ).toHaveCount(0);

  // Retry the failed one: a new turn, told to try again, that answers.
  await script([
    { toolCalls: [{ name: "reply_and_wait", input: { text: "Found it." } }] },
  ]);
  await page.goto(`/conversations/${conversation.id}?view=transcript`);
  const retry = page.getByTestId("retry-conversation");
  await expect(retry).toBeEnabled(LANDED);
  await retry.click();
  await expect(page.getByTestId("conversation-state")).toHaveAttribute(
    "data-state",
    "hibernating",
    LANDED,
  );
  await expect(page.getByTestId("tx-bot").last()).toContainText(
    "Found it.",
    LANDED,
  );
  await expect(page.getByTestId("retry-conversation")).toHaveCount(0);
  await expect(page.getByTestId("conversation-outbox")).toBeVisible();
});
