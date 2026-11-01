/**
 * Capture every docs illustration twice — light and dark — into
 * `public/doc-assets/illustrations/<name>-{light,dark}.png`, which `ThemedImage`
 * picks between by the app's resolved theme (a docs page embeds one as
 * `![alt](illustration:<name>)`).
 *
 * Needs the frontend and the backend running (`bun dev`, or `FRONTEND_URL` and
 * `API_URL`). An illustration marked `signedIn` is taken as a fixed person in a
 * fixed tenant — Ada Lovelace, owner of Acme, with the projects Support and
 * Platform — which {@link seed} creates over the API the first time and finds
 * again after that, so a rerun draws the same picture.
 *
 * The conversation illustrations need real transcripts, so the first run has
 * the bots talk to the scripted model server the browser suite uses
 * (`backend/__tests__/fixtures/model-server-process.ts`, started here by path
 * unless one already answers on `MODEL_SERVER_CONTROL_PORT`). Its address is
 * loopback, so that run needs the backend started with
 * `NETWORK_ALLOW_PRIVATE_HOSTS=true` (`NETWORK_ALLOW_PRIVATE_HOSTS=true bun dev`).
 * The Anthropic connection points at it only while the conversations are
 * made, and is put back after. The memory illustrations read what Ada wrote
 * in one of those conversations, plus documents written over the API.
 *
 * The MCP illustrations need real MCP servers, so the script starts the
 * browser suite's (`backend/__tests__/fixtures/mcp-server-process.ts`, with
 * its mailbox toolset) unless one already answers on `MCP_SERVER_CONTROL_PORT`.
 * They listen on loopback too, and a fixture's port changes every time it
 * starts, so a rerun points the seeded servers at the new addresses. Two of
 * the seeded conversations park on a call to the mailbox, which is what the
 * approvals inbox shows; Ada's approvals expire after thirty days. Start the
 * backend with `MCP_GENERATE_CAPABILITIES=false` as well, so writing Ada's
 * capabilities never takes a scripted answer meant for a conversation:
 *
 *   NETWORK_ALLOW_PRIVATE_HOSTS=true MCP_GENERATE_CAPABILITIES=false bun dev
 *
 * The chat illustration is a seeded dashboard chat (`channelType: "web"`)
 * that ends parked on an approval; the help inbox shows a seeded conversation
 * in which Ada asks a person for help. The Channels illustration reads what
 * {@link seedChannels} makes: Ada's webhook app, connected, and a signed
 * message from each of three channels, delivered to its events URL.
 *
 * The prompt, goal, and skill illustrations read what {@link seedPrompt}
 * writes over the API — two people's edits to Ada's *How I work*, a
 * contextual section, two sections every bot includes, three goals, and two
 * skills, one edited — plus a seeded conversation in which Ada adds to her
 * own *Things I have learned* with `prompt_edit`, so her history has an edit
 * marked as the bot's.
 *
 *   cd frontend && bun run docs:illustrations
 *   ILLUSTRATIONS=bot,memory bun run docs:illustrations   # only those
 */
import { createHmac } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, chromium } from "@playwright/test";
import type { Subprocess } from "bun";

/** What {@link seed} made, for a route that names a row by its id. */
interface Seeded {
  organizationId: number;
  projectId: number;
  botId: number;
  /** The conversation the transcript illustration opens. */
  conversationId: number;
  /** The channel whose memory the bot's memory illustrations open. */
  memoryChannelId: number;
  /** The MCP server whose catalog the MCP servers illustration opens. */
  mcpServerId: number;
  /** The conversation whose program the code-mode illustration opens. */
  codeConversationId: number;
  /** The dashboard chat the chat illustration opens. */
  chatConversationId: number;
}

/** One illustration: a route, and optionally the element to crop to (`{theme}` is replaced). */
interface Illustration {
  name: string;
  /** The route, or a function of the seeded tenant for one that names a row. */
  path: string | ((seeded: Seeded) => string);
  selector?: string;
  width?: number;
  height?: number;
  /** Taken signed in as the seeded person. */
  signedIn?: boolean;
  /** Selectors clicked in turn before the shot, to open what it shows. */
  open?: string[];
}

/** Every illustration the docs embed. Add a row, rerun, commit the PNGs. */
const ILLUSTRATIONS: Illustration[] = [
  { name: "home", path: "/", width: 1280, height: 800 },
  {
    name: "shell",
    path: "/organization/projects",
    width: 1280,
    height: 720,
    signedIn: true,
  },
  {
    name: "audit",
    path: "/organization/audit",
    width: 1280,
    height: 800,
    signedIn: true,
  },
  {
    name: "models",
    path: "/settings/models",
    width: 1280,
    height: 900,
    signedIn: true,
  },
  {
    name: "bots",
    path: "/bots",
    width: 1280,
    height: 560,
    signedIn: true,
  },
  {
    name: "bot",
    path: ({ botId }) => `/bots/${botId}`,
    width: 1280,
    height: 5200,
    signedIn: true,
  },
  {
    name: "bot-prompt",
    path: ({ botId }) => `/bots/${botId}/prompt`,
    width: 1440,
    height: 1500,
    signedIn: true,
    open: ["[data-testid=prompt-section-bot-things-i-have-learned-history]"],
  },
  {
    name: "bot-goals",
    path: ({ botId }) => `/bots/${botId}`,
    selector: "[data-testid=bot-bot-goals]",
    width: 1280,
    height: 5200,
    signedIn: true,
  },
  {
    name: "bot-skills",
    path: ({ botId }) => `/bots/${botId}`,
    selector: "[data-testid=bot-bot-skills]",
    width: 1280,
    height: 5200,
    signedIn: true,
  },
  {
    name: "skills",
    path: "/settings/skills",
    selector: "[data-testid=skills-card]",
    width: 1280,
    height: 1400,
    signedIn: true,
    open: ["[data-testid=skill-expand-release-notes]"],
  },
  {
    name: "mcp-servers",
    path: ({ mcpServerId }) => `/settings/mcp-servers?server=${mcpServerId}`,
    width: 1280,
    height: 1240,
    signedIn: true,
  },
  {
    name: "bot-tools",
    path: ({ botId }) => `/bots/${botId}`,
    selector: "[data-testid=bot-bot-tools]",
    width: 1280,
    height: 4000,
    signedIn: true,
  },
  {
    name: "bot-code",
    path: ({ botId }) => `/bots/${botId}`,
    selector: "[data-testid=bot-bot-code]",
    width: 1280,
    height: 5200,
    signedIn: true,
  },
  {
    name: "code-run",
    path: ({ codeConversationId }) => `/conversations/${codeConversationId}`,
    width: 1280,
    height: 1100,
    signedIn: true,
    open: ["[data-testid=tx-code-run] > summary"],
  },
  {
    name: "approvals",
    path: "/approvals",
    width: 1280,
    height: 440,
    signedIn: true,
  },
  {
    name: "conversations",
    path: "/conversations",
    width: 1280,
    height: 440,
    signedIn: true,
  },
  {
    name: "conversation",
    path: ({ conversationId }) => `/conversations/${conversationId}`,
    width: 1280,
    height: 860,
    signedIn: true,
  },
  {
    name: "memory",
    path: "/memory?q=deploy",
    width: 1280,
    height: 720,
    signedIn: true,
  },
  {
    name: "memory-channel",
    path: ({ botId, memoryChannelId }) =>
      `/bots/${botId}/memory/${memoryChannelId}`,
    width: 1280,
    height: 560,
    signedIn: true,
  },
  {
    name: "memory-document",
    path: ({ botId, memoryChannelId }) =>
      `/bots/${botId}/memory/${memoryChannelId}/document?path=customers/globex.md`,
    width: 1280,
    height: 760,
    signedIn: true,
  },
  {
    name: "chat",
    path: ({ botId, chatConversationId }) =>
      `/bots/${botId}/chat?c=${chatConversationId}`,
    width: 1280,
    height: 1300,
    signedIn: true,
  },
  {
    name: "bot-channels",
    path: ({ botId }) => `/bots/${botId}`,
    selector: "[data-testid=bot-bot-channels]",
    width: 1280,
    height: 6400,
    signedIn: true,
  },
  {
    name: "bot-slack",
    path: ({ botId }) => `/bots/${botId}`,
    selector: "[data-testid=bot-channels-platform-slack]",
    width: 1280,
    height: 6400,
    signedIn: true,
  },
  {
    name: "bot-linear",
    path: ({ botId }) => `/bots/${botId}`,
    selector: "[data-testid=bot-channels-platform-linear]",
    width: 1280,
    height: 6400,
    signedIn: true,
  },
  {
    name: "help",
    path: "/help",
    width: 1280,
    height: 440,
    signedIn: true,
  },
  {
    name: "style-guide",
    path: "/docs/style-guide",
    selector: "[data-testid=style-guide-{theme}]",
    width: 1440,
    height: 900,
  },
];

