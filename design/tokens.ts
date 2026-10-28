#!/usr/bin/env bun
/**
 * Hypotenuse's design tokens: three inputs per theme (base, accent, contrast) in
 * LCH, and a pure generator that turns them into every semantic color token for
 * light and dark. The spec is docs/DESIGN.md.
 *
 *   bun design/tokens.ts --write   regenerate every output
 *   bun design/tokens.ts --check   exit 1 if any output differs from a fresh generation
 *
 * Outputs (committed, never edited by hand):
 *   frontend/src/styles/_tokens.generated.scss   CSS custom properties per theme
 *   design/tokens.json                            hex values, read by the CLI palette
 *   backend/theme/hypotenuse-theme.ts             the Keryx OAuth page's `--keryx-*` theme
 *   backend/theme/email-palette.ts                mail chrome
 *   design/mark.svg, design/app-icon.png          the mark, and the mark as an opaque tile
 *   frontend/public/favicon{,-dark}.svg           the web app's icon
 *   backend/assets/favicon{.ico,.svg,-dark.svg}   the API origin's icon, for MCP clients
 *   backend/templates/lion.svg                    the mark on the OAuth page
 *
 * No dependencies: the LCH → sRGB conversion and WCAG contrast are below.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

/** A CIE LCH color: lightness 0–100, chroma ≥ 0, hue in degrees. */
export interface Lch {
  l: number;
  c: number;
  h: number;
}

/** The three inputs that determine one theme. */
export interface ThemeInputs {
  mode: "light" | "dark";
  /** The neutral ground every surface is a step from. */
  base: Lch;
  /** The one brand hue: primary actions, links, selection. */
  accent: Lch;
  /** Separation between surface steps; 30 is the default. */
  contrast: number;
}

/** The inputs. Changing the look means changing these — never a generated file. */
export const INPUTS: Record<"light" | "dark", ThemeInputs> = {
  light: {
    mode: "light",
    base: { l: 98, c: 1.5, h: 260 },
    accent: { l: 58, c: 38, h: 195 },
    contrast: 30,
  },
  dark: {
    mode: "dark",
    base: { l: 9, c: 2, h: 265 },
    accent: { l: 70, c: 38, h: 195 },
    contrast: 30,
  },
};

/** Fixed hues for state colors; lightness is solved per theme for contrast. */
const HUES = {
  active: { h: 250, c: 48 },
  waiting: { h: 75, c: 62 },
  complete: { h: 150, c: 45 },
  error: { h: 28, c: 62 },
  stopping: { h: 55, c: 55 },
  manager: { h: 300, c: 45 },
  online: { h: 150, c: 50 },
  draining: { h: 75, c: 62 },
  // A conversation at rest: calm and cool, distinct from the grey of a stale lease.
  idle: { h: 230, c: 22 },
} as const;

// ---------------------------------------------------------------------------
// Color math (CSS Color 4: LCH is CIE LCh(ab) with a D50 white)
// ---------------------------------------------------------------------------

/**
 * Convert LCH to unclamped linear sRGB.
 * @param color - The LCH color.
 * @returns Linear-light r, g, b (may fall outside 0–1 when out of gamut).
 */
function lchToLinearSrgb({ l, c, h }: Lch): [number, number, number] {
  const hr = (h * Math.PI) / 180;
  const a = c * Math.cos(hr);
  const b = c * Math.sin(hr);
  // Lab → XYZ (D50)
  const fy = (l + 16) / 116;
  const fx = fy + a / 500;
  const fz = fy - b / 200;
  const e = 216 / 24389;
  const k = 24389 / 27;
  const xr = fx ** 3 > e ? fx ** 3 : (116 * fx - 16) / k;
  const yr = l > k * e ? fy ** 3 : l / k;
  const zr = fz ** 3 > e ? fz ** 3 : (116 * fz - 16) / k;
  const [x, y, z] = [xr * 0.96422, yr * 1.0, zr * 0.82521];
  // Bradford D50 → D65
  const x65 = 0.9554734527042182 * x - 0.023098536874261423 * y + 0.0632593086610217 * z;
  const y65 = -0.028369706963208136 * x + 1.0099954580058226 * y + 0.021041398966943008 * z;
  const z65 = 0.012314001688319899 * x - 0.020507696433477912 * y + 1.3303659366080753 * z;
  // XYZ (D65) → linear sRGB
  return [
    3.2409699419045226 * x65 - 1.537383177570094 * y65 - 0.4986107602930034 * z65,
    -0.9692436362808796 * x65 + 1.8759675015077202 * y65 + 0.04155505740717559 * z65,
    0.05563007969699366 * x65 - 0.20397695888897652 * y65 + 1.0569715142428786 * z65,
  ];
}

