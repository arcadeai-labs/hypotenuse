# Phase 3 — Design system

> **Goal:** Build Hypotenuse's own look before any page is built on it: a Linear-native, light-and-dark design
> system generated from three inputs; the self-drawn status glyphs and the `◢` mark; the app shell (sidebar, list,
> detail-with-properties, command palette); restyled versions of ToolExec's UI kit behind the same component API; the
> public site's frame; and a palette the CLI shares. The spec is [`../DESIGN.md`](../DESIGN.md). This phase makes it
> real and tested.

> **Status: planned, not built.** This is the one frontend phase that is **not** a ToolExec port. ToolExec's
> components, hooks, and page logic are still copied in
> [phase 4](./phase-04-users-tenancy-and-audit.md). What changes is everything they are painted with.

ToolExec ended on a single dense midnight theme (its phase 25): JetBrains-flavored density, a violet accent, and no
light mode. That suits an operator console. Hypotenuse's dashboard is a companion people reach *from* Linear. Its
lists, status glyphs, and properties panel should feel familiar to someone who lives in Linear, in both light and
dark, without looking like a Linear knock-off.

The economical path is to **keep ToolExec's component API and replace its paint**. Phase 4 copies `ui/*`, the
section-editor framework, `useFirstLoad`, `AuthContext`, and every page that depends on them. If those components
keep their props and `data-testid`s, the copied pages and e2e selectors work unchanged, and this phase only touches
styles, tokens, the shell, and a handful of new components.

## Scope

**In:**

- The **token generator**: LCH inputs → semantic tokens for light and dark → SCSS custom properties,
  `design/tokens.json`, and the backend's OAuth-page CSS.
- **Theme selection:** System, Light, or Dark, with the pre-paint boot script and `localStorage`.
- **Fonts:** Inter Variable and JetBrains Mono, self-hosted.
- **Glyphs:** session status, runner presence, role chips, the agent badge, and the `◢` mark and favicon set.
- **ToolExec's `#ui/*` kit restyled** (same exports, props, and test ids), plus new primitives: `ListGroup` /
  `ListRow`, `PropertiesPanel`, `StatusGlyph`, `Chip`, `Kbd`, `CommandPalette`, `Sheet`.
- **The app shell:** sidebar, header, list layout, detail + properties layout, the mobile sheet, and the keyboard map.
- The **public frame**: marketing `HomePage` (copy, hero diagram), `/docs` layout with a theme-aware `<picture>`,
  and the sign-in and sign-up page shells, unwired until phase 4.
- The **Keryx OAuth page** in both themes, via `prefers-color-scheme`.
- The **CLI palette and glyph module**, `cli/src/output/theme.ts`, generated from the same tokens.
- `/style-guide`: every component, both themes side by side.
- **Tests:** contrast, token-generation determinism, source scans (no raw colors, no literal `rem` font sizes), e2e
  theme switching with no flash, and screenshot capture in both themes.

**Out:**

- Real authentication behind the forms ([phase 4](./phase-04-users-tenancy-and-audit.md)).
- Every data page: settings and members ([phase 4](./phase-04-users-tenancy-and-audit.md)); sessions, the transcript,
  runners, and routing ([phase 15](./phase-15-dashboard.md)). This phase builds their **frames and components** and
  shows them with fixture data in `/style-guide`.
- CLI commands themselves ([phase 5](./phase-05-cli-and-distribution.md)). This phase ships only the palette and glyph
  module they print with.

## Design

### Three layers, one direction of flow

```
design/tokens.ts  (inputs: base, accent, contrast × light/dark; generator)
      │  bun run --cwd frontend theme:build
      ├──► frontend/src/styles/_tokens.generated.scss   [data-theme="light"] { … }  [data-theme="dark"] { … }
      ├──► design/tokens.json                           read by cli/src/output/theme.ts at build time
      └──► backend/theme/hypotenuse-theme.ts            the CSS string Keryx inlines into /oauth/authorize
```

