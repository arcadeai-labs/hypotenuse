import { type APIRequestContext, expect, test } from "@playwright/test";
import { MCP_CONTROL_URL, MCP_MODEL_CONTROL_URL } from "./env.ts";
import {
  api,
  LANDED,
  openSettings,
  openTenant,
  type SignedUp,
  signUpApi,
} from "./session.ts";

/**
 * Shared MCP servers in the dashboard, against real servers: the suite's
 * backend reaches the MCP fixtures (`mcp-server-process.ts`) exactly as it
 * reaches a real server, and a bot's model is a scripted model of this
 * spec's own, so the tool call that waits for approval is a real tick's.
 *
 * The scripted model answers in the order answers were queued, so these run
 * one at a time.
 */
test.describe.configure({ mode: "serial" });

/** One scripted answer, as the scripted model server takes it. */
interface ScriptedResponse {
  toolCalls?: { name: string; input: Record<string, unknown> }[];
  text?: string;
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
 * Give a project a model connection pointing at this spec's scripted model,
 * its `default` and `fast` names, and a bot.
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
  const { baseUrl, apiKey } = await control<{
    baseUrl: string;
    apiKey: string;
  }>(MCP_MODEL_CONTROL_URL, "GET", "/connection?provider=anthropic");
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

test("an admin connects an MCP server, gives it to a bot with a pattern, and decides the call it waits on", async ({
  page,
}) => {
  const admin = await signUpApi(page.request, "Tools Admin");
  await openTenant(page, admin);
  const projectId = admin.project.id;
  const botId = await botWithScriptedModel(page.request, admin, "Ada");
  const { url } = await control<{ url: string }>(
    MCP_CONTROL_URL,
    "GET",
    "/urls",
  );

  // Connect it through the settings page; it is listed at once.
  await openSettings(page, "mcp-servers");
  await expect(page.getByTestId("no-mcp-servers")).toBeVisible(LANDED);
  await page.getByTestId("mcp-connect-name").fill("mail");
  await page.getByTestId("mcp-connect-url").fill(url);
  await page.getByTestId("mcp-connect-submit").click();
  await expect(page.getByTestId("mcp-connect-notice")).toContainText(
    "Connected mail: 7 tools.",
    LANDED,
  );
  const row = page.getByTestId("mcp-server-row-mail");
  await expect(row).toHaveAttribute("data-status", "ok");
  await expect(page.getByTestId("mcp-server-credentials-mail")).toHaveText(
    "No credentials",
  );

  // Connecting opens its catalog: each tool, its description, its hints.
  const readInbox = page.getByTestId("mcp-tool-mail/read_inbox");
  await expect(readInbox).toContainText("Read the newest messages");
  await expect(readInbox.locator("[data-annotation=read-only]")).toHaveText(
    "Read-only",
  );
  await expect(
    page
      .getByTestId("mcp-tool-mail/send_email")
      .locator("[data-annotation=read-only]"),
  ).toHaveCount(0);

  // Test answers in its own card.
  await page.getByTestId("mcp-server-test-mail").click();
  await expect(page.getByTestId("mcp-servers-notice")).toContainText(
    "mail answered and lists 7 tools.",
  );

  // Give it to the bot: nothing is allowlisted, so everything waits.
  await page.goto(`/bots/${botId}`);
  await expect(page.getByTestId("bot-tools-empty")).toBeVisible(LANDED);
  await page
    .getByTestId("bot-tools-add-select")
    .selectOption({ label: "mail · 7 tools" });
  await page.getByTestId("bot-tools-add-submit").click();
  const binding = page.getByTestId("bot-tools-server-mail");
  await expect(binding).toBeVisible(LANDED);
  const preview = page.getByTestId("bot-tools-preview-mail");
  await expect(page.getByTestId("bot-tools-preview-count-mail")).toHaveText(
    "0 of 7 tools run without asking",
  );

  // A pattern previews live, matched by the server's own matcher.
  await page.getByTestId("bot-tools-patterns-mail").fill("mail/read_inbox");
  await expect(page.getByTestId("bot-tools-preview-count-mail")).toHaveText(
    "1 of 7 tools run without asking",
  );
  await expect(
    preview.getByTestId("mcp-tool-mail/read_inbox").locator("[data-allowance]"),
  ).toHaveAttribute("data-allowance", "runs");
  await expect(
    preview.getByTestId("mcp-tool-mail/send_email").locator("[data-allowance]"),
  ).toHaveText("Waits for approval");

  // A bad pattern is refused before anything is saved.
  await page.getByTestId("bot-tools-patterns-mail").fill("mail/a/b");
  await expect(page.getByTestId("bot-tools-pattern-error-mail")).toContainText(
    "is not server/tool",
  );
  await expect(page.getByTestId("bot-tools-save-mail")).toBeDisabled();

  // Read-only, with its warning: the server's claim, previewed too.
  await page.getByTestId("bot-tools-patterns-mail").fill("mail/read_inbox");
  await page.getByTestId("bot-tools-read-only-mail").check();
  await expect(
    page.getByTestId("bot-tools-read-only-warning-mail"),
  ).toContainText("the server's own claim");
  await expect(page.getByTestId("bot-tools-preview-count-mail")).toHaveText(
    "4 of 7 tools run without asking",
  );
  await page.getByTestId("bot-tools-read-only-mail").uncheck();
  await page.getByTestId("bot-tools-save-mail").click();
  await expect(page.getByTestId("bot-tools-notice-mail")).toContainText(
    "Saved.",
  );
  const { botMcpServers, capabilities } = await api<{
    botMcpServers: { allowedTools: string[]; autoAllowReadOnly: boolean }[];
    capabilities: string | null;
  }>(page.request, "GET", `/project/${projectId}/bot/${botId}/mcp-servers`);
  expect(botMcpServers[0]).toMatchObject({
    allowedTools: ["mail/read_inbox"],
    autoAllowReadOnly: false,
  });
  // The capabilities text is the plain list here (generation is off in e2e).
  expect(capabilities).toBe("- mail: 7 tools");
  await page.reload();
  await expect(page.getByTestId("bot-capabilities")).toContainText(
    "- mail: 7 tools",
    LANDED,
  );

  // The bot reads send_email's schema, then calls it: not allowlisted, so
  // the conversation parks on an approval.
  await control(MCP_MODEL_CONTROL_URL, "POST", "/reset");
  await control(MCP_CONTROL_URL, "POST", "/reset");
  const responses: ScriptedResponse[] = [
    { toolCalls: [{ name: "mcp_info", input: { name: "mail/send_email" } }] },
    {
      toolCalls: [
        {
          name: "mcp_exec",
          input: {
            name: "mail/send_email",
            args: { to: "toad@castle.example", subject: "The cake" },
          },
        },
      ],
    },
    { toolCalls: [{ name: "complete", input: { summary: "Emailed Toad." } }] },
  ];
  await control(MCP_MODEL_CONTROL_URL, "POST", "/play", { responses });
  const { conversation } = await api<{ conversation: { id: number } }>(
    page.request,
    "PUT",
    `/project/${projectId}/bot/${botId}/conversation`,
    { text: "Email Toad about the cake." },
  );

  // The conversation says what it waits for, and links to it.
  await page.goto(`/conversations/${conversation.id}`);
  const state = page.getByTestId("conversation-state");
  await expect(state).toHaveAttribute("data-state", "waiting", LANDED);
  await expect(state).toContainText("Waiting for approval");
  await expect(page.getByTestId("approval-wait")).toContainText(
    "Waiting for approval to run mail/send_email",
    LANDED,
  );

  // The inbox has it, and the sidebar counts it.
  await page.getByTestId("nav-approvals").click();
  await expect(page).toHaveURL(/\/approvals$/);
  await expect(
    page.getByTestId("nav-approvals").locator(".shell-nav-count"),
  ).toHaveText("1", LANDED);
  const approvalRow = page.locator("[data-testid^=approval-row-]").first();
  await expect(approvalRow).toContainText("mail/send_email", LANDED);
  await expect(approvalRow).toHaveAttribute("data-status", "pending");
  // A bot is always visibly a bot.
  await expect(
    approvalRow.locator(".ui-bot-badge[data-bot='Ada']"),
  ).toBeVisible();
  await expect(approvalRow).toContainText("Expires in");

  // Open it: the arguments, the conversation, who asked.
  await approvalRow.click();
  await expect(page).toHaveURL(/\/approvals\/\d+$/);
  await expect(page.getByTestId("approval-title")).toHaveText(
    "mail/send_email",
  );
  await expect(page.getByTestId("approval-args")).toContainText(
    '"toad@castle.example"',
  );
  await expect(page.getByTestId("approval-asked-by")).toHaveText("Tools Admin");
  await expect(page.getByTestId("approval-conversation")).toHaveAttribute(
    "href",
    `/conversations/${conversation.id}`,
  );
  expect(
    (await control<{ calls: unknown[] }>(MCP_CONTROL_URL, "GET", "/calls"))
      .calls,
  ).toEqual([]);

  // Approve once: the call runs, exactly as asked, and the bot finishes.
  await page.getByTestId("approval-approve").click();
  await expect(page.getByTestId("approval-notice")).toContainText(
    "Approved. Ada runs it now, once.",
  );
  await expect(page.getByTestId("approval-status")).not.toHaveAttribute(
    "data-status",
    "pending",
  );
  await expect(page.getByTestId("approval-approve")).toHaveCount(0);
  await page.getByTestId("approval-conversation").click();
  await expect(state).toHaveAttribute("data-state", "ended", LANDED);
  await expect(state).toHaveAttribute("data-outcome", "completed");
  await expect(page.getByTestId("approval-wait")).toHaveCount(0);
  const { calls } = await control<{
    calls: { tool: string; args: Record<string, unknown> }[];
  }>(MCP_CONTROL_URL, "GET", "/calls");
  expect(calls.map((c) => [c.tool, c.args])).toEqual([
    ["send_email", { to: "toad@castle.example", subject: "The cake" }],
  ]);

  // Nothing is pending now.
  await page.getByTestId("nav-approvals").click();
  await expect(page.getByTestId("no-approvals")).toBeVisible(LANDED);
  await expect(
    page.getByTestId("nav-approvals").locator(".shell-nav-count"),
  ).toHaveCount(0);
  await page.getByTestId("approval-filter-all").click();
  await expect(
    page.locator("[data-testid^=approval-row-]").first(),
  ).toHaveAttribute("data-status", /approved|consumed/);
});

test("an OAuth server is signed in through the browser and lands back on the settings page", async ({
  page,
}) => {
  const admin = await signUpApi(page.request, "OAuth Admin");
  await openTenant(page, admin);
  const { oauthUrl } = await control<{ oauthUrl: string }>(
    MCP_CONTROL_URL,
    "GET",
    "/urls",
  );

  await openSettings(page, "mcp-servers");
  await page.getByTestId("mcp-connect-name").fill("calendar");
  await page.getByTestId("mcp-connect-url").fill(oauthUrl);
  await page.getByTestId("mcp-connect-auth").selectOption("oauth");
  await page.getByTestId("mcp-connect-submit").click();
  await expect(page.getByTestId("mcp-connect-notice")).toContainText(
    "Sign in from its row",
    LANDED,
  );
  const row = page.getByTestId("mcp-server-row-calendar");
  await expect(row).toHaveAttribute("data-status", "needs_auth");
  await expect(page.getByTestId("mcp-server-credentials-calendar")).toHaveText(
    "OAuth, not signed in",
  );

  // The hop: the backend, the server's authorization page, the callback, and
  // back here with the landing in the query, read once and cleared.
  await page.getByTestId("mcp-server-sign-in-calendar").click();
  await expect(page.getByTestId("mcp-oauth-landing")).toContainText(
    "Signed in to calendar",
    LANDED,
  );
  await expect(page).toHaveURL(/\/settings\/mcp-servers$/);
  await expect(row).toHaveAttribute("data-status", "ok");
  await expect(page.getByTestId("mcp-server-credentials-calendar")).toHaveText(
    "OAuth, signed in",
  );
  await expect(page.getByTestId("mcp-server-sign-in-calendar")).toHaveCount(0);
  await expect(page.getByTestId("mcp-tool-calendar/read_inbox")).toBeVisible();
});