/** `ILLUSTRATIONS=bot,memory` captures only those; unset captures all. */
const ONLY = process.env.ILLUSTRATIONS?.split(",").map((s) => s.trim());

const BASE = process.env.FRONTEND_URL ?? "http://localhost:3000";
const API = `${process.env.API_URL ?? "http://localhost:8080"}/api`;

/** The person the signed-in illustrations are taken as. */
const PERSON = {
  name: "Ada Lovelace",
  email: "ada@acme.example",
  password: "illustrations",
};

/**
 * Call the API on a context's cookie jar, which the context's pages share.
 * @param request - The browser context's request client.
 * @param method - The HTTP verb.
 * @param path - The route beneath `/api`.
 * @param data - A JSON body.
 * @returns The parsed answer, error envelope included.
 */
async function call<T>(
  request: APIRequestContext,
  method: string,
  path: string,
  data?: unknown,
): Promise<T & { error?: { message: string } }> {
  const res = await request.fetch(`${API}${path}`, { method, data });
  return (await res.json()) as T & { error?: { message: string } };
}

/** The Support project's bots, as the bot illustrations show them. */
const BOTS = [
  {
    name: "Ada",
    description: "Answers billing and account questions in #support",
    persona:
      "You are **Ada**, the support team's teammate.\n\n- Answer from what this channel already knows before asking.\n- Never promise a refund; say a person on the billing team will confirm it.\n- Keep replies short; link rather than paste.",
    accessWrite: ["support"],
    monthlyBudgetUsd: 200,
  },
  {
    name: "Kit",
    description: "Triages incoming Linear issues for the platform team",
    persona: "You are **Kit**. You triage issues and ask before you assign.",
    accessWrite: [],
    monthlyBudgetUsd: null,
  },
  {
    name: "Ledger",
    description: "Reconciles invoices with the finance channel",
    persona: "You are **Ledger**. You check numbers twice.",
    accessWrite: [],
    monthlyBudgetUsd: null,
    enabled: false,
  },
];

/**
 * Give the Support project what the models and bots illustrations show: two
 * tags, a connection (its key is a placeholder, so it stays untested), the
 * `default` and `fast` names, and three bots. Each is made only when missing.
 * @param request - The browser context's request client.
 * @param projectId - The Support project.
 * @returns The id of the bot the bot page illustration opens.
 */
async function seedBots(
  request: APIRequestContext,
  projectId: number,
): Promise<number> {
  const { tags } = await call<{ tags: { name: string }[] }>(
    request,
    "GET",
    `/project/${projectId}/tags?limit=100`,
  );
  for (const name of ["support", "billing"]) {
    if (!tags.some((t) => t.name === name)) {
      await call(request, "PUT", `/project/${projectId}/tag`, { name });
    }
  }

  const { modelConnections } = await call<{
    modelConnections: { id: number; name: string }[];
  }>(request, "GET", `/project/${projectId}/model-connections?limit=100`);
  let connection = modelConnections.find((c) => c.name === "Anthropic");
  if (!connection) {
    const created = await call<{
      modelConnection: { id: number; name: string };
    }>(request, "PUT", `/project/${projectId}/model-connection`, {
      name: "Anthropic",
      provider: "anthropic",
      apiKey: "sk-ant-illustration-placeholder-a1f3",
    });
    if (created.error) throw new Error(`connection: ${created.error.message}`);
    connection = created.modelConnection;
  }

  const { modelAliases } = await call<{ modelAliases: { name: string }[] }>(
    request,
    "GET",
    `/project/${projectId}/model-aliases?limit=100`,
  );
  for (const [name, modelId] of [
    ["default", "claude-sonnet-4-5"],
    ["fast", "claude-haiku-4-5"],
  ]) {
    if (!modelAliases.some((a) => a.name === name)) {
      await call(request, "PUT", `/project/${projectId}/model-alias`, {
        name,
        connectionId: connection.id,
        modelId,
      });
    }
  }

  const { bots } = await call<{ bots: { id: number; name: string }[] }>(
    request,
    "GET",
    `/project/${projectId}/bots?limit=100`,
  );
  for (const bot of BOTS) {
    if (!bots.some((b) => b.name === bot.name)) {
      const created = await call<{ bot: { id: number; name: string } }>(
        request,
        "PUT",
        `/project/${projectId}/bot`,
        bot,
      );
      if (created.error) throw new Error(`bot: ${created.error.message}`);
      bots.push(created.bot);
    }
  }
  const ada = bots.find((b) => b.name === "Ada");
  if (!ada) throw new Error("the Ada bot is missing");
  return ada.id;
}

/**
 * Sign the seeded person in on a context, creating them and their tenant the
 * first time: sign-up's organization renamed Acme, its Default project renamed
 * Support (with the models and bots {@link seedBots} gives it), and a second
 * project, Platform.
 * @param request - The browser context's request client.
 * @returns The organization, the Support project, and the bot to open.
 * @throws {Error} When the API refuses a step.
 */
