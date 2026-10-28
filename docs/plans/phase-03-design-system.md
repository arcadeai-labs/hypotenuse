# Phase 03 — Design system

> **Goal:** The v1 look, regenerated from the kept `design/` inputs and re-pointed at 2.0's nouns. It covers:
> - light and dark tokens, the self-hosted fonts, and the `◢` mark;
> - ToolExec's UI-kit API, repainted;
> - the app shell, the docs site frame, and `/style-guide`;
> - status glyphs for **conversation states** rather than runner sessions;
> - the CLI palette.
>
> Every later page is built on this, and none of it hand-picks a color.

> **Status: built.** It builds on [phase 01](./phase-01-foundation.md) (the frontend scaffold and
> `design/`). The pages that *use* the kit arrive with [phase 04](./phase-04-organizations-users-and-rbac.md) and
> later. The user asked to keep the v1 style for the docs and administration pages, so this phase is a **port** of
> v1's design-system phase, not a redesign.

v1 built a whole design system: an LCH token generator, contrast solved against every ground a color sits on,
both themes, Inter and JetBrains Mono self-hosted, our own status glyphs, a Linear-calm shell, the docs site, and a
CLI that prints the same palette. Its learnings record five traps, and every one of them would bite again:

- the Tailwind `@theme` self-reference that turned every page serif with all checks green;
- the sidebar mounted twice;
- the keymap dropping a half-typed `g`;
- `<picture>` following the OS rather than the app;
- a `public/docs` directory shadowing `/docs`.

The inputs are still in this repository (`design/tokens.ts`, `design/tokens.json`, `design/mark.svg`,
`design/app-icon.png`), so "keep the style" is literal: **change no input, port the generator's outputs and the
code that paints with them.**

What changes is vocabulary. v1's surfaces were sessions, runners, and routing. 2.0's are bots, channels,
conversations, memory, and sandboxes. The shell's navigation and the glyph table change accordingly, and
[`DESIGN.md`](../DESIGN.md) is rewritten for those nouns in this phase's commit. Its direction, color, type, and
space sections hold as written.

## Scope

**In:**
- **Generator outputs:**
  - `frontend/src/styles/_tokens.generated.scss`;
  - `backend/theme/hypotenuse-theme.ts`, the Keryx OAuth page theme;
  - `backend/templates/lion.svg` (our mark, under the name Keryx expects);
  - favicons;
  - `backend/theme/email-palette.ts` for mail chrome;
  - `cli/src/output/theme.ts`, built from `tokens.json`.
- **Theme and fonts:** System, Light, and Dark, with the pre-paint boot script. Inter Variable and JetBrains Mono,
  self-hosted.
- **UI kit:** ToolExec's `#ui/*` kit with the same exports, props, and test ids, plus v1's primitives (`ListGroup`,
  `ListRow`, `PropertiesPanel`, `StatusGlyph`, `Chip`, `Kbd`, `CommandPalette`, `Sheet`).
- **Glyphs:** the conversation-state glyph set; the **bot badge**; platform chips.
- **Shell and keyboard:** the app shell with 2.0's sidebar; the keymap.
- **Public frame:** the marketing home and the `/docs` layout with `ThemedImage`.
- **`/style-guide`** with fixture data for every 2.0 surface.
- **The rewritten [`DESIGN.md`](../DESIGN.md).**
- **Guard tests:** token determinism, contrast, no raw colors, type scale, fonts, self-referencing custom
  properties, UI-API parity, nginx, keymap, and e2e theme switching.

**Out:**
- Wiring sign-in and sign-up ([phase 04](./phase-04-organizations-users-and-rbac.md)).
- Every data page:
  - settings, members, audit ([phases 04](./phase-04-organizations-users-and-rbac.md)–[05](./phase-05-audit-logging.md));
  - bots ([phase 07](./phase-07-model-providers-and-bots.md));
  - conversations and mission control ([phase 21](./phase-21-dashboard.md)).

  This phase builds their **frames and components** with fixtures only.
- CLI commands ([phase 06](./phase-06-operator-cli.md)); only the palette and glyph module land here.
- New themes. One generator, two modes; ToolExec's five-look system is not ported.

## What already exists