/** Whether every channel is inside sRGB, with a hair of tolerance. */
function inGamut(rgb: [number, number, number]): boolean {
  return rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
}

/**
 * Map an LCH color into sRGB by reducing chroma (keeping lightness and hue), then
 * gamma-encode and quantize to 8 bits.
 * @param color - The LCH color.
 * @returns 8-bit sRGB channels.
 */
export function lchToSrgb8(color: Lch): [number, number, number] {
  let lo = 0;
  let hi = color.c;
  let rgb = lchToLinearSrgb(color);
  if (!inGamut(rgb)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(lchToLinearSrgb({ ...color, c: mid }))) lo = mid;
      else hi = mid;
    }
    rgb = lchToLinearSrgb({ ...color, c: lo });
  }
  const encode = (v: number) => {
    const x = Math.min(1, Math.max(0, v));
    const g = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
    return Math.round(g * 255);
  };
  return [encode(rgb[0]), encode(rgb[1]), encode(rgb[2])];
}

/**
 * Format 8-bit channels as a lowercase hex color.
 * @param rgb - 8-bit sRGB channels.
 * @returns `#rrggbb`.
 */
export function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * WCAG 2.1 relative luminance of a hex color.
 * @param hex - `#rrggbb`.
 * @returns Luminance 0–1.
 */
export function luminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const lin = ch.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

/**
 * WCAG 2.1 contrast ratio between two hex colors.
 * @param a - First color.
 * @param b - Second color.
 * @returns Ratio from 1 to 21.
 */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Shorthand: LCH straight to hex. */
const hex = (color: Lch) => toHex(lchToSrgb8(color));

/**
 * Find the lightness, moving away from `against`, at which a color of this hue and
 * chroma first reaches a contrast target. Deterministic (bisection, fixed steps).
 * @param target - Minimum WCAG ratio.
 * @param against - Every background hex the color is drawn on; the worst one must clear.
 * @param hue - Hue and chroma of the color being solved.
 * @param mode - Light themes solve downward (darker), dark themes upward.
 * @param prefer - A lightness to keep if it already clears the target.
 * @returns The hex color that just clears the target.
 */