- `design/` is a plain directory, not a workspace. It holds data and one generator script with no runtime
  dependencies, so `frontend/`, `cli/`, and `backend/` can all read it without a dependency edge between them.
- Generated files are committed. `frontend/src/__tests__/tokens.test.ts` regenerates them in memory and asserts
  byte-equality with what is on disk, so a hand edit to a generated file fails CI. This replaces ToolExec's "the theme
  is written twice by design" test with "written once, generated three times".
- **Components consume semantic tokens only.** `frontend/src/__tests__/no-raw-colors.test.ts` scans
  `src/**/*.{scss,css,tsx}` for hex, `rgb(`, `hsl(`, `lch(`, and `oklch(` literals outside `_tokens.generated.scss`.

### The generator

`design/tokens.ts` exports `generateTheme({ base, accent, contrast, mode })`. It is pure, deterministic, and has no
dependencies; LCH → sRGB conversion is about 40 lines and is tested against reference values.

- **Surface ramp:** `--bg-app` … `--bg-selected` are steps in L from the base. Light steps downward; dark steps upward.
- **Text ramp:** `--text-primary` … `--text-disabled` are chosen by contrast target against `--bg-app`, not by fixed L.
  This is what keeps both themes legible when the base or contrast input changes.
- **Accent family:** `--accent`, `--accent-hover`, `--accent-subtle`, and `--text-on-accent` (whichever of
  near-white or near-black clears 4.5:1).
- **Status, presence, and role tokens** have fixed hues and are adjusted in L and C per theme to clear 3:1 against
  `--bg-panel`.
- The **contrast** input scales the L distance between steps (30 default; higher means more separation), the same
  lever Linear exposes.

### Theme selection

- `index.html` contains an inline boot script of about 15 lines that runs before the stylesheet applies. It reads
  `localStorage["hypotenuse.theme"]` (`system` | `light` | `dark`). For `system`, or when nothing is stored, it uses
  `matchMedia("(prefers-color-scheme: dark)")`. It sets `document.documentElement.dataset.theme`. A `media` change
  listener updates `system` live.
- `frontend/src/context/ThemeContext.tsx` exposes `{ preference, resolved, setPreference }`. The account menu and the
  command palette ("Theme: Dark") are the two controls.
- Charts, Markdown code blocks, and screenshots read `resolved`. Nothing else needs to know the theme, because tokens
  do the work.

### The UI kit: same API, new paint

`frontend/src/ui/*` is copied from ToolExec in phase 4. This phase lands it **first**, restyled, so phase 4's copy is a
no-op for these files. The contract:

| Kept exactly | Changed |
|---|---|
| Export names, prop names, `variant` tones (`UI_VARIANT_TONES`), `data-testid`s, `SectionCard` / `SectionNav` behavior, `SkeletonRows` / `SkeletonBlocks` element types | All SCSS, radius (0 → 6/8px), type (Inter), density (14px → 13px with 36px rows), focus ring, hover and selected states, light theme |

`frontend/src/__tests__/ui-variants.test.ts` (ported) still asserts that every tone in `UI_VARIANT_TONES` has a rule.

New primitives (`frontend/src/ui/`):

| Component | Role |
|---|---|
| `ListGroup`, `ListRow` | Linear-style grouped list: a collapsible group header with a count, and 36px rows with leading glyph, identifier, title, trailing chips, and avatar. Keyboard focusable, `j`/`k` aware |
| `PropertiesPanel`, `Property` | the 280px right-hand panel: label/value rows, inline chips, links |
| `StatusGlyph` | `status: AgentSessionStatus` → the SVG from `ui/glyphs/` with `aria-label` |
| `PresenceDot`, `RoleChip`, `AgentBadge`, `Chip` | runner presence, M/W role, agent kind, generic chip |
| `CapacityBar` | slot segments with an optional label and link per segment |
| `CommandPalette` | `cmdk`-based. Commands come from a registry (`frontend/src/commands/`) and are filtered by `can()` |
| `Kbd`, `ShortcutSheet` | key hints and the `?` sheet |
| `Sheet` | the mobile sidebar and narrow-viewport properties drawer |
| `Avatar` | person or agent. An agent always carries `AgentBadge` (AIG principle 1) |

