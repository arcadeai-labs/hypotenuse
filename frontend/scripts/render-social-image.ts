/**
 * Render the social card — the picture a link to the site unfurls with in
 * Slack, LinkedIn, X, iMessage, and the rest — into `public/social.png`, which
 * `index.html`'s `og:image` and `twitter:image` name.
 *
 * Painted from the generated dark theme (`design/tokens.json`) and dark mark
 * (`public/favicon-dark.svg`) that `design/tokens.ts` writes, set
 * in the self-hosted Inter, so a change to the tokens' inputs changes the card on
 * the next run. One image, dark: an unfurl sits on whatever theme the reader's
 * client has, and the dark card holds its edge on both. It is a screenshot, not a
 * byte-reproducible output, so `theme:check` does not watch it — rerun this after
 * changing the inputs or the copy, look at the PNG, and commit it.
 *
 *   cd frontend && bun run social:image
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium } from "@playwright/test";

/** The card's CSS size; the PNG is twice this, for high-density screens. */
export const SOCIAL_IMAGE_WIDTH = 1200;
export const SOCIAL_IMAGE_HEIGHT = 630;
const SCALE = 2;

const PUBLIC = join(import.meta.dirname, "..", "public");
const OUT = join(PUBLIC, "social.png");
const require = createRequire(import.meta.url);

/**
 * A font file from an installed `@fontsource-variable` package, as a data URL,
 * so the page needs no server and no network.
 * @param pkg - The package name.
 * @param file - The file under the package's `files/`.
 * @returns A `data:font/woff2` URL.
 */
function fontDataUrl(pkg: string, file: string): string {
  const dir = dirname(require.resolve(`${pkg}/LICENSE`));
  const bytes = readFileSync(join(dir, "files", file));
  return `data:font/woff2;base64,${bytes.toString("base64")}`;
}

/**
 * The card's HTML: the mark and wordmark, the home page's headline and lede, and
 * the home page's triangle — where your team talks at the top right, the work
 * done at the bottom left, Hypotenuse the line between them.
 * @returns A complete HTML document.
 */
export function renderSocialCard(): string {
  const t: Record<string, string> = JSON.parse(
    readFileSync(
      join(import.meta.dirname, "..", "..", "design", "tokens.json"),
      "utf8",
    ),
  ).dark;
  const mark = readFileSync(join(PUBLIC, "favicon-dark.svg"), "utf8");
  const inter = fontDataUrl(
    "@fontsource-variable/inter",
    "inter-latin-opsz-normal.woff2",
  );
  const mono = fontDataUrl(
    "@fontsource-variable/jetbrains-mono",
    "jetbrains-mono-latin-wght-normal.woff2",
  );
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
@font-face { font-family: "Inter Variable"; src: url(${inter}) format("woff2"); font-weight: 100 900; }
@font-face { font-family: "JetBrains Mono Variable"; src: url(${mono}) format("woff2"); font-weight: 100 800; }
* { box-sizing: border-box; margin: 0; }
html, body { width: ${SOCIAL_IMAGE_WIDTH}px; height: ${SOCIAL_IMAGE_HEIGHT}px; overflow: hidden; }
body {
  background: radial-gradient(ellipse 70% 90% at 100% 0%, ${t["accent-subtle"]}, ${t["bg-app"]} 70%);
  color: ${t["text-primary"]};
  font-family: "Inter Variable", sans-serif;
  font-optical-sizing: auto;
  display: grid;
  grid-template-columns: 1fr 300px;
  gap: 40px;
  padding: 72px 80px;
  position: relative;
}
.copy { display: flex; flex-direction: column; }
.brand { display: flex; align-items: center; gap: 16px; font-size: 34px; font-weight: 600; letter-spacing: -0.01em; }
.brand svg { width: 44px; height: 44px; }
h1 { margin-top: auto; font-size: 64px; line-height: 1.05; font-weight: 650; letter-spacing: -0.02em; }
p { margin-top: 24px; font-size: 26px; line-height: 1.4; color: ${t["text-secondary"]}; max-width: 640px; }
code { font-family: "JetBrains Mono Variable", monospace; font-size: 0.9em; color: ${t.accent}; }
.url { margin-top: auto; padding-top: 32px; font-family: "JetBrains Mono Variable", monospace; font-size: 22px; color: ${t["text-tertiary"]}; }
.diagram { align-self: center; width: 300px; }
.legs { fill: none; stroke: ${t["border-strong"]}; stroke-width: 2; stroke-dasharray: 4 6; }
.hyp { fill: none; stroke: ${t.accent}; stroke-width: 5; stroke-linecap: round; }
.node { fill: ${t["bg-panel"]}; stroke: ${t["text-primary"]}; stroke-width: 2.5; }
.label { fill: ${t["text-secondary"]}; font-size: 19px; font-weight: 500; }
</style></head><body>
<div class="copy">
  <div class="brand">${mark}Hypotenuse</div>
  <h1>A teammate in every channel</h1>
  <p>A persistent multiplayer, multichannel agent for your team: bots in Slack, Linear, and Pylon that hand code to a sandbox and answer with the pull request.</p>
  <div class="url">hypotenuse.cloud</div>
</div>
<svg class="diagram" viewBox="0 0 400 300">
  <path class="legs" d="M340 50 L340 250 L60 250"/>
  <path class="hyp" d="M340 50 L60 250"/>
  <circle class="node" cx="340" cy="50" r="9"/>
  <circle class="node" cx="60" cy="250" r="9"/>
  <text class="label" x="326" y="32" text-anchor="end">Where your team talks</text>
  <text class="label" x="44" y="284">The work, done</text>
</svg>
</body></html>`;
}

/**
 * Screenshot the card into `public/social.png`.
 * @returns Resolves when the PNG is written.
 */
async function main(): Promise<void> {
  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM_PATH
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH }
      : {},
  );
  try {
    const page = await browser.newPage({
      viewport: { width: SOCIAL_IMAGE_WIDTH, height: SOCIAL_IMAGE_HEIGHT },
      deviceScaleFactor: SCALE,
    });
    await page.setContent(renderSocialCard(), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: OUT });
    console.log(`wrote ${OUT}`);
  } finally {
    await browser.close();
  }
}

if (import.meta.main) await main();