function solveForContrast(
  target: number,
  against: string[],
  hue: { h: number; c: number },
  mode: "light" | "dark",
  prefer?: number,
): string {
  const worst = (fg: string) => Math.min(...against.map((bg) => contrastRatio(fg, bg)));
  // A designed lightness wins whenever it already clears; the search only finds
  // the nearest passing lightness when it does not.
  if (prefer !== undefined && worst(hex({ l: prefer, ...hue })) >= target) return hex({ l: prefer, ...hue });
  // Search the half of the lightness axis that moves away from the background.
  let near = mode === "light" ? 100 : 0;
  let far = mode === "light" ? 0 : 100;
  if (worst(hex({ l: far, ...hue })) < target) return hex({ l: far, ...hue });
  for (let i = 0; i < 30; i++) {
    const mid = (near + far) / 2;
    if (worst(hex({ l: mid, ...hue })) >= target) far = mid;
    else near = mid;
  }
  return hex({ l: far, ...hue });
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

/** Every semantic color token, by name (without the leading `--`). */
export type ThemeTokens = Record<string, string>;

/**
 * Generate one theme's semantic tokens from its inputs. Pure and deterministic.
 * @param inputs - Base, accent, and contrast for one mode.
 * @returns Token name → `#rrggbb`.
 */
export function generateTheme(inputs: ThemeInputs): ThemeTokens {
  const { mode, base, accent } = inputs;
  const k = inputs.contrast / 30;
  const dir = mode === "light" ? -1 : 1; // light steps darker, dark steps lighter
  const surface = (step: number, extraChroma = 0) =>
    hex({ l: base.l + dir * step * k, c: base.c + extraChroma, h: base.h });

  const t: ThemeTokens = {};
  t["bg-app"] = surface(0);
  t["bg-panel"] = mode === "light" ? hex({ l: 100, c: 0, h: base.h }) : surface(3);
  t["bg-raised"] = mode === "light" ? hex({ l: 100, c: 0, h: base.h }) : surface(6);
  t["bg-sunken"] = mode === "light" ? surface(3) : hex({ l: base.l - 3, c: base.c, h: base.h });
  t["bg-hover"] = surface(mode === "light" ? 4 : 8);
  t["bg-selected"] = hex({
    l: base.l + dir * (mode === "light" ? 6 : 12) * k,
    c: 8,
    h: accent.h,
  });
  t["border-subtle"] = surface(mode === "light" ? 8 : 12);
  t["border-default"] = surface(mode === "light" ? 14 : 19);
  t["border-strong"] = surface(mode === "light" ? 26 : 32);

  // Text is solved by contrast against every ground it is drawn on, not by fixed
  // lightness, which is what keeps both themes legible when an input changes.
  // The worst ground decides: in light the app ground is darker than the panel,
  // in dark the panel is lighter than the app ground.
  const grounds = [t["bg-app"]!, t["bg-panel"]!];
  const ink = { h: base.h, c: base.c };
  t["text-primary"] = solveForContrast(14, grounds, ink, mode);
  t["text-secondary"] = solveForContrast(7, grounds, ink, mode);
  t["text-tertiary"] = solveForContrast(4.6, grounds, ink, mode);
  t["text-disabled"] = solveForContrast(3, grounds, ink, mode);

  t.accent = solveForContrast(4.6, grounds, { h: accent.h, c: accent.c }, mode, accent.l);
  // Hover moves further from the ground than the accent, so it never loses contrast.
  t["accent-hover"] = solveForContrast(
    contrastRatio(t.accent, t["bg-app"]!) + 0.8,
    grounds,
    { h: accent.h, c: accent.c },
    mode,
  );
  t["accent-subtle"] = hex({
    l: mode === "light" ? 94 : 20,
    c: mode === "light" ? 10 : 14,
    h: accent.h,
  });
  const white = "#ffffff";
  const black = hex({ l: 8, c: 2, h: base.h });
  t["text-on-accent"] =
    contrastRatio(white, t.accent) >= contrastRatio(black, t.accent) ? white : black;
  t["focus-ring"] = solveForContrast(3, grounds, { h: accent.h, c: accent.c }, mode, accent.l);

  // State colors are glyphs and chips: 3:1 against the panel they sit on.
  const glyphL = mode === "light" ? 55 : 70;
  const glyph = (hue: { h: number; c: number }) => solveForContrast(3.2, grounds, hue, mode, glyphL);
  t["status-pending"] = t["text-tertiary"];
  t["status-active"] = glyph(HUES.active);
  t["status-waiting"] = glyph(HUES.waiting);
  t["status-complete"] = glyph(HUES.complete);
  t["status-error"] = glyph(HUES.error);
  t["status-idle"] = glyph(HUES.idle);
  t["status-stale"] = t["text-disabled"];
  t["status-stopping"] = glyph(HUES.stopping);
  t["runner-online"] = glyph(HUES.online);
  t["runner-offline"] = t["text-disabled"];
  t["runner-draining"] = glyph(HUES.draining);
  t["role-manager"] = glyph(HUES.manager);
  t["role-worker"] = glyph({ h: accent.h, c: accent.c });
  // Diff counts are text: 4.5:1.
  t["diff-add"] = solveForContrast(4.6, grounds, HUES.complete, mode, glyphL);
  t["diff-remove"] = solveForContrast(4.6, grounds, HUES.error, mode, glyphL);
  return t;
}

/** Both generated themes. */
export function generateAll(): Record<"light" | "dark", ThemeTokens> {
  return { light: generateTheme(INPUTS.light), dark: generateTheme(INPUTS.dark) };
}

/**
 * The text/background pairs the components actually draw, with the minimum ratio
 * each must clear. The contrast test walks this list in both themes.
 */
export const CONTRAST_PAIRS: Array<{ fg: string; bg: string; min: number }> = [
  ...["bg-app", "bg-panel", "bg-raised", "bg-hover"].flatMap((bg) => [
    { fg: "text-primary", bg, min: 4.5 },
    { fg: "text-secondary", bg, min: 4.5 },
  ]),
  { fg: "text-tertiary", bg: "bg-app", min: 4.5 },
  { fg: "text-tertiary", bg: "bg-panel", min: 4.5 },
  { fg: "text-primary", bg: "bg-selected", min: 4.5 },
  // The bot badge's tag and a bot's monogram.
  { fg: "text-primary", bg: "accent-subtle", min: 4.5 },
  { fg: "accent", bg: "bg-app", min: 4.5 },
  { fg: "accent", bg: "bg-panel", min: 4.5 },
  { fg: "text-on-accent", bg: "accent", min: 4.5 },
  { fg: "text-on-accent", bg: "accent-hover", min: 4.5 },
  { fg: "focus-ring", bg: "bg-app", min: 3 },
  { fg: "diff-add", bg: "bg-panel", min: 4.5 },
  { fg: "diff-remove", bg: "bg-panel", min: 4.5 },
  ...[
    "status-active",
    "status-idle",
    "status-waiting",
    "status-complete",
    "status-error",
    "status-stopping",
    "runner-online",
    "runner-draining",
    "role-manager",
    "role-worker",
  ].map((fg) => ({ fg, bg: "bg-panel", min: 3 })),
];

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

const ROOT = join(import.meta.dir, "..");
const HEADER = "Generated by design/tokens.ts — do not edit. Change INPUTS there and run `bun run --cwd frontend theme:build`.";

/**
 * Render the SCSS custom-property blocks for both themes. Light is also the
 * default for a document with no `data-theme` yet.
 * @param themes - Generated tokens.
 * @returns SCSS source.
 */
export function renderScss(themes: Record<"light" | "dark", ThemeTokens>): string {
  const block = (tokens: ThemeTokens) =>
    Object.entries(tokens)
      .map(([name, value]) => `  --${name}: ${value};`)
      .join("\n");
  return `// ${HEADER}

:root,
[data-theme="light"] {
  color-scheme: light;
${block(themes.light)}
}

[data-theme="dark"] {
  color-scheme: dark;
${block(themes.dark)}
}
`;
}

/**
 * Render the token JSON the CLI palette embeds.
 * @param themes - Generated tokens.
 * @returns Pretty-printed JSON.
 */
export function renderJson(themes: Record<"light" | "dark", ThemeTokens>): string {
  return `${JSON.stringify({ $comment: HEADER, ...themes }, null, 2)}\n`;
}

/**
 * Render the Keryx OAuth page theme: `--keryx-*` overrides for light, and a
 * `prefers-color-scheme: dark` block (that page has no script and no storage).
 * @param themes - Generated tokens.
 * @returns TypeScript source default-exporting the CSS string.
 */
export function renderKeryxTheme(themes: Record<"light" | "dark", ThemeTokens>): string {
  const vars = (t: ThemeTokens) => `    --keryx-font-family: "Inter Variable", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    --keryx-color-primary: ${t.accent};
    --keryx-color-primary-hover: ${t["accent-hover"]};
    --keryx-color-accent: ${t.accent};
    --keryx-bg: ${t["bg-app"]};
    --keryx-surface: ${t["bg-panel"]};
    --keryx-color-text: ${t["text-primary"]};
    --keryx-color-text-muted: ${t["text-secondary"]};
    --keryx-color-border: ${t["border-default"]};
    --keryx-radius: 8px;`;
  return `// ${HEADER}
// Keryx inlines this after its default theme on the OAuth authorization page.

const css = \`:root {
${vars(themes.light)}
  }
  @media (prefers-color-scheme: dark) {
    :root {
${vars(themes.dark)}
    }
  }\`;

export default css;
`;
}

/**
 * Render the notification e-mail palette. Mail clients honour neither custom
 * properties nor `prefers-color-scheme` reliably, so mail is painted once, in
 * the light theme, from literal values generated here rather than typed into a
 * template.
 * @param themes - Generated tokens.
 * @returns TypeScript source exporting the palette.
 */
export function renderEmailPalette(themes: Record<"light" | "dark", ThemeTokens>): string {
  const t = themes.light;
  const palette = {
    background: t["bg-app"],
    surface: t["bg-panel"],
    border: t["border-default"],
    text: t["text-primary"],
    textMuted: t["text-secondary"],
    accent: t.accent,
    textOnAccent: t["text-on-accent"],
  };
  return `// ${HEADER}
// Notification e-mail colors: the light theme, as literals mail clients can render.

export const EMAIL_PALETTE = {
${Object.entries(palette)
  .map(([key, value]) => `  ${key}: "${value}",`)
  .join("\n")}
} as const;
`;
}

/**
 * Render the mark: a right triangle whose hypotenuse — drawn in the accent — runs
 * from Linear (top right) to your machine (bottom left).
 * @param t - One theme's tokens (the triangle takes its primary text color), or
 *   `inline` for a mark inside a themed page, painted from `currentColor` and the
 *   page's `--keryx-color-primary` so it follows that page's color scheme.
 * @returns SVG source.
 */
export function renderMark(t: ThemeTokens | "inline"): string {
  const fill = t === "inline" ? 'fill="currentColor"' : `fill="${t["text-primary"]}"`;
  const stroke = t === "inline" ? 'style="stroke: var(--keryx-color-primary)"' : `stroke="${t.accent}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" data-glyph="hypotenuse">
  <path d="M28 4 L28 28 L4 28 Z" ${fill}/>
  <path d="M28 4 L4 28" ${stroke} stroke-width="3" stroke-linecap="round"/>
</svg>
`;
}

/** The pixel sizes packed into `favicon.ico`. */
export const ICO_SIZES = [16, 32, 48, 64] as const;

/**
 * Rasterize the mark — the same two shapes {@link renderMark} draws in its
 * 32-unit viewBox — at one pixel size, 8×8 supersampled for anti-aliasing.
 * @param t - One theme's tokens.
 * @param size - Width and height in pixels.
 * @param scale - The mark's size as a fraction of the image, centered.
 * @returns Straight-alpha RGBA bytes, row-major.
 */
export function rasterizeMark(t: ThemeTokens, size: number, scale = 1): Uint8Array {
  const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  const fill = rgb(t["text-primary"]);
  const stroke = rgb(t.accent);
  const SS = 8;
  const out = new Uint8Array(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = 16 + (((px + (sx + 0.5) / SS) * 32) / size - 16) / scale;
          const y = 16 + (((py + (sy + 0.5) / SS) * 32) / size - 16) / scale;
          // The stroke runs (28,4)→(4,28), 3 wide with round caps.
          const u = Math.max(0, Math.min(1, (28 - x + (y - 4)) / 48));
          const inStroke = Math.hypot(x - (28 - 24 * u), y - (4 + 24 * u)) <= 1.5;
          const inFill = x <= 28 && y <= 28 && x + y >= 32;
          const c = inStroke ? stroke : inFill ? fill : null;
          if (!c) continue;
          for (let i = 0; i < 3; i++) sum[i] += c[i];
          sum[3]++;
        }
      }
      const o = (py * size + px) * 4;
      if (sum[3] === 0) continue;
      for (let i = 0; i < 3; i++) out[o + i] = Math.round(sum[i] / sum[3]);
      out[o + 3] = Math.round((sum[3] / (SS * SS)) * 255);
    }
  }
  return out;
}