### The shell

`frontend/src/components/AppShell.tsx` replaces ToolExec's `Layout` for signed-in pages:

- **Sidebar** (`components/shell/Sidebar.tsx`): `◢ Hypotenuse`, project switcher (`AuthContext.projects`), nav items
  with live counts (fed later by the sessions and runners channels; zero or hidden until then), collapse with `[`.
- **Header** (`components/shell/PageHeader.tsx`): title, filter chips, a *Display* menu, and right-aligned actions.
- **Layouts:** `ListLayout` (header + grouped list) and `DetailLayout` (header + main + `PropertiesPanel`).
- **Keyboard map** (`frontend/src/commands/keymap.ts`): `⌘K`, `g h|s|r|o`, `j`/`k`, `enter`, `esc`, `/`, `?`, `[`.
  One registry feeds the palette, the shortcut sheet, and the e2e spec.
- **Below 768px:** the sidebar becomes a `Sheet`, `DetailLayout` stacks, and rows drop their trailing columns.

Public pages (`/`, `/docs/*`, `/sign-in`, `/sign-up`) use `components/shell/PublicShell.tsx`: top bar with mark,
Docs, Sign in, and a theme toggle, plus a footer.

### The CLI palette

`cli/src/output/theme.ts` imports `design/tokens.json` with `with { type: "json" }`, which embeds it in the compiled
binary. It exports:

- `color(token, text)`: truecolor (`COLORTERM=truecolor|24bit`), else nearest xterm-256, else plain. It honors
  `NO_COLOR`, `FORCE_COLOR`, `--no-color`, `--json`, and non-TTY output through mcpx's `early-env` / `tty` modules,
  ported here.
