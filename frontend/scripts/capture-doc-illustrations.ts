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
 * made, and is put back after.
 *
 *   cd frontend && bun run docs:illustrations
 */
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
    height: 2200,
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
    name: "style-guide",
    path: "/docs/style-guide",
    selector: "[data-testid=style-guide-{theme}]",
    width: 1440,
    height: 900,
  },
];

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
  return {
    organizationId: organization.id,
    projectId: support.id,
    botId: await seedBots(request, support.id),
    conversationId: await seedConversations(request, support.id),
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

/** The conversations the conversation illustrations show, oldest first. */
const CONVERSATIONS: { bot: string; title: string; turns: Turn[] }[] = [
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
          await model("POST", "/reset");
          await model("POST", "/play", { responses: turn.responses });
          if (i === 0) {
            const created = await call<{ conversation: { id: number } }>(
              request,
              "PUT",
              `/project/${projectId}/bot/${bot.id}/conversation`,
              { text: turn.text, title: plan.title },
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
      for (const shot of ILLUSTRATIONS) {
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
  }
}

await main();