/** CRC-32 (the PNG chunk checksum) of `bytes`. */
function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

/**
 * Encode RGBA pixels as a PNG: one IHDR, one IDAT, no filtering.
 * @param rgba - Straight-alpha RGBA bytes.
 * @param size - Width and height in pixels.
 * @returns PNG bytes.
 */
export function encodePng(rgba: Uint8Array, size: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA, no interlace
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/**
 * Render `favicon.ico` for the API origin: the light mark as PNG entries at
 * each of {@link ICO_SIZES}. MCP clients and favicon services look for
 * `/favicon.ico` on the server's origin, and few of them read SVG.
 * @param themes - Generated tokens.
 * @returns ICO bytes.
 */
export function renderFaviconIco(themes: Record<"light" | "dark", ThemeTokens>): Buffer {
  const pngs = ICO_SIZES.map((size) => encodePng(rasterizeMark(themes.light, size), size));
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach((png, i) => {
    const e = 6 + 16 * i;
    const size = ICO_SIZES[i];
    header.writeUInt8(size % 256, e); // 0 means 256
    header.writeUInt8(size % 256, e + 1);
    header.writeUInt16LE(1, e + 4); // color planes
    header.writeUInt16LE(32, e + 6); // bits per pixel
    header.writeUInt32LE(png.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...pngs]);
}

/** The app icon's width and height in pixels. */
export const APP_ICON_SIZE = 512;

/**
 * Render the app icon — the PNG uploaded where a service takes a picture, not an
 * SVG (the Linear app's icon). An opaque light-panel tile with the light mark at
 * 60%, so it reads on a dark UI and survives a circular avatar crop: the mark's
 * far corner sits inside the inscribed circle.
 * @param themes - Generated tokens.
 * @returns PNG bytes.
 */
export function renderAppIcon(themes: Record<"light" | "dark", ThemeTokens>): Buffer {
  const t = themes.light;
  const ground = [1, 3, 5].map((i) => Number.parseInt(t["bg-panel"].slice(i, i + 2), 16));
  const mark = rasterizeMark(t, APP_ICON_SIZE, 0.6);
  const out = new Uint8Array(mark.length);
  for (let o = 0; o < mark.length; o += 4) {
    const a = mark[o + 3] / 255;
    for (let i = 0; i < 3; i++) out[o + i] = Math.round(mark[o + i] * a + ground[i] * (1 - a));
    out[o + 3] = 255;
  }
  return encodePng(out, APP_ICON_SIZE);
}

/** Where each output lives, and how to render it. */
export const OUTPUTS = [
  { path: "frontend/src/styles/_tokens.generated.scss", render: renderScss },
  { path: "design/tokens.json", render: renderJson },
  { path: "backend/theme/hypotenuse-theme.ts", render: renderKeryxTheme },
  { path: "backend/theme/email-palette.ts", render: renderEmailPalette },
  { path: "design/mark.svg", render: (themes) => renderMark(themes.light) },
  { path: "design/app-icon.png", render: renderAppIcon },
  { path: "frontend/public/favicon.svg", render: (themes) => renderMark(themes.light) },
  { path: "frontend/public/favicon-dark.svg", render: (themes) => renderMark(themes.dark) },
  // The API origin's static root, for MCP clients and anything else that asks it for an icon.
  { path: "backend/assets/favicon.svg", render: (themes) => renderMark(themes.light) },
  { path: "backend/assets/favicon-dark.svg", render: (themes) => renderMark(themes.dark) },
  { path: "backend/assets/favicon.ico", render: renderFaviconIco },
  // Keryx resolves the OAuth page's artwork partial by the fixed name `lion.svg`.
  {
    path: "backend/templates/lion.svg",
    render: () =>
      `<!-- The Hypotenuse mark. ${HEADER} Keryx resolves this partial by the fixed name lion.svg. -->\n${renderMark("inline")}`,
  },
] as const satisfies ReadonlyArray<{
  path: string;
  render: (themes: Record<"light" | "dark", ThemeTokens>) => string | Uint8Array;
}>;

if (import.meta.main) {
  const mode = process.argv.includes("--check") ? "check" : "write";
  const themes = generateAll();
  let stale = 0;
  for (const { path, render } of OUTPUTS) {
    const full = join(ROOT, path);
    const next = render(themes);
    if (mode === "write") {
      writeFileSync(full, next);
      console.log(`wrote ${path}`);
    } else {
      let current: Buffer = Buffer.alloc(0);
      try {
        current = readFileSync(full);
      } catch {}
      if (!current.equals(Buffer.from(next))) {
        console.error(`${path} is stale — run \`bun run --cwd frontend theme:build\``);
        stale++;
      }
    }
  }
  process.exit(stale ? 1 : 0);
}