async function seed(request: APIRequestContext): Promise<Seeded> {
  await call(request, "PUT", "/user", PERSON);
  const session = await call(request, "PUT", "/session", {
    email: PERSON.email,
    password: PERSON.password,
  });
  if (session.error) throw new Error(`sign-in: ${session.error.message}`);

  const { organizations } = await call<{
    organizations: { id: number; name: string }[];
  }>(request, "GET", "/organizations");
  const organization = organizations[0];
  if (organization.name !== "Acme") {
    await call(request, "POST", `/organization/${organization.id}`, {
      name: "Acme",
    });
  }
  const { projects } = await call<{ projects: { id: number; name: string }[] }>(
    request,
    "GET",
    `/projects?organizationId=${organization.id}`,
  );
  const first = projects.find((p) => p.name === "Default");
  if (first) {
    await call(request, "POST", `/project/${first.id}`, { name: "Support" });
  }
  if (!projects.some((p) => p.name === "Platform")) {
    await call(request, "PUT", "/project", {
      organizationId: organization.id,
      name: "Platform",
    });
  }
  const support = first ?? projects.find((p) => p.name === "Support");
  if (!support) throw new Error("the Support project is missing");
  const botId = await seedBots(request, support.id);
  // Before the conversations: two of them call Ada's mailbox.
  const mcpServerId = await seedMcp(request, support.id, botId);
  const conversationId = await seedConversations(request, support.id);
  await seedPrompt(request, support.id, botId);
  const { conversations } = await call<{
    conversations: { id: number; title: string | null }[];
  }>(request, "GET", `/project/${support.id}/conversations?limit=100`);
  const coded = conversations.find((c) => c.title === CODE_TITLE);
  if (!coded) throw new Error(`the ${CODE_TITLE} conversation is missing`);
  const chatted = conversations.find((c) => c.title === CHAT_TITLE);
  if (!chatted) throw new Error(`the ${CHAT_TITLE} conversation is missing`);
  await seedChannels(request, support.id, botId);
  await seedSlack(request, support.id, botId);
  await seedLinear(request, support.id, botId);
  return {
    organizationId: organization.id,
    projectId: support.id,
    botId,
    conversationId,
    memoryChannelId: await seedMemory(request, support.id, botId),
    mcpServerId,
    codeConversationId: coded.id,
    chatConversationId: chatted.id,
  };
}

/** Where the scripted model's control server listens. */
const MODEL_CONTROL = `http://127.0.0.1:${process.env.MODEL_SERVER_CONTROL_PORT ?? "9180"}`;

/** The scripted model this script started, if it had to. */
let modelProcess: Subprocess | null = null;

/** One scripted answer to a model step. */
interface Scripted {
  text?: string;
  reasoning?: string;
  toolCalls?: { name: string; input: Record<string, unknown> }[];
  hang?: boolean;
}

/**
 * Call the scripted model's control server, starting it first if nothing
 * answers.
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
  const send = () =>
    fetch(`${MODEL_CONTROL}${path}`, {
      method,
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  try {
    return (await (await send()).json()) as T;
  } catch {
    if (modelProcess) throw new Error("the scripted model stopped answering");
  }
  modelProcess = Bun.spawn(
    ["bun", "__tests__/fixtures/model-server-process.ts"],
    {
      cwd: join(import.meta.dirname, "../../backend"),
      env: {
        ...process.env,
        MODEL_SERVER_CONTROL_PORT: new URL(MODEL_CONTROL).port,
      },
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100);
    try {
      return (await (await send()).json()) as T;
    } catch {
      // Not listening yet.
    }
  }
  throw new Error(`the scripted model never answered at ${MODEL_CONTROL}`);
}

/** One turn of a seeded conversation: what the person writes and what the model answers. */
interface Turn {
  text: string;
  responses: Scripted[];
  /** Cancel the turn while its model step is in flight. */
  cancel?: boolean;
}

/** The title of the dashboard chat the chat illustration opens. */
const CHAT_TITLE = "Globex refund";

/** The title of the conversation that asks a person for help. */
const HELP_TITLE = "Late fee for Initech";

/** The title of the conversation whose program the code-mode illustration opens. */
const CODE_TITLE = "Billing mail this week";

/** The program Ada runs there: read the inbox once, keep the billing messages. */
const CODE_PROGRAM = `// Read the inbox once, keep only what is about billing.
await mcp.info("mail", "read_inbox");
const inbox = String(await mcp.exec("mail", "read_inbox", { limit: 50 }));
const lines = inbox.split("\\n").filter((l) => l.trim());
const billing = lines.filter((l) => /billing|charge|invoice/i.test(l));
console.log(\`\${billing.length} of \${lines.length} messages are about billing\`);
return billing.map((l) => l.replace(/^\\d+\\. /, ""));`;