| Piece | Where |
|---|---|
| Inputs and generator | `design/tokens.ts` (in this repository), [`design/README.md`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/design/README.md) |
| Generated outputs, UI kit, shell, glyphs, docs frame, style guide | [v1 `frontend/src/`](https://github.com/arcadeai-labs/hypotenuse/tree/v1/frontend/src) |
| The plan and its learnings | [v1 phase 03 — design system](https://github.com/arcadeai-labs/hypotenuse/blob/v1/docs/plans/phase-03-design-system.md) |
| Guard tests | v1 `frontend/src/__tests__/{tokens,contrast,no-raw-colors,type-scale,fonts,custom-properties,ui-api-parity,ui-variants,keymap,shell-keys,nginx}.test.ts` |
| OAuth page theme test | v1 `backend/__tests__/oauth/authorize-theme.test.ts` |
| CLI palette | v1 `cli/src/output/theme.ts` and `__tests__/output/theme.test.ts` |
| UI-kit API it must keep | [ToolExec `frontend/src/ui/`](https://github.com/arcadeai-labs/toolexec/tree/main/frontend/src/ui) |

## What this must not weaken

1. **Components consume semantic tokens only.**
   - `no-raw-colors.test.ts` refuses hex, `rgb(`, `hsl(`, `lch(`, and `oklch(` outside the generated file.
   - `type-scale.test.ts` refuses literal font sizes.
2. **Generated files are never edited.** `tokens.test.ts` regenerates in memory and asserts byte-equality.
3. **Both themes clear contrast on every ground they sit on.** The worst ground decides.
4. **An agent is always visibly an agent.** Every avatar that stands for a bot carries the bot badge. A bot's
   message must never be mistaken for a person's, in the dashboard, in the CLI, or in a screenshot.
5. **Fonts are self-hosted.** CI greps `dist/` for font CDNs.

## Design

### Status glyphs for conversations

The shape language is v1's: rings for in progress, discs for finished, a centre dot for "a person is needed". The
rows are 2.0's conversation states and sandbox job states.

| State | Glyph | CLI | Token |
|---|---|---|---|
| conversation `working` | ring with a quarter arc (slow spin; stops under reduced motion) | `◔` | `--status-active` |
| conversation `hibernating` | hollow ring | `○` | `--status-idle` |
| conversation `waiting` on `answer` / `approval` | ring with a centre dot | `◉` | `--status-waiting` |
| conversation `waiting` on `sandbox` / `timer` | ring with a small clock tick | `◷` | `--status-pending` |
| conversation `ended` (complete) | filled disc with a check | `✓` | `--status-complete` |
| conversation `ended` (failed) | filled disc with a cross | `✕` | `--status-error` |
| sandbox job `provisioning` | dotted ring | `◌` | `--status-pending` |
| sandbox job `running` | as `working` | `◔` | `--status-active` |

- `--status-idle` is a **new generator output**. It is solved like the other status tokens, as a glyph color at
  3:1 against a panel. It is the only input-side change this phase makes, and it is additive.
- `hibernating` is the normal rest state of a conversation, so it must read as calm, not stale.
- v1's `--status-stale` is kept for "a lease expired and the reaper has not run yet".
- The glyph components live in `frontend/src/ui/glyphs/`, keyed by the state names above. The dashboard and the
  CLI import the **same names**, so a renamed state is a type error in both.

### The bot badge and platform chips

- **Bot badge.** v1's agent badge, renamed. A small chip reading **bot** over the bot's avatar, with the bot's name
  beside it. The avatar is the bot's uploaded image ([phase 07](./phase-07-model-providers-and-bots.md)); without
  one it is a monogram on `--accent-subtle`, never a person-like default.
- **Platform chips.** `Slack`, `Linear`, `Pylon`, and `API` are set as text in a neutral chip. There are no logos:
  trademark use is one more thing to get wrong, and text is legible in both themes.

### The shell

```
┌──────────────┬──────────────────────────────────────────────────────────────┐
│ ◢ Hypotenuse │  Conversations                    [Filter] [Display]  ⌘K      │
│ acme ▾       ├──────────────────────────────────────────────────────────────┤
│ Support ▾    │  ▾ Waiting for a person · 1                                   │
│              │  ◉  #billing · "refund for Globex?"       bot Ada   Slack     │
│  Home        │  ▾ Working · 2                                                 │
│  Conversations│ ◔  ENG-142 · "add retry to ingress"      bot Kit   Linear    │
│  Bots      3 │  ◷  Globex · "export fails on CSV"         bot Ada   Pylon     │
│  Memory      │  ▾ Hibernating · 41                                            │
│  Sandboxes   │  ○  #eng-help · "how do I run e2e?"        bot Kit   Slack     │
│  Settings    │                                                                │
│  Docs ↗      │                                                                │
└──────────────┴──────────────────────────────────────────────────────────────┘
```

- **Sidebar order:**
  - the switchers: organization, then project;
  - Home, Conversations, Bots, Memory, Sandboxes, Settings, Docs.

  Each destination is gated by `can()` from [phase 04](./phase-04-organizations-users-and-rbac.md), and is
  **disabled, never absent**, until its phase lands. Disabled items read "Not available yet", never a phase
  number.
- **The organization switcher** is new. It sits above the project switcher, and its menu holds the organization's
  members and "New project" for owners.
- **Keymap:** `g h/c/b/m/s` for Home, Conversations, Bots, Memory, and Sandboxes. `⌘K`, `j`/`k`, `enter`, `esc`,
  `/`, and `?` keep v1's meaning. The keymap reads its context through a ref (v1's trap).
- **The sidebar is mounted in exactly one place**, chosen by a width check, so test ids are never duplicated.

### The signature surfaces, rewritten in `DESIGN.md`

1. **The conversation transcript.** A log, not a chat. Its source is `conversation_entries`
   ([phase 08](./phase-08-durable-agent-loop.md)):
   - message rows with the participant's platform name and avatar;
   - bot lines with the badge;
   - thinking collapsed to one `···` line;
   - one row per tool call (verb, parameter in mono, duration);
   - `run_code` rows showing the program and its host calls;
   - sandbox jobs as nested cards;
   - questions and approvals as the only accented cards.

   A question is answered **where it was asked**. The card deep-links to the Slack thread, Linear session, or
   Pylon issue, because the platform's own permissions decide who may answer
   ([phase 13](./phase-13-channel-framework.md)).
2. **The bot page.** Identity (avatar, name, persona), where it listens (channel bindings by platform), its tools
   (memory, MCP servers, skills, code mode, sandboxes), its model, and its access tags.
3. **The memory explorer.** Scope (project or a channel), then document, then versions, each with provenance back
   to the conversation entry that wrote it and a decay indicator.
4. **The public site and `/docs`, and the CLI.** v1's frames with 2.0's copy.

The mark keeps its shape. `DESIGN.md` re-reads it: the hypotenuse is the shortest path between where a team
already talks and the work getting done.

## Schema sketch

None.

## Actions and policy sketch

| Action | Route | RBAC | MCP | Audited |
|---|---|---|---|---|
| — | — | — | — | — |

No actions. The OAuth authorize page's theme is configuration (`WEB_SERVER_THEME`).

## Frontend and user docs

- **Public pages:**
  - `frontend/src/pages/marketing/HomePage.tsx` with 2.0 copy, under the hero "A teammate in every channel".
  - Three panels: mention it where you work → it remembers the channel → it hands code to a sandbox and answers
    with a PR.
- **Docs frame:** `frontend/src/content/docs/sections.ts` with one page, `getting-started.md`, and the frame's
  tests (`docs-sections`, `markdown-safety`, e2e `docs.spec.ts`).
- **Illustrations:** live in `public/doc-assets/illustrations/`, captured in both themes by
  `bun run docs:illustrations`.
- **Social card:** `frontend/public/social.png`, redrawn by `bun run social:image` with the new copy.

## Steps

### 1. Generator outputs — `bun run --cwd frontend theme:build`

- Add `--status-idle` to `design/tokens.ts`'s status set and `CONTRAST_PAIRS`.
- Regenerate every output listed in [`design/README.md`](https://github.com/arcadeai-labs/hypotenuse/blob/v1/design/README.md).
- `theme:check` joins frontend lint.

### 2. Kit and primitives — `frontend/src/ui/**`

Port v1's kit. `ui-api-parity.test.ts` keeps ToolExec's frozen export list, so pages copied in phase 04 drop in
unchanged.

### 3. Glyphs and badge — `frontend/src/ui/glyphs/`, `frontend/src/ui/BotBadge.tsx`, `frontend/src/ui/PlatformChip.tsx`

The state table above as components. `StatusGlyph` takes a `ConversationState` plus the `waitingOn` kind.

### 4. Shell — `frontend/src/components/{AppShell,shell/*}`, `frontend/src/context/ThemeContext.tsx`

The sidebar, the organization and project switchers (fixtures until phase 04), the mobile sheet, the keymap, and
the command palette.

### 5. Public frame and style guide — `frontend/src/pages/{marketing,docs,style-guide}/**`

`/style-guide` renders every primitive and every 2.0 surface from `styleGuideFixtures.ts`, in both themes side by
side.

### 6. OAuth theme and CLI palette — `backend/theme/hypotenuse-theme.ts`, `cli/src/output/theme.ts`

Port both, plus their tests. The CLI glyph module exports the same state names as the web glyphs.

### 7. `DESIGN.md`

Rewrite the glyph table, the bot badge, the layout, and the signature surfaces. Drop the runner fleet and the "four
surfaces" numbering where it no longer fits. Grep `docs/` and `AGENTS.md` for every description of a glyph or the
shell, and fix them in the same commit.

## Test plan

- **Frontend unit tests:** v1's guard tests ported unchanged, plus:
  - `glyphs.test.ts`: every `ConversationState × waitingOn` pair maps to exactly one glyph and token, as a whole-set
    comparison against a literal map;
  - `bot-badge.test.ts`: a bot avatar without the badge is impossible to render through the kit.
- **e2e:** `theme.spec.ts` (no flash, choice remembered), `shell.spec.ts`, `keyboard.spec.ts`, `home.spec.ts`,
  `docs.spec.ts`.
- **Backend:** `authorize-theme.test.ts`.
- **CLI:** `theme.test.ts`.

## Verification

```bash
cd frontend && bun run theme:check && bun run lint && bun test && bun run build && bun run test:e2e
open http://localhost:3000/style-guide       # look at both themes before opening the PR
bun run docs:illustrations                   # light + dark screenshots
```

Green is not the same as right. Look at both themes in `/style-guide` before pushing, then turn whatever you caught
into a test (v1's serif lesson).

## Definition of done

- [x] Every generator output is regenerated from unchanged inputs, plus the additive `--status-idle`
- [x] The UI kit passes `ui-api-parity` against ToolExec's export list
- [x] Conversation-state glyphs, the bot badge, and platform chips, in web and CLI, with the same state names
- [x] The shell has the organization and project switchers and 2.0's sidebar; disabled destinations never name a phase
- [x] `/style-guide` shows every 2.0 surface with fixtures in both themes
- [x] The marketing home, the docs frame, and the social card carry 2.0 copy
- [x] `DESIGN.md` describes 2.0's surfaces; no doc still describes the runner fleet
- [x] Every guard test passes; e2e runs in the CI gate as **E2E Test**

## Open questions

- Whether the memory explorer's decay indicator is a glyph or a bar. Settle it with fixtures in `/style-guide`
  before [phase 09](./phase-09-memory.md) builds the page.

## Learnings from the build

### What is built

Every Definition of done item. `/style-guide` renders every primitive and every 2.0 surface from fixtures, in both
themes side by side; the browser suite (31 specs) runs as **E2E Test** inside the CI gate and boots only Vite.

| Piece | Where |
|---|---|
| Generator outputs, plus `--status-idle` | `design/tokens.ts`; `theme:check` is the first step of frontend lint |
| The state table, shared by web and CLI | `design/states.ts` |
| UI kit (ToolExec's API) and v1's primitives | `frontend/src/ui/**`; `ui-api-parity.test.ts` holds ToolExec's frozen list |
| Glyphs, `StatusGlyph`, `SandboxJobGlyph`, `BotBadge`, `PlatformChip` | `frontend/src/ui/{glyphs,StatusGlyph,BotBadge,PlatformChip}*` |
| Shell, switchers, keymap, palette | `frontend/src/components/{AppShell,shell/*}`, `frontend/src/commands/*` |
| The signature surfaces, fixture-driven | `frontend/src/components/surfaces/*`, `frontend/src/pages/styleGuideFixtures.ts` |
| Public frame, docs frame, social card | `frontend/src/pages/{marketing,docs}`, `frontend/scripts/*` |
| OAuth page theme test | `backend/__tests__/oauth/authorize-theme.test.ts` |
| CLI palette and glyphs | `cli/src/output/{theme,tty}.ts` (not yet wired into a command) |

### Decisions the plan left open

- **The state names live in `design/states.ts`, not in the frontend.** The plan said the dashboard and the CLI
  import "the same names"; the CLI may not import `frontend/`, and `design/` is the one directory every workspace may
  read. It holds the states, the glyph kinds (token, Unicode, ASCII), and each status's words — and is hand-written,
  not generated. When the conversation schema lands, the server's enum should be checked against it.
- **Glyphs are keyed by kind, statuses by key.** Eight glyph kinds (`working`, `hibernating`, `waiting-person`,
  `waiting-system`, `complete`, `failed`, `provisioning`, `stale`) serve eight conversation statuses
  (`waiting:approval`, `ended:failed`, …) and four sandbox job states. The plan's table had no row for a finished
  sandbox job; `complete` and `failed` reuse the ended glyphs. The stale glyph's CLI shape is `◦`, because `◌` is
  provisioning's.
- **`StatusGlyph` takes the server's union**, `{ state: "waiting", waitingOn: "approval" }`, spread as props, and
  labels itself with what it waits on.
- **The bot badge is the `bot` tag on the accent tint, beside the avatar,** and a bot's monogram is a rounded square
  on `--accent-subtle`. `text-primary` on `accent-subtle` joined `CONTRAST_PAIRS`. Avatar's `agent?: string` became
  `bot?: boolean`; `bot-badge.test.ts` asserts the badge on every bot render and that nothing outside the kit paints
  `ui-avatar`.
- **Disabled destinations are one list.** `components/shell/destinations.ts` holds each destination's route, icon,
  `g` shortcut, and `available`. A destination that is not available renders as a `span` with `aria-disabled` and
  `title="Not available yet"`, and its palette command's `when` hides it, so its keys do nothing. Every destination is
  unavailable today; each page's phase flips one flag. The shell has no `can()` yet — `may` answers `false` — and
  [phase 04](./phase-04-organizations-users-and-rbac.md) replaces that and `shell/shellFixtures.ts`.
- **The switchers take props.** `OrganizationSwitcher` and `ProjectSwitcher` read `ShellData` (fixtures: Acme, with
  Support and Platform); Members and New project are disabled items. The account menu's Account and Sign out are
  disabled, not absent.
- **`/docs` opens the first page** by redirect, since there is one page and no index. A page embeds a themed
  screenshot as `![alt](illustration:<name>)`.
- **The decay indicator stays open.** `DecayMeter` draws both a bar and a shrinking ring; the explorer defaults to
  the bar, and `/style-guide` shows both for [phase 09](./phase-09-memory.md) to settle.
- **The home page says "In development"** in a chip above the hero, so a visitor does not read the panels as shipped.

### Traps found while building

- **react-markdown blanks a URL scheme it does not know.** `illustration:shell` reached the `img` override as `""`,
  so the docs page drew an empty image with every unit test green; the browser console said so. `MarkdownBlock` now
  passes a `urlTransform` that keeps `illustration:` only with `diagrams` and defers to `defaultUrlTransform`
  otherwise. `docs.spec.ts` asserts the image's `src` follows the app's theme and that it loaded.
- **JetBrains Mono's ligatures rewrote code.** `=>` drew as `⇒` and `===` as one glyph in a `run_code` program —
  seen only in a 2× screenshot. Code, `kbd`, `pre`, and `.mono` now set `font-variant-ligatures: none`, and
  `fonts.test.ts` asserts it.
- **A chip in a flex column stretches to the column.** The hero's "In development" chip ran the width of the copy;
  `home.spec.ts` now holds its width under a third of the lede's.
- **The writing rule's tagline is verbatim.** A paraphrase in the lede slipped past review of the copy;
  `social.test.ts` now holds the tagline to the descriptions, the home page's `TAGLINE`, and the social card.
- **`WEB_SERVER_THEME` unset is silent.** Keryx serves its default palette with no warning, so the authorize-theme
  test failed until `backend/.env.example` named the theme file; `render.yaml` already did for staging.
- **`renderToString` of the whole app needs a `window`.** The theme provider and the shell read `matchMedia` while
  they first render; `routes.test.tsx` stubs one rather than making client-only code SSR-safe.
- **Playwright's browser must match its version.** A preinstalled Chromium of another revision is reached with
  `PLAYWRIGHT_CHROMIUM_PATH`; CI installs the matching one.

### What the port left for later

v1's `_dashboard.scss` (runner fleet, the session transcript's styles), `PresenceDot`, `CapacityBar`, and
`RoleChip` are gone. ToolExec's page-frame styles (`_pages.scss`) are kept without the notification bell's, and the
auth card styles stay in `_public.scss` for sign-in. `NotificationBell`, `LiveSocketContext`, `NotificationContext`,
`AuthContext`, the skeletons, and the section components arrive with the pages that need them. The generator still
writes v1's `--status-stopping`, `--runner-*`, and `--role-*` tokens; dropping them is an input change nothing has
needed yet. `apple-touch-icon.png` is still not generated.
