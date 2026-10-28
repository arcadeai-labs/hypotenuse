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

/** One illustration: a route, and optionally the element to crop to (`{theme}` is replaced). */
interface Illustration {
  name: string;
  path: string;
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

/**
 * Sign the seeded person in on a context, creating them and their tenant the
 * first time: sign-up's organization renamed Acme, its Default project renamed
 * Support, and a second project, Platform.
 * @param request - The browser context's request client.
 * @throws {Error} When the API refuses a step.
 */
async function seed(request: APIRequestContext): Promise<void> {
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
      let signedIn = false;
      for (const shot of ILLUSTRATIONS) {
        if (shot.signedIn && !signedIn) {
          await seed(context.request);
          signedIn = true;
        }
        await page.setViewportSize({
          width: shot.width ?? 1280,
          height: shot.height ?? 800,
        });
        await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle" });
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