/** The conversations the conversation illustrations show, oldest first. */
const CONVERSATIONS: {
  bot: string;
  title: string;
  turns: Turn[];
  /** `web` for a dashboard chat; the API channel otherwise. */
  channelType?: "web";
}[] = [
  {
    bot: "Ada",
    title: CODE_TITLE,
    turns: [
      {
        text: "Who wrote in about billing this week?",
        responses: [
          {
            toolCalls: [{ name: "run_code", input: { source: CODE_PROGRAM } }],
          },
          {
            toolCalls: [
              {
                name: "reply_and_wait",
                input: {
                  text: "One billing message this week: Globex reported a duplicate charge on INV-2291.",
                },
              },
            ],
          },
        ],
      },
    ],
  },
  {
    bot: "Kit",
    title: "Summarize this week's incidents",
    turns: [
      {
        text: "Summarize this week's incidents for the platform channel.",
        responses: [{ hang: true }],
        cancel: true,
      },
    ],
  },
  {
    bot: "Ada",
    title: "CSV export fails for Initech",
    turns: [
      {
        text: "Initech says their CSV export has failed since Monday. Can you fix it?",
        responses: [
          {
            toolCalls: [
              {
                name: "fail",
                input: {
                  reason:
                    "I cannot reach the export service from here. Someone on the platform team can rerun Initech's export; I've noted the date it started failing.",
                },
              },
            ],
          },
        ],
      },
    ],
  },
  {
    bot: "Kit",
    title: "Recheck ENG-142 after the deploy",
    turns: [
      {
        text: "Check ENG-142 again after tomorrow's deploy.",
        responses: [
          {
            toolCalls: [
              {
                name: "wait_for",
                input: {
                  seconds: 604800,
                  note: "Waiting for the deploy before rechecking ENG-142.",
                },
              },
            ],
          },
        ],
      },
    ],
  },
  {
    bot: "Ada",
    title: "Which plan includes SSO?",
    turns: [
      {
        text: "A customer asks which plan includes SSO.",
        responses: [
          {
            toolCalls: [
              {
                name: "ask_question",
                input: {
                  question:
                    "Do they mean SSO for the dashboard, or for the API?",
                  options: ["Dashboard", "API"],
                },
              },
            ],
          },
        ],
      },
    ],
  },
  {
    bot: "Ada",
    title: "Tell Globex their refund is with billing",
    turns: [
      {
        text: "Email Globex's billing contact that the duplicate charge is with our billing team.",
        responses: [
          {
            toolCalls: [
              { name: "mcp_info", input: { name: "mail/send_email" } },
            ],
          },
          {
            toolCalls: [
              {
                name: "mcp_exec",
                input: {
                  name: "mail/send_email",
                  args: {
                    to: "priya@globex.example",
                    subject: "Your duplicate October charge (INV-2291)",
                    body: "Hi Priya — our billing team has the duplicate charge on INV-2291 and will confirm the refund.",
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  },
  {
    bot: "Ada",
    title: "Clean up the duplicate invoice mail",
    turns: [
      {
        text: "Delete the duplicate INV-2291 email from the support inbox.",
        responses: [
          {
            toolCalls: [
              { name: "mcp_info", input: { name: "mail/delete_message" } },
            ],
          },
          {
            toolCalls: [
              {
                name: "mcp_exec",
                input: {
                  name: "mail/delete_message",
                  args: { messageId: "msg-inv-2291-copy" },
                },
              },
            ],
          },
        ],
      },
    ],
  },
  {
    bot: "Ada",
    title: "Staging is called preprod here",
    turns: [
      {
        text: "FYI: on this team, staging is called preprod. Please remember that.",
        responses: [
          {
            toolCalls: [
              {
                name: "prompt_edit",
                input: {
                  section: "things-i-have-learned",
                  patches: [
                    {
                      start_line: 1,
                      end_line: 1,
                      content:
                        "- This team calls the staging environment **preprod**.",
                    },
                  ],
                  baseVersion: 1,
                  changeNote: "The team told me staging is called preprod",
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                name: "complete",
                input: {
                  summary:
                    "Noted in my instructions: staging is called preprod here.",
                },
              },
            ],
          },
        ],
      },
    ],
  },
  {
    bot: "Ada",
    title: "Refund for Globex",
    turns: [
      {
        text: "Globex was charged twice for October. Can we refund one of the charges?",
        responses: [
          {
            reasoning:
              "Look for what this conversation already knows about Globex's billing before answering.",
            toolCalls: [{ name: "search_history", input: { query: "Globex" } }],
          },
          {
            toolCalls: [
              {
                name: "reply_and_wait",
                input: {
                  text: "Nothing earlier here mentions Globex's October invoices. I can't promise a refund — **a person on the billing team confirms it** — but I've written down the duplicate charge so they can check it.\n\nIs there an invoice number I should add?",
                },
              },
            ],
          },
        ],
      },
      {
        text: "It's INV-2291. That's all, thanks.",
        responses: [
          {
            toolCalls: [
              {
                name: "memory_write",
                input: {
                  scope: "channel",
                  path: "customers/globex.md",
                  description: "Globex's billing history and open questions",
                  content:
                    "# Globex\n\n- Charged twice for October; the duplicate is **INV-2291**.\n- A refund needs the billing team's confirmation; it has been flagged to them.",
                  changeNote: "Globex reported a duplicate October charge",
                },
              },
            ],
          },
          {
            toolCalls: [
              {
                name: "complete",
                input: {
                  summary:
                    "Flagged Globex's duplicate October charge (INV-2291) for the billing team to confirm.",
                },
              },
            ],
          },
        ],
      },
    ],
  },
  {
    bot: "Ada",
    title: HELP_TITLE,
    turns: [
      {
        text: "Initech asks us to waive their $40 late fee. Can we?",
        responses: [
          {
            toolCalls: [
              {
                name: "escalate_to_human",
                input: {
                  question:
                    "May I waive Initech's $40 late fee on INV-2304? Their payment was late because our card processor was down.",
                  context:
                    "INV-2304 failed on 3 March during the processor outage and was paid on 5 March. Nothing in memory says who may waive fees.",
                  urgency: "high",
                },
              },
            ],
          },
        ],
      },
    ],
  },
  {
    bot: "Ada",
    title: CHAT_TITLE,
    channelType: "web",
    turns: [
      {
        text: "How long does a refund to Globex take?",
        responses: [
          {
            toolCalls: [
              { name: "memory_search", input: { query: "Globex refund" } },
            ],
          },
          {
            toolCalls: [
              {
                name: "reply_and_wait",
                input: {
                  text: "Refunds reach Globex in **five business days** once billing confirms them. Want me to email their billing team?",
                },
              },
            ],
          },
        ],
      },
      {
        text: "Yes, please.",
        responses: [
          {
            toolCalls: [
              {
                name: "ask_question",
                input: {
                  question: "Which of Globex's billing teams should I email?",
                  options: ["EU billing", "US billing"],
                },
              },
            ],
          },
        ],
      },
      {
        text: "EU billing",
        responses: [
          {
            toolCalls: [
              { name: "mcp_info", input: { name: "mail/send_email" } },
            ],
          },
          {
            toolCalls: [
              {
                name: "mcp_exec",
                input: {
                  name: "mail/send_email",
                  args: {
                    to: "billing-eu@globex.example",
                    subject: "Your refund for INV-2291",
                  },
                },
              },
            ],
          },
        ],
      },
    ],
  },
];

/**
 * Wait until a conversation stops working (or, with `untilWorking`, starts).
 * @param request - The browser context's request client.
 * @param base - The conversation's route.
 * @param untilWorking - Wait for `working` rather than for it to end.
 * @returns The conversation's state.
 */
async function settle(
  request: APIRequestContext,
  base: string,
  untilWorking = false,
): Promise<string> {
  for (let i = 0; i < 200; i++) {
    const { conversation } = await call<{ conversation: { state: string } }>(
      request,
      "GET",
      base,
    );
    if (
      untilWorking
        ? conversation.state === "working"
        : conversation.state !== "working"
    )
      return conversation.state;
    await Bun.sleep(100);
  }
  throw new Error(`${base} never settled; is a queue worker running?`);
}

/** How long the scripted model must take no request before a turn counts as finished. */
const QUIET_MS = Number(process.env.ILLUSTRATIONS_QUIET_MS ?? 6000);

/**
 * Wait until the scripted model has taken no request for {@link QUIET_MS}.
 * A conversation that comes to rest has its memory consolidated by its bot's
 * `fast` model, a moment later on the queue; queueing the next turn's
 * answers before that ran would hand one of them to the consolidation.
 * @returns Resolves once the model is quiet.
 */
async function quiet(): Promise<void> {
  let last = -1;
  let since = Date.now();
  for (;;) {
    const { completions } = await model<{ completions: number }>(
      "GET",
      "/state",
    );
    if (completions !== last) {
      last = completions;
      since = Date.now();
    } else if (Date.now() - since >= QUIET_MS) return;
    await Bun.sleep(250);
  }
}

/**
 * Give the Support project the conversations the conversation illustrations
 * show, each made only when missing. While any are made, the Anthropic
 * connection points at the scripted model; it is put back after.
 * @param request - The browser context's request client.
 * @param projectId - The Support project.
 * @returns The id of the conversation the transcript illustration opens.
 */
async function seedConversations(
  request: APIRequestContext,
  projectId: number,
): Promise<number> {
  const listed = async () =>
    (
      await call<{ conversations: { id: number; title: string | null }[] }>(
        request,
        "GET",
        `/project/${projectId}/conversations?limit=100`,
      )
    ).conversations;
  let existing = await listed();
  const missing = CONVERSATIONS.filter(
    (c) => !existing.some((e) => e.title === c.title),
  );
  if (missing.length > 0) {
    const { bots } = await call<{ bots: { id: number; name: string }[] }>(
      request,
      "GET",
      `/project/${projectId}/bots?limit=100`,
    );
    const { modelConnections } = await call<{
      modelConnections: { id: number; name: string }[];
    }>(request, "GET", `/project/${projectId}/model-connections?limit=100`);
    const connection = modelConnections.find((c) => c.name === "Anthropic");
    if (!connection) throw new Error("the Anthropic connection is missing");
    const connectionPath = `/project/${projectId}/model-connection/${connection.id}`;
    const scripted = await model<{ baseUrl: string; apiKey: string }>(
      "GET",
      "/connection?provider=anthropic",
    );
    const pointed = await call(request, "POST", connectionPath, scripted);
    if (pointed.error) {
      throw new Error(
        `pointing the connection at the scripted model: ${pointed.error.message} (start the backend with NETWORK_ALLOW_PRIVATE_HOSTS=true)`,
      );
    }
    try {
      for (const plan of missing) {
        const bot = bots.find((b) => b.name === plan.bot);
        if (!bot) throw new Error(`the ${plan.bot} bot is missing`);
        let base = "";
        for (const [i, turn] of plan.turns.entries()) {
          await quiet();
          await model("POST", "/reset");
          await model("POST", "/play", { responses: turn.responses });
          if (i === 0) {
            const created = await call<{ conversation: { id: number } }>(
              request,
              "PUT",
              `/project/${projectId}/bot/${bot.id}/conversation`,
              {
                text: turn.text,
                title: plan.title,
                ...(plan.channelType ? { channelType: plan.channelType } : {}),
              },
            );
            if (created.error)
              throw new Error(`conversation: ${created.error.message}`);
            base = `/project/${projectId}/conversation/${created.conversation.id}`;
          } else {
            await call(request, "PUT", `${base}/message`, { text: turn.text });
          }
          if (turn.cancel) {
            await settle(request, base, true);
            await call(request, "POST", `${base}/cancel`);
            await settle(request, base);
            await model("POST", "/release");
          } else {
            await settle(request, base);
          }
        }
      }
    } finally {
      await quiet();
      await call(request, "POST", connectionPath, {
        baseUrl: null,
        apiKey: "sk-ant-illustration-placeholder-a1f3",
      });
    }
    existing = await listed();
  }
  const shown = existing.find((e) => e.title === "Refund for Globex");
  if (!shown) throw new Error("the Refund for Globex conversation is missing");
  return shown.id;
}

/** Where the MCP fixtures' control server listens. */
const MCP_CONTROL = `http://127.0.0.1:${process.env.MCP_SERVER_CONTROL_PORT ?? "9184"}`;

/** The MCP fixtures this script started, if it had to. */
let mcpProcess: Subprocess | null = null;

/**
 * The MCP fixtures' addresses, starting them first if nothing answers.
 * @returns The open (mailbox) server's and the OAuth server's MCP endpoints.
 */
async function mcpFixtureUrls(): Promise<{ url: string; oauthUrl: string }> {
  const read = async () =>
    (await (await fetch(`${MCP_CONTROL}/urls`)).json()) as {
      url: string;
      oauthUrl: string;
    };
  try {
    return await read();
  } catch {
    // Not running; start it below.
  }
  mcpProcess = Bun.spawn(["bun", "__tests__/fixtures/mcp-server-process.ts"], {
    cwd: join(import.meta.dirname, "../../backend"),
    env: {
      ...process.env,
      MCP_SERVER_CONTROL_PORT: new URL(MCP_CONTROL).port,
      MCP_FIXTURE_TOOLSET: "illustration",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  for (let i = 0; i < 50; i++) {
    await Bun.sleep(100);
    try {
      return await read();
    } catch {
      // Not listening yet.
    }
  }
  throw new Error(`the MCP fixtures never answered at ${MCP_CONTROL}`);
}

/** The Support project's MCP servers: a mailbox, and a calendar nobody signed in to yet. */
const MCP_SERVERS = [
  { name: "mail", authMode: "none", oauth: false },
  { name: "calendar", authMode: "oauth", oauth: true },
] as const;

/**
 * Give the Support project what the MCP illustrations show: the mailbox and
 * an OAuth calendar waiting for its sign-in, each pointed at where the
 * fixtures listen now; the mailbox given to Ada with its two reads
 * allowlisted; and Ada's approvals decided by the billing tag, waiting thirty
 * days.
 * @param request - The browser context's request client.
 * @param projectId - The Support project.
 * @param botId - Ada.
 * @returns The mailbox's id.
 */
async function seedMcp(
  request: APIRequestContext,
  projectId: number,
  botId: number,
): Promise<number> {
  const urls = await mcpFixtureUrls();
  const listed = await call<{
    mcpServers: { id: number; name: string; url: string }[];
  }>(request, "GET", `/project/${projectId}/mcp-servers?limit=100`);
  const ids: Record<string, number> = {};
  for (const plan of MCP_SERVERS) {
    const url = plan.oauth ? urls.oauthUrl : urls.url;
    const found = listed.mcpServers.find((s) => s.name === plan.name);
    if (!found) {
      const created = await call<{ mcpServer: { id: number } }>(
        request,
        "PUT",
        `/project/${projectId}/mcp-server`,
        { name: plan.name, url, authMode: plan.authMode },
      );
      if (created.error)
        throw new Error(
          `mcp server: ${created.error.message} (start the backend with NETWORK_ALLOW_PRIVATE_HOSTS=true)`,
        );
      ids[plan.name] = created.mcpServer.id;
    } else {
      ids[plan.name] = found.id;
      if (found.url !== url) {
        const path = `/project/${projectId}/mcp-server/${found.id}`;
        await call(request, "POST", path, { url });
        if (!plan.oauth) await call(request, "POST", `${path}/refresh`);
      }
    }
  }
  const mail = ids.mail;
  if (mail === undefined) throw new Error("the mail server is missing");
  const bound = await call(
    request,
    "PUT",
    `/project/${projectId}/bot/${botId}/mcp-server`,
    {
      mcpServerId: mail,
      allowedTools: ["mail/read_inbox", "mail/search_messages"],
      autoAllowReadOnly: false,
    },
  );
  if (bound.error) throw new Error(`bot mcp server: ${bound.error.message}`);
  await call(request, "POST", `/project/${projectId}/bot/${botId}`, {
    approverTag: "billing",
    approvalTtlSeconds: 30 * 24 * 60 * 60,
  });
  return mail;
}

/** One memory document the memory illustrations show, written by Ada Lovelace. */
interface SeededMemory {
  path: string;
  description: string;
  /** Each version in turn, oldest first, with why it changed. */
  versions: { content: string; changeNote: string }[];
  pinned?: boolean;
}

/** The project's shared memory. */
const PROJECT_MEMORY: SeededMemory[] = [
  {
    path: "facts/deploy-process.md",
    description: "When and how the platform team deploys",
    versions: [
      {
        content:
          "# Deploy process\n\n- Deploys go out on **Tuesdays** after the 10:00 standup.\n- The on-call engineer runs them; ask in #platform first.",
        changeNote: "Written from the platform handbook",
      },
      {
        content:
          "# Deploy process\n\n- Deploys go out on **Thursdays** after the 10:00 standup.\n- The on-call engineer runs them; ask in #platform first.\n- A deploy that touches billing waits for the billing team's sign-off.",
        changeNote: "Deploys moved to Thursdays; billing sign-off added",
      },
    ],
  },
  {
    path: "policies/refunds.md",
    description: "Who may promise a refund, and how",
    pinned: true,
    versions: [
      {
        content:
          "# Refunds\n\nNever promise a refund. A person on the billing team confirms every one; flag the invoice number to them.",
        changeNote: "The refund policy",
      },
    ],
  },
  {
    path: "people/billing-team.md",
    description: "Who is on the billing team",
    versions: [
      {
        content:
          "# Billing team\n\n- **Dana Reyes** leads it, and signs off refunds over $500.\n- **Sam Ortiz** handles invoices and duplicate charges.",
        changeNote: "The team as of this quarter",
      },
    ],
  },
];

/** Ada's memory of her API channel, besides what she wrote herself. */
const CHANNEL_MEMORY: SeededMemory[] = [
  {
    path: "customers/initech.md",
    description: "Initech's CSV export failures",
    versions: [
      {
        content:
          "# Initech\n\n- Their CSV export has failed since Monday.\n- The platform team reruns exports; Ada cannot reach the export service.",
        changeNote: "Initech reported failing exports",
      },
    ],
  },
];

/**
 * Write a seeded document's versions, and pin it, when it is not there yet.
 * @param request - The browser context's request client.
 * @param base - `memory:write`'s route.
 * @param where - The scope, and the bot and channel for a channel's memory.
 * @param doc - The document.
 * @returns Resolves when it is written.
 */
async function writeMemory(
  request: APIRequestContext,
  base: string,
  where: Record<string, unknown>,
  doc: SeededMemory,
): Promise<void> {
  for (const version of doc.versions) {
    const written = await call(request, "PUT", base, {
      ...where,
      path: doc.path,
      description: doc.description,
      ...version,
    });
    if (written.error) throw new Error(`memory: ${written.error.message}`);
  }
  if (doc.pinned) {
    await call(request, "POST", `${base}/pin`, {
      ...where,
      path: doc.path,
      pinned: true,
    });
  }
}

/**
 * Give the Support project the memory the memory illustrations show: three
 * project documents (one with two versions, one pinned), and Ada's memory of
 * her API channel — `customers/globex.md`, which she wrote herself in the
 * Globex conversation, gains a second version from a person, so its page has
 * a history and a diff. Each is written only when missing.
 * @param request - The browser context's request client.
 * @param projectId - The Support project.
 * @param botId - Ada.
 * @returns The channel the channel illustrations open.
 */
async function seedMemory(
  request: APIRequestContext,
  projectId: number,
  botId: number,
): Promise<number> {
  const base = `/project/${projectId}/memory/document`;
  const listed = async (query: string) =>
    (
      await call<{ documents: { path: string }[] }>(
        request,
        "GET",
        `/project/${projectId}/memory?${query}&limit=100`,
      )
    ).documents.map((d) => d.path);

  const project = await listed("scope=project");
  for (const doc of PROJECT_MEMORY) {
    if (!project.includes(doc.path))
      await writeMemory(request, base, { scope: "project" }, doc);
  }

  const { channels } = await call<{ channels: { id: number; name: string }[] }>(
    request,
    "GET",
    `/project/${projectId}/bot/${botId}/memory/channels?limit=100`,
  );
  const channel = channels[0];
  if (!channel) throw new Error("Ada has no channel to remember");
  const where = { scope: "channel", botId, channelId: channel.id };
  const remembered = await listed(
    `scope=channel&botId=${botId}&channelId=${channel.id}`,
  );
  for (const doc of CHANNEL_MEMORY) {
    if (!remembered.includes(doc.path))
      await writeMemory(request, base, where, doc);
  }
  // Ada wrote Globex's first version in the conversation; a person adds to it.
  const globex = await call<{
    document: { versionId: number; content: string };
  }>(
    request,
    "GET",
    `${base}?scope=channel&botId=${botId}&channelId=${channel.id}&path=customers/globex.md`,
  );
  const first =
    "# Globex\n\n- Charged twice for October; the duplicate is **INV-2291**.\n- A refund needs the billing team's confirmation; it has been flagged to them.";
  if (globex.error || globex.document.content === first) {
    await call(request, "PUT", base, {
      ...where,
      path: "customers/globex.md",
      description: "Globex's billing history and open questions",
      content: `${first}\n- Their billing contact is **Priya Shah**, priya@globex.example.`,
      changeNote: "Added Globex's billing contact",
      ...(globex.error ? {} : { baseVersionId: globex.document.versionId }),
    });
  }
  return channel.id;
}
/** One version of a seeded section's text, with why it changed. */
interface SeededText {
  body: string;
  changeNote: string;
}

/** The versions people wrote of Ada's *How I work*, oldest first. */
const HOW_ADA_WORKS: SeededText[] = [
  {
    body: "- Look in this channel's memory before asking anyone.\n- Keep replies to a short paragraph; link rather than paste.",
    changeNote: "How Ada answers",
  },
  {
    body: "- Look in this channel's memory before asking anyone.\n- Keep replies to a short paragraph; link rather than paste.\n- Name an invoice by its number, never by its date.",
    changeNote: "Invoices by number",
  },
];

/** Sections of the Support project: Ada's own, and every bot's. */
const SECTIONS: {
  title: string;
  body: string;
  loading: "always" | "contextual";
  keywords?: string[];
  agentEditable?: boolean;
  /** Every bot's, when true; Ada's, otherwise. */
  project?: boolean;
}[] = [
  {
    title: "Refunds",
    body: "A refund needs the billing team's confirmation. Flag the invoice number to them in #billing, and tell the customer a person will confirm it.",
    loading: "contextual",
    keywords: ["refund", "refunds", "credit", "chargeback"],
  },
  {
    title: "House style",
    body: "Write in plain words. Never promise a date or a refund; say who will confirm it.",
    loading: "always",
    project: true,
  },
  {
    title: "Glossary",
    body: "- **preprod** — the staging environment.\n- **INV-** — an invoice number.",
    loading: "contextual",
    keywords: ["preprod", "staging", "invoice"],
    project: true,
  },
];

/** Ada's goals. */
const GOALS = [
  {
    title: "Answer every billing question the same day",
    description:
      "A question asked before 17:00 gets an answer, or a named person who will answer, that day.",
    priority: "high",
    reviewEverySeconds: 7 * 86_400,
    notes: "On track this week: 14 of 15 answered the same day.",
  },
  {
    title: "Keep the refund policy page current",
    priority: "medium",
    reviewEverySeconds: 30 * 86_400,
    notes: "",
  },
  {
    title: "Move the October invoices to the new template",
    priority: "low",
    status: "achieved",
    reviewEverySeconds: null,
    notes: "Done; the template went out with INV-2300.",
  },
];

/** The Support project's skills; each later body is a new version. */
const SKILLS = [
  {
    name: "release-notes",
    description: "Drafts customer-facing release notes for a version",
    arguments: [
      {
        name: "version",
        description: "The version, such as 2.4",
        required: true,
      },
      { name: "audience", required: false, default: "customers" },
    ],
    bodies: [
      "Draft release notes for $version, for $audience.\n\nOne line per change.",
      "Draft release notes for $version, for $audience.\n\nOne line per change, newest first. Link each change's pull request, and leave out anything internal.",
    ],
    /** Ada's pin: `null` follows the latest. */
    pinned: 1 as number | null,
  },
  {
    name: "standup-summary",
    description: "Summarizes yesterday's conversations for the morning standup",
    arguments: [],
    bodies: [
      "Summarize the conversations in this channel since yesterday's standup: what was answered, what is waiting on whom, and anything to raise.",
    ],
    pinned: null as number | null,
  },
];

/**
 * Give the Support project what the prompt, goal, and skill illustrations
 * show, each made only when missing: two versions of Ada's *How I work* by
 * a person (her *Things I have learned* is written by Ada herself, in a
 * seeded conversation), a contextual section of hers, two sections every bot
 * includes, her goals, and two skills — one edited, so it has two versions —
 * attached to her, one pinned to its first version.
 * @param request - The browser context's request client.
 * @param projectId - The Support project.
 * @param botId - Ada.
 */
async function seedPrompt(
  request: APIRequestContext,
  projectId: number,
  botId: number,
): Promise<void> {
  const base = `/project/${projectId}`;
  const sectionsOf = async (botQuery: string) =>
    (
      await call<{
        promptSections: {
          id: number;
          key: string;
          title: string;
          currentVersion: number;
        }[];
      }>(request, "GET", `${base}/prompt-sections?${botQuery}limit=100`)
    ).promptSections;

  const own = await sectionsOf(`botId=${botId}&`);
  const howIWork = own.find((s) => s.key === "how-i-work");
  if (!howIWork) throw new Error("Ada's How I work section is missing");
  for (const [i, text] of HOW_ADA_WORKS.entries()) {
    // Version 1 is the empty seed; each text here is the version after it.
    if (howIWork.currentVersion > i + 1) continue;
    const edited = await call(
      request,
      "POST",
      `${base}/prompt-section/${howIWork.id}`,
      text,
    );
    if (edited.error) throw new Error(`section: ${edited.error.message}`);
  }

  const shared = await sectionsOf("");
  for (const plan of SECTIONS) {
    const existing = plan.project ? shared : own;
    if (existing.some((s) => s.title === plan.title)) continue;
    const created = await call(request, "PUT", `${base}/prompt-section`, {
      ...(plan.project ? {} : { botId }),
      title: plan.title,
      body: plan.body,
      loading: plan.loading,
      keywords: plan.keywords ?? [],
      ...(plan.project ? {} : { agentEditable: plan.agentEditable ?? false }),
    });
    if (created.error) throw new Error(`section: ${created.error.message}`);
  }

  const { goals } = await call<{ goals: { title: string }[] }>(
    request,
    "GET",
    `${base}/bot/${botId}/goals?limit=100`,
  );
  for (const [i, goal] of GOALS.entries()) {
    if (goals.some((g) => g.title === goal.title)) continue;
    const created = await call(request, "PUT", `${base}/bot/${botId}/goal`, {
      ...goal,
      position: i,
    });
    if (created.error) throw new Error(`goal: ${created.error.message}`);
  }

  const { skills } = await call<{
    skills: { id: number; name: string; currentVersion: number }[];
  }>(request, "GET", `${base}/skills?limit=100`);
  for (const plan of SKILLS) {
    let skill = skills.find((s) => s.name === plan.name);
    if (!skill) {
      const created = await call<{
        skill: { id: number; name: string; currentVersion: number };
      }>(request, "PUT", `${base}/skill`, {
        name: plan.name,
        description: plan.description,
        arguments: plan.arguments,
        body: plan.bodies[0],
      });
      if (created.error) throw new Error(`skill: ${created.error.message}`);
      skill = created.skill;
    }
    for (let v = skill.currentVersion; v < plan.bodies.length; v++) {
      await call(request, "POST", `${base}/skill/${skill.id}`, {
        body: plan.bodies[v],
        changeNote: "Newest first, with links",
      });
    }
    const attached = await call(request, "PUT", `${base}/bot/${botId}/skill`, {
      skillId: skill.id,
      pinnedVersion: plan.pinned,
    });
    if (attached.error) throw new Error(`bot skill: ${attached.error.message}`);
  }
}

/**
 * Give Ada what the Slack illustration shows: an app created by hand from the
 * manifest, its credentials connected, waiting to be installed. Nothing here
 * calls Slack — installing would — so the picture needs no workspace. Made
 * only when Ada has no Slack app yet.
 * @param request - The browser context's request client.
 * @param projectId - The Support project.
 * @param botId - Ada.
 */
async function seedSlack(
  request: APIRequestContext,
  projectId: number,
  botId: number,
): Promise<void> {
  const { installations } = await call<{
    installations: { type: string; status: string }[];
  }>(request, "GET", `/project/${projectId}/bot/${botId}/installations`);
  if (installations.some((i) => i.type === "slack")) return;
  const manifest = await call(
    request,
    "POST",
    `/project/${projectId}/bot/${botId}/installation/slack/manifest`,
  );
  if (manifest.error)
    throw new Error(`slack manifest: ${manifest.error.message}`);
  const connected = await call(
    request,
    "PUT",
    `/project/${projectId}/bot/${botId}/installation`,
    {
      type: "slack",
      config: { clientId: "1234567890.0987654321", appId: "A0ADALOVELACE" },
      credentials: {
        clientSecret: "illustration-client-secret",
        signingSecret: "illustration-signing-secret",
      },
    },
  );
  if (connected.error)
    throw new Error(`slack connect: ${connected.error.message}`);
}

/**
 * Give Ada what the Linear illustration shows: an app created in Linear from
 * the creation link, its credentials connected, waiting to be installed.
 * Nothing here calls Linear — installing would — so the picture needs no
 * workspace. Made only when Ada has no Linear app yet.
 * @param request - The browser context's request client.
 * @param projectId - The Support project.
 * @param botId - Ada.
 */
async function seedLinear(
  request: APIRequestContext,
  projectId: number,
  botId: number,
): Promise<void> {
  const { installations } = await call<{
    installations: { type: string; status: string }[];
  }>(request, "GET", `/project/${projectId}/bot/${botId}/installations`);
  if (installations.some((i) => i.type === "linear")) return;
  const manifest = await call(
    request,
    "POST",
    `/project/${projectId}/bot/${botId}/installation/linear/manifest`,
  );
  if (manifest.error)
    throw new Error(`linear manifest: ${manifest.error.message}`);
  const connected = await call(
    request,
    "PUT",
    `/project/${projectId}/bot/${botId}/installation`,
    {
      type: "linear",
      config: { clientId: "ada-lovelace-linear-client-0000" },
      credentials: {
        clientSecret: "illustration-client-secret",
        webhookSecret: "illustration-webhook-secret",
      },
    },
  );
  if (connected.error)
    throw new Error(`linear connect: ${connected.error.message}`);
}

/** The webhook app's delivery address: never called, since nobody mentions Ada in these channels. */
const WEBHOOK_DELIVERY_URL = "https://hooks.acme.example/hypotenuse";

/** The webhook app's signing secret. Not a secret: it opens nothing real. */
const WEBHOOK_SECRET = "illustration-signing-secret-0000";

/** The channels the webhook app delivers a message from, which the Channels illustration lists. */
const WEBHOOK_CHANNELS = [
  { id: "C-support", name: "support" },
  { id: "C-escalations", name: "escalations" },
  { id: "C-billing-leads", name: "billing-leads", private: true },
];

/**
 * Give Ada what the Channels illustration shows: a connected webhook app, and
 * a message from each of three channels, delivered signed to its events URL
 * as the platform would. Nobody mentions Ada, so no conversation starts: the
 * two public channels bind themselves, the private one waits to be bound,
 * and one binding lets anyone in the channel decide approvals. Made only
 * when Ada has no connected app.
 * @param request - The browser context's request client.
 * @param projectId - The Support project.
 * @param botId - Ada.
 */
async function seedChannels(
  request: APIRequestContext,
  projectId: number,
  botId: number,
): Promise<void> {
  const { installations } = await call<{
    installations: { type: string; status: string }[];
  }>(request, "GET", `/project/${projectId}/bot/${botId}/installations`);
  if (installations.some((i) => i.type === "webhook" && i.status === "active"))
    return;
  const manifest = await call<{ urls: { events: string } }>(
    request,
    "POST",
    `/project/${projectId}/bot/${botId}/installation/webhook/manifest`,
  );
  if (manifest.error) throw new Error(`manifest: ${manifest.error.message}`);
  const connected = await call(
    request,
    "PUT",
    `/project/${projectId}/bot/${botId}/installation`,
    {
      type: "webhook",
      config: { deliveryUrl: WEBHOOK_DELIVERY_URL },
      credentials: { signingSecret: WEBHOOK_SECRET },
      botUserId: "U-ada",
    },
  );
  if (connected.error) throw new Error(`connect: ${connected.error.message}`);
  for (const [i, channel] of WEBHOOK_CHANNELS.entries()) {
    const body = JSON.stringify({
      messageId: `illustration-${channel.id}`,
      channel,
      conversation: `thread-${i}`,
      sender: { id: `U-${i}`, name: ["Grace", "Alan", "Edsger"][i] },
      text: "Morning, all.",
    });
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac("sha256", WEBHOOK_SECRET)
      .update(`${t}.${body}`)
      .digest("hex");
    const res = await fetch(manifest.urls.events, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "hypotenuse-signature": `t=${t},v1=${v1}`,
      },
      body,
    });
    if (!res.ok) throw new Error(`webhook delivery: ${res.status}`);
  }
  // Processing is queued: wait for the channels to arrive.
  for (let i = 0; i < 100; i++) {
    const { channels } = await call<{
      channels: { name: string; binding: { id: number } | null }[];
    }>(request, "GET", `/project/${projectId}/channels?botId=${botId}`);
    const escalations = channels.find((c) => c.name === "escalations");
    if (channels.length >= WEBHOOK_CHANNELS.length && escalations?.binding) {
      await call(
        request,
        "POST",
        `/project/${projectId}/channel-binding/${escalations.binding.id}`,
        { approvalPolicy: "participants", mode: "all" },
      );
      return;
    }
    await Bun.sleep(100);
  }
  throw new Error(
    "the webhook channels never arrived; is a queue worker running?",
  );
}

const OUT = join(
  import.meta.dirname,
  "..",
  "public",
  "doc-assets",
  "illustrations",
);

/**
 * Capture each illustration in both themes.
 * @returns Resolves when every PNG is written.
 */
async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  );
  try {
    for (const theme of ["light", "dark"] as const) {
      const context = await browser.newContext({
        colorScheme: theme,
        deviceScaleFactor: 2,
      });
      // The stored preference is what the boot script reads before first paint.
      await context.addInitScript(
        (value) => localStorage.setItem("hypotenuse.theme", value),
        theme,
      );
      const page = await context.newPage();
      let seeded: Seeded | null = null;
      for (const shot of ILLUSTRATIONS.filter(
        (s) => !ONLY || ONLY.includes(s.name),
      )) {
        if (shot.signedIn && !seeded) {
          seeded = await seed(context.request);
          // Support is the project every signed-in shot shows.
          await context.addInitScript(
            ([organizationId, projectId]) => {
              localStorage.setItem(
                "hypotenuse.activeOrganizationId",
                organizationId,
              );
              localStorage.setItem("hypotenuse.activeProjectId", projectId);
            },
            [String(seeded.organizationId), String(seeded.projectId)],
          );
        }
        const path =
          typeof shot.path === "string"
            ? shot.path
            : seeded
              ? shot.path(seeded)
              : null;
        if (path === null) throw new Error(`${shot.name} needs signedIn`);
        await page.setViewportSize({
          width: shot.width ?? 1280,
          height: shot.height ?? 800,
        });
        await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
        // The seeded person's address is never confirmed (the development
        // backend's mail goes to its log), and the banner saying so is about
        // them, not about the page an illustration shows.
        await page.addStyleTag({
          content:
            ".shell-banner:has([data-testid=verify-email-banner]) { display: none; }",
        });
        for (const selector of shot.open ?? []) {
          await page.locator(selector).click();
          await page.waitForLoadState("networkidle");
        }
        await page.evaluate(() => document.fonts.ready);
        const file = join(OUT, `${shot.name}-${theme}.png`);
        if (shot.selector)
          await page
            .locator(shot.selector.replace("{theme}", theme))
            .screenshot({ path: file });
        else await page.screenshot({ path: file });
        console.log(`wrote ${file}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
    modelProcess?.kill();
    mcpProcess?.kill();
  }
}

await main();
