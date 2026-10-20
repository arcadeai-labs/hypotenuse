/**
 * Capture every docs illustration twice — light and dark — into
 * `public/docs/illustrations/<name>-{light,dark}.png`, which `ThemedImage`
 * serves as a `<picture>` pair.
 *
 * Needs the frontend running (`bun dev`, or `FRONTEND_URL`). Pages that need a
 * signed-in, seeded app will add their own setup here as they arrive.
 *
 *   cd frontend && bun run docs:illustrations
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";

/** One illustration: a route, and optionally the element to crop to (`{theme}` is replaced). */
interface Illustration {
  name: string;
  path: string;
  selector?: string;
  width?: number;
  height?: number;
}

/** Every illustration the docs embed. Add a row, rerun, commit the PNGs. */
export const ILLUSTRATIONS: Illustration[] = [
  { name: "home", path: "/", width: 1280, height: 800 },
  { name: "style-guide", path: "/style-guide", selector: "[data-testid=style-guide-{theme}]", width: 1440, height: 900 },
];

const BASE = process.env.FRONTEND_URL ?? "http://localhost:3000";
const OUT = join(import.meta.dir, "..", "public", "docs", "illustrations");

/**
 * Capture each illustration in both themes.
 * @returns Resolves when every PNG is written.
 */
async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH } : {},
  );
  try {
    for (const theme of ["light", "dark"] as const) {
      const context = await browser.newContext({ colorScheme: theme, deviceScaleFactor: 2 });
      // The stored preference is what the boot script reads before first paint.
      await context.addInitScript((value) => localStorage.setItem("hypotenuse.theme", value), theme);
      const page = await context.newPage();
      for (const shot of ILLUSTRATIONS) {
        await page.setViewportSize({ width: shot.width ?? 1280, height: shot.height ?? 800 });
        await page.goto(`${BASE}${shot.path}`, { waitUntil: "networkidle" });
        await page.evaluate(() => document.fonts.ready);
        const file = join(OUT, `${shot.name}-${theme}.png`);
        if (shot.selector) await page.locator(shot.selector.replace("{theme}", theme)).screenshot({ path: file });
        else await page.screenshot({ path: file });
        console.log(`wrote ${file}`);
      }
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

if (import.meta.main) await main();