- `glyph(status)` returns the Unicode glyphs from [`DESIGN.md`](../DESIGN.md#iconography-and-glyphs), or the ASCII
  fallback when `LANG` / `LC_ALL` is not UTF-8.
- `table(rows, columns)`: borderless, dim headers, right-aligned numerics, middle truncation.
- `banner()`: `◢ hypotenuse <version>`.

The CLI uses the **dark** token values when the terminal background is unknown. It uses light values if
`COLORFGBG` says the background is light.

## Steps

### 1. Tokens and generator — `design/tokens.ts`, `design/tokens.json`, `design/mark.svg`, `design/README.md`

The inputs from [`DESIGN.md`](../DESIGN.md#color), `generateTheme`, LCH↔sRGB helpers, and a `build` entry that writes
the three outputs. `design/README.md` explains the inputs and says never to edit generated files.

### 2. Generated outputs and build script — `frontend/scripts/build-theme.ts`, `frontend/package.json` (`theme:build`)

Writes `frontend/src/styles/_tokens.generated.scss`, `design/tokens.json`, and `backend/theme/hypotenuse-theme.ts`.
`bun run lint` in `frontend/` runs `theme:build --check`.

### 3. Fonts — `frontend/src/styles/fonts.scss`

`@fontsource-variable/inter` and `@fontsource-variable/jetbrains-mono`, latin subsets, `font-display: swap`. Body
`font-feature-settings` as in the spec. No Google Fonts requests: a test scans built `dist/` for
`fonts.googleapis.com`.

### 4. Base styles — `frontend/src/styles/{_base,_type,_space,_motion}.scss`, `frontend/src/styles/app.scss`

Reset, type ramp as ratios of `--font-size`, spacing tokens, radius, shadows (light only), the reduced-motion block,
focus-visible ring, and selection color. Tailwind v4 is kept as in ToolExec (`source(none)` plus explicit `@source`),
with its theme mapped to our tokens so utilities emit `var(--…)`.

### 5. Theme selection — `frontend/index.html` (boot script), `frontend/src/context/ThemeContext.tsx`

As designed. The account-menu control lands with the shell in step 8. The palette command lands in step 9.

### 6. Glyphs and the mark — `frontend/src/ui/glyphs/*.tsx`, `frontend/public/{favicon.svg,favicon-dark.svg,apple-touch-icon.png}`

One component per glyph in [`DESIGN.md`](../DESIGN.md#iconography-and-glyphs), each with `aria-label`. The *active*
glyph's rotation is CSS and is stopped under reduced motion. The favicon has light and dark variants selected via
`media` on the `<link>`.

### 7. UI kit restyle and new primitives — `frontend/src/ui/*`, `frontend/src/ui/core.tsx`, `frontend/src/styles/_ui.scss`

Land ToolExec's `ui/*` (copied from `toolexec/frontend/src/ui/`) with the new SCSS, and add the new primitives in the
table above. Prop and test-id parity is checked by
`frontend/src/__tests__/ui-api-parity.test.ts`. That test holds a frozen list of ToolExec's exported names and props
and fails if one disappears.

### 8. Shell — `frontend/src/components/AppShell.tsx`, `components/shell/{Sidebar,PageHeader,PublicShell,AccountMenu}.tsx`, `components/layouts/{ListLayout,DetailLayout}.tsx`

The account menu holds the theme control and sign-out (wired in phase 4).

### 9. Command palette and keyboard — `frontend/src/ui/CommandPalette.tsx`, `frontend/src/commands/{registry,keymap}.ts`, `frontend/src/ui/ShortcutSheet.tsx`

The registry entries are `{ id, title, keywords, shortcut?, when?: (ctx) => boolean, run }`. In this phase it holds
navigation and theme commands; later phases add theirs (e.g. "Cancel session", "Revoke runner"), each gated by
`can()`.

### 10. Public frame — `frontend/src/pages/marketing/HomePage.tsx`, `frontend/src/pages/docs/{DocsLayout,DocsPage}.tsx`, `frontend/src/components/ThemedImage.tsx`, `frontend/src/content/docs/{index,why}.md`

- Hero copy and the triangle diagram, drawn as inline SVG from tokens so it works in both themes.
- The three-step explainer, a supported-agents strip as text, install commands with copy buttons, and security
  points.
- The docs layout: section nav, a 72ch article, and an "on this page" rail.
- `ThemedImage` renders `<picture>` with `-light.png` / `-dark.png` sources.

### 11. Auth page shells — `frontend/src/pages/{SignInPage,SignUpPage}.tsx`

Centred card on `PublicShell` with client-side validation. They post nowhere until phase 4, as ToolExec's phase 3 did.

### 12. Keryx OAuth page — `backend/templates/{oauth-authorize.html,oauth-common.css,hypotenuse.svg}`, `backend/theme/hypotenuse-theme.ts`

Ported structure from `toolexec/backend/templates/`. Both themes are expressed as
`@media (prefers-color-scheme: dark)` blocks generated from the tokens. `WEB_SERVER_THEME=theme/hypotenuse-theme.ts`.

### 13. Style guide — `frontend/src/pages/StyleGuidePage.tsx` at `/style-guide`

Every primitive and glyph, with a fixture session list, a fixture transcript (prompt, thought, ephemeral action,
action with result and diff stats, plan, elicitation, response, error, turn separator), a fixture runner card and
table, and the properties panel. It renders twice side by side, `data-theme="light"` and `data-theme="dark"` on two
containers, so a reviewer sees both at once. This page is where phases 4 and 15 take their fixtures from.

### 14. CLI palette — `cli/src/output/{theme,early-env,tty}.ts`, `cli/__tests__/output/theme.test.ts`

As designed. Tests cover truecolor / 256 / none selection, glyph fallbacks under `LANG=C`, middle truncation, and that
every token `theme.ts` names exists in `design/tokens.json`.

### 15. Screenshot pipeline — `frontend/scripts/capture-doc-illustrations.ts`, `frontend/package.json` (`docs:illustrations`)

Ported from ToolExec's script. It captures each illustration twice (light, dark) into
`frontend/public/docs/illustrations/<name>-{light,dark}.png`. In this phase it covers `/style-guide` and the home
page; later phases add their pages.

### 16. Tests — `frontend/src/__tests__/*`, `frontend/e2e/{theme,shell,keyboard,home}.spec.ts`

| Test | Asserts |
|---|---|
| `tokens.test.ts` | generated files equal a fresh generation; LCH→sRGB matches reference values; the generator is deterministic |
| `contrast.test.ts` | every declared text/background pair ≥ 4.5:1, and glyph, focus, and large text ≥ 3:1, **in both themes** |
| `no-raw-colors.test.ts` | no color literals outside generated tokens |
| `type-scale.test.ts` | no literal `rem`/`px` font sizes in component rules (ToolExec's `studio-layout` rule, kept) |
| `ui-api-parity.test.ts` | ToolExec's `ui/*` exports and props still exist |
| `ui-variants.test.ts` | (ported) every tone has a rule |
| `e2e/theme.spec.ts` | the stored preference applies before first paint (no frame with the other theme's `--bg-app`); System follows an emulated `prefers-color-scheme` change; the toggle persists across reload |
| `e2e/shell.spec.ts` | sidebar collapse, mobile sheet at 390px, `DetailLayout` stacking |
| `e2e/keyboard.spec.ts` | `⌘K` opens, filters, and runs a navigation command; `g s` navigates; `?` shows the sheet |
| `e2e/home.spec.ts` | public home and `/docs` render signed out in both themes; copy buttons copy |

## Verification

```bash
bun install
bun run --cwd frontend theme:build
bun run --cwd frontend lint            # includes theme:build --check
bun run --cwd frontend test
bun run --cwd frontend test:e2e -- theme shell keyboard home
bun run --cwd cli test -- output
bun dev && open http://localhost:3000/style-guide
```

Manually:

- On `/style-guide`, compare light and dark side by side: every glyph is distinguishable without color (shape
  differs), every chip is readable, and the transcript fixture reads top to bottom as a log.
- Switch the OS appearance with the preference on System. The app follows without a reload.
- Hard-reload with Dark stored on a light OS. There is no white flash.
- Run `hypotenuse --version` in a truecolor terminal, under `TERM=xterm-256color`, and under `NO_COLOR=1`. Run
  `LANG=C hypotenuse --version` to see the ASCII fallback.

## Definition of done

- [ ] `design/tokens.ts` generates both themes deterministically; the three generated outputs are committed and
      checked in CI
- [ ] Semantic tokens only in components; raw-color and font-size scans pass
- [ ] Contrast passes for every declared pair in both themes
- [ ] System / Light / Dark selection with a pre-paint boot script; no flash in e2e
- [ ] Inter and JetBrains Mono self-hosted; no third-party font requests
- [ ] Status, presence, role, and agent glyphs; the `◢` mark and favicons in both themes
- [ ] ToolExec's `ui/*` API preserved (parity test) and restyled; new primitives in place
- [ ] App shell with sidebar, list and detail layouts, properties panel, command palette, keyboard map, and mobile sheet
- [ ] Public home, `/docs` frame with theme-aware images, and sign-in/sign-up shells
- [ ] Keryx OAuth page in both themes from generated CSS
- [ ] `/style-guide` shows every component and fixture surface in both themes at once
- [ ] `cli/src/output/theme.ts` shares the tokens and glyphs, with correct color-depth and locale fallbacks
- [ ] Screenshot pipeline captures light and dark

## Learnings from the build

_Nothing yet — this phase has not been built._
