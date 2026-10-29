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
 *   cd frontend && bun run docs:illustrations
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, chromium } from "@playwright/test";

/** What {@link seed} made, for a route that names a row by its id. */
interface Seeded {
  organizationId: number;
  projectId: number;
  botId: number;
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
    height: 2000,
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
  };
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
  }
}

await main();
