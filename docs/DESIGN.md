# Design

How Hypotenuse looks and reads, on every surface it has: the dashboard, the public site and `/docs`, the Keryx
OAuth page, and the `hypotenuse` CLI. This is a live document (rule 14 in [`AGENTS.md`](../AGENTS.md)): it describes
the design system as built. The plan that built it is [`phase-03-design-system.md`](./plans/phase-03-design-system.md);
`/style-guide` renders every primitive and every surface below, in both themes side by side.

## Direction: a quiet companion to where your team works

People reach a bot from Slack, Linear, or Pylon and go back there. The dashboard is where a project is configured
and watched, so it should feel like the same kind of tool as the places it serves: calm surfaces, small and precise
type, a list as the primary shape, and state you can read from a glyph before you read a word.

That means *echo, never clone*:

- We share the **grammar** of modern work tools: a left sidebar, list views with grouped rows, a properties panel
  beside a detail view, circular status glyphs, a command palette, and keyboard-first navigation.
- We do **not** use any platform's logo, icons, exact palette, or product names for our own surfaces. Platforms are
  named as text in a neutral chip (`Slack`, `Linear`, `Pylon`, `API`). Status glyphs are drawn by us.

Principles, in priority order:

1. **State first.** Every row and every page answers *what is happening and who is doing it* — a conversation's
   state, what it waits on, which bot holds it, and where it lives — before anything else.
2. **A bot is always visibly a bot.** Every avatar that stands for a bot carries the **bot** badge, in the
   dashboard, in the CLI, and in a screenshot. A person's message never looks like a bot's, and vice versa.
3. **Quiet by default, loud only for a person.** Color is spent on what needs a human: a question or an approval
   waiting, an error. Everything else is greyscale and weight.
4. **Two themes, one design.** Light and dark are generated from the same inputs. Neither is the "real" one; both are
   tested.
5. **Dense, not cramped.** About 13px body type and 36px list rows. Whitespace separates groups, not every element.
6. **Keyboard reachable.** Anything a pointer can do, a keyboard can do. `⌘K` reaches every page and every action the
   person is allowed to take.

## Color

### Generated, not hand-picked

Themes are generated in **LCH** from three inputs, the same idea Linear describes for its own themes: a **base**
(the neutral ground), an **accent**, and a **contrast** level. `design/tokens.ts` holds the inputs and the
generator. `bun run --cwd frontend theme:build` writes `frontend/src/styles/_tokens.generated.scss` for both themes,
`design/tokens.json` for the CLI, `backend/theme/hypotenuse-theme.ts` for the Keryx OAuth page, the mail palette, and
every rendering of the mark; [`design/README.md`](../design/README.md) lists them. `theme:check` is part of frontend
lint and fails on any stale output. Nobody edits a generated hex by hand. Changing the
look means changing an input.

| Input | Light | Dark |
|---|---|---|
| base | LCH ≈ `98 1.5 260` (paper with a faint cool tint) | LCH ≈ `9 2 265` (near-black, cool) |
| accent | **Hypotenuse teal**, LCH ≈ `58 38 195` | same hue, lifted to L ≈ `70` |
| contrast | 30 (default) | 30 (default) |

The accent is a teal deliberately far from any platform's brand color, so a Hypotenuse surface is never mistaken
for Slack's, Linear's, or Pylon's. It is one input; changing it regenerates both themes.

### Tokens

Semantic tokens only. A component never names a raw color.

| Token | Use |
|---|---|
| `--bg-app`, `--bg-panel`, `--bg-raised`, `--bg-sunken`, `--bg-hover`, `--bg-selected` | surfaces, from app ground to selected row |
| `--border-subtle`, `--border-default`, `--border-strong` | hairlines, inputs, focus-adjacent edges |
| `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-disabled`, `--text-on-accent` | the text ramp |
| `--accent`, `--accent-hover`, `--accent-subtle` | primary actions, links, selection |
| `--focus-ring` | the 2px ring around a focused control |
| `--status-active`, `--status-idle`, `--status-waiting`, `--status-pending`, `--status-complete`, `--status-error`, `--status-stale` | conversation and sandbox job state ([below](#status-glyphs)) |
| `--diff-add`, `--diff-remove` | diff summaries in tool results |

`--status-idle` is the calm cool tone of a hibernating conversation, solved like the other state colors. The
generator still writes v1's `--status-stopping`, `--runner-*`, and `--role-*`: removing them is an input change, and
nothing paints with them.

`frontend/src/__tests__/contrast.test.ts` computes WCAG 2.1 contrast for every pair in `CONTRAST_PAIRS`, in **both**
themes, and fails below 4.5:1 for body text and 3:1 for glyphs and focus rings. Text and state colors are solved
against every ground they sit on, and the worst ground decides. `no-raw-colors.test.ts` refuses a color literal
anywhere in `frontend/src` outside the generated file.

### Theme selection

- `data-theme="light" | "dark"` on `<html>`. The default follows `prefers-color-scheme`.
- The person can pick Light, Dark, or System from the account menu or `⌘K`. The choice is a property of the browser
  and lives in `localStorage` (`hypotenuse.theme`).
- A **pre-paint boot script** in `index.html` sets the attribute before first paint, so there is no flash of the
  wrong theme. It is inline, tiny, and covered by `e2e/theme.spec.ts`. `ThemeContext` owns the same key afterwards and follows the OS live while the
  choice is System.
- The Keryx OAuth authorize page follows `prefers-color-scheme` only. It has no script and no storage, and it is
  rendered from the same generated tokens.

## Typography

| Role | Face | Size / line | Weight |
|---|---|---|---|
| UI body | **Inter Variable** (self-hosted, `@fontsource-variable/inter`), `font-feature-settings: "cv11", "ss01"` | 13px / 20px | 400, 500 |
| Meta, captions, table headers | Inter | 12px / 16px | 500 |
| Page title | Inter Display (Inter's `opsz` axis) | 20px / 28px | 600 |
| Section title | Inter | 15px / 22px | 600 |
| Marketing display | Inter Display | 48–64px / 1.05 | 650, tight tracking `-0.02em` |
| Code, ids, branch names, paths | **JetBrains Mono** (`@fontsource-variable/jetbrains-mono`) | 12px / 18px | 400 |

- Numbers that change in place (counts, durations, capacity) use `font-variant-numeric: tabular-nums`.
- Platform identifiers (`ENG-142`, `#billing`) are Inter Medium in `--text-secondary`, never monospaced.
- Code shows the characters typed: JetBrains Mono's ligatures are off, so `=>` in a `run_code` program stays `=>`.
- Every size is a ratio of `--font-size` (13px). A literal `rem` font-size in a component rule is a bug, and a source
  scan test enforces it. This is ToolExec's rule, kept.

## Space, shape, motion

- **4px grid.** Spacing tokens `--space-1 … --space-8` = 4, 8, 12, 16, 20, 24, 32, 40px.
- **Radius:** 6px controls, 8px panels and cards, 999px chips and avatars.
- **Elevation:** light uses soft two-layer shadows. Dark uses no shadows, only a lighter `--bg-raised` and a hairline.
- **List rows:** 36px. Compact tables: 32px. The sidebar item: 28px.
- **Motion:** 120ms ease-out for hover and press, 180ms for panels. The only continuous animation is the *active*
  glyph's slow rotation, and `prefers-reduced-motion` stops it.

## Iconography and glyphs

- **Icons:** [Lucide](https://lucide.dev) (ISC), 16px, 1.5px stroke, `currentColor`. Imported per icon, never as a
  whole set.
- **Status glyphs are ours**, drawn as 14px SVG components in `frontend/src/ui/glyphs/`. The CLI prints the same
  shapes as Unicode, with ASCII fallbacks.

### Status glyphs

The shape language: **rings** are in progress, **discs** are finished, a **centre dot** means a person is needed.
The names live in `design/states.ts`, which both the web kit and the CLI palette import, so a renamed state is a type
error in both.

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
| sandbox job `complete` / `failed` | as `ended` | `✓` / `✕` | `--status-complete` / `--status-error` |
| a lease expired, not yet reclaimed | dashed ring, faded | `◦` | `--status-stale` |

`StatusGlyph` takes the state the server reports — `{ state: "waiting", waitingOn: "approval" }` — and labels itself
for screen readers with what it waits on. `hibernating` is the normal rest state, so it reads calm, not stale.

### The mark, the bot badge, platform chips

- **The mark.** A right triangle, `◢`. Its hypotenuse is the shortest path between where a team already talks and
  the work getting done. The generator draws it at `design/mark.svg`, as both favicons, as the API origin's icon,
  and as the OAuth page's artwork. The wordmark is "Hypotenuse" in Inter Display 600.
- **The bot badge.** A small chip reading **bot**, on the accent tint, with the bot's name beside it. `Avatar` draws
  it whenever `bot` is set and has no prop to hide it; nothing outside the kit draws an avatar. A bot without an
  uploaded image is a monogram on `--accent-subtle` in a rounded square — never a person-like default, and never
  the circle a person gets.
- **Platform chips.** `Slack`, `Linear`, `Pylon`, and `API`, as text in a neutral chip. No logos: text is legible in
  both themes and carries no trademark to get wrong.
- **Social card.** A shared link unfurls with `frontend/public/social.png`, named by `index.html`'s Open Graph and
  Twitter tags: the mark, the home page's headline and the tagline, and its triangle, on the dark theme so it holds
  its edge on either theme of the reader's client. `bun run --cwd frontend social:image` redraws it from
  `design/tokens.json`; it is a screenshot, so `theme:check` does not watch it — rerun it after changing the inputs
  or the home page's copy.

## Layout and navigation

```
┌──────────────┬──────────────────────────────────────────────────────────────┐
│ ◢ Hypotenuse │  Conversations                    [Filter] [Display]  ⌘K      │
│ Acme ▾       ├──────────────────────────────────────────────────────────────┤
│ Support ▾    │  ▾ Waiting for a person · 2                                   │
│              │  ◉  #billing   Refund for Globex?          bot Ada   Slack    │
│  Home        │  ◉  Initech    Which plan includes SSO?    bot Ada   Pylon    │
│  Conversations│ ▾ Working · 1                                                 │
│  Bots        │  ◔  ENG-142    Add retry to webhook ingress bot Kit  Linear   │
│  Memory      │  ▾ Waiting on work · 1                                        │
│  Sandboxes   │  ◷  Globex     Export fails on CSV          bot Ada  Pylon    │
│              │  ▾ Hibernating · 41                                           │
│  Settings    │  ○  #eng-help  How do I run e2e?            bot Kit  Slack    │
│  Docs        │                                                               │
└──────────────┴──────────────────────────────────────────────────────────────┘
```

- **Sidebar** (240px, collapsible to icons with `[`): the organization switcher, then the project switcher; Home,
  Conversations, Bots, Memory, Sandboxes; and in the foot Settings, Docs, and the account menu (who is signed in,
  the theme, sign-out), so all of it works collapsed. The organization switcher's menu holds the organization's
  members and, for an owner, New project.
- **A destination whose page does not exist yet is disabled, never absent**, and says *Not available yet* — never a
  plan or phase. Its `g` shortcut and palette command do nothing until the page ships, so the sidebar's shape never
  changes under a reader. `frontend/src/components/shell/destinations.ts` is the one list the sidebar, the palette,
  and the keymap read.
- **The sidebar is mounted in exactly one place**, chosen by a width check: the sticky column when wide, a sheet
  when narrow. A CSS-hidden second copy would duplicate every `nav-*` test id.
- **List views**, grouped by state with "Waiting for a person" first and Ended collapsed. A *Display* menu chooses
  grouping and ordering. Filters are chips.
- **Detail views** use a main column plus a 280px **properties panel**: state, bot, where it lives, the platform
  link, sandbox jobs, timings.
- **Keyboard:** `⌘K` command palette (built on `cmdk`, the one key honored while typing), `g h/c/b/m/s` to go to Home,
  Conversations, Bots, Memory, or Sandboxes, `j`/`k` to move, `enter` to open, `esc` to go back, `/` to search, `[`
  to collapse the sidebar, and `?` for the shortcut sheet. The keymap reads its context through a ref, so a
  re-render between `g` and its letter never drops the `g`.
- **Below 768px** the sidebar becomes a sheet (closed by an ✕, with finger-sized rows), the properties panel moves
  under the main column, and lists keep one line per row by dropping trailing chips. The docs section nav folds
  behind a button naming the current page, and a wide markdown table scrolls inside itself rather than widening the
  page. Below 1100px the docs' "On this page" rail is dropped first.
- ToolExec's loading rules carry over unchanged: three loading states, no denial rendered before standing is known,
  and skeletons only before the first answer.

## Signature surfaces

Each is a component in `frontend/src/components/surfaces/`, drawn from fixtures in `/style-guide` until the page
that reads real rows arrives. The components take their own props (`surfaces/types.ts`), not the server's rows, so a
page maps one onto the other and the component does not change.

### 1. The conversation transcript

A **log, not a chat**. Its source is `conversation_entries`: every message, model step, and tool call, in order.

```
┌ ENG-142 · Add retry to webhook ingress ─────────────────────┬ Properties ──────┐
│ (GH) Grace Hopper  Linear                                    │ ◔ Working        │
│      Webhook ingress drops deliveries when Redis blips…      │ (K) bot Kit      │
│ ··· thinking: the enqueue after the insert is the only…      │ Linear · ENG     │
│ ▸ memory_search  webhook retry                       0.2s    │ Session ↗        │
│ ┌ run_code ───────────────────────────────── 1.1s ┐          │                  │
│ │ const runs = await mcp.call("github", …)         │          │                  │
│ │ ▸ host  mcp.call("github", "list_runs")   0.8s   │          │                  │
│ └──────────────────────────────────────────────────┘          │                  │
│ ┌ ◉ Needs approval ────────────────────────────────┐          │                  │
│ │ ▸ mcp_exec  github.create_branch { … }            │          │                  │
│ │ Answer in Linear ↗                                │          │                  │
│ └──────────────────────────────────────────────────┘          │                  │
│ ┌ ◔ Sandbox  acme/api  kit/eng-142-retry ──────────┐          │                  │
│ │ │ ▸ Edit  backend/ops/IngressOps.ts       0.4s    │          │                  │
│ │ │ ▸ Run   bun run test                    41s     │          │                  │
│ └──────────────────────────────────────────────────┘          │                  │
│ (K) bot Kit  Opened **Retry the enqueue…** A delivery that…  │                  │
└──────────────────────────────────────────────────────────────┴──────────────────┘
```

- **Messages** carry the participant's platform name, avatar, and a platform chip. **Bot lines** carry the bot's
  avatar and badge, and render through `MarkdownBlock` (no raw HTML).
- **Thinking** is tertiary text, collapsed to one `···` line.
- **Tool calls** are one row: verb, parameter in mono, duration. A call whose intent is written and whose result is
  not spins as the live row.
- **`run_code`** is a card with the program and one row per host call it made.
- **Sandbox jobs** are nested cards: the job's state glyph, repository, and branch, then its own steps indented
  under a rule, then the pull request it opened.
- **Questions and approvals are the only accented cards** (`--status-waiting` border). A question is answered
  **where it was asked**: the card deep-links to the Slack thread, Linear session, or Pylon issue, because the
  platform's own permissions decide who may answer. The dashboard never offers a button that would bypass them.
- **Errors** are tinted `--status-error` and say what to do next.
- **It follows.** The view sticks to the bottom while the reader is at the bottom, and stays put when they scroll up.

### 2. The bot page

Identity first — the avatar with its badge, the name, the persona — then **where it listens** (its channel bindings,
one row per platform, with "Not bound in …" where it has none), its **tools** (memory, code mode, and sandboxes as
on/off chips; MCP servers and skills by name), its **model** (the registry name and the connection behind it), and
**who may read and change it** (its `accessRead` and `accessWrite` tags).

### 3. The memory explorer

Scope, then document, then versions. Scopes are the project and each channel, with its platform chip and a count.
Each document shows its newest version and how faded it is; each version names the bot that wrote it and links to
the conversation entry it came from, and a promoted fact says which channel it was promoted from. The decay
indicator is drawn both as a short bar and as a shrinking ring in `/style-guide`; which one the explorer keeps is an
open question for the memory plan.

### 4. The public site and `/docs`

- **Home** (`/`): an "In development" chip and the hero, "A teammate in every channel", with the tagline as its lede,
  over the triangle: where your team talks at the top right, the work done at the bottom left, and Hypotenuse as the
  shortest path between them. Below it are three panels (mention it where you work → it remembers the channel → it
  hands code to a sandbox and answers with a PR), where it answers (platforms as text), the bot badge, and security
  points.
- **Docs** (`/docs`, which opens the first page): left section nav, an article column capped at 72ch, and a
  right-hand "on this page" rail. Content is markdown under `frontend/src/content/docs/` (rule 12). Every code block
  has a copy button. Screenshots are **generated in both themes** by `bun run docs:illustrations` into
  `public/doc-assets/illustrations/`, and a page embeds one as `![alt](illustration:<name>)`, which `ThemedImage`
  draws in the **app's** theme — not the OS's, which a `<picture>` would follow. A diagram is a ```` ```mermaid ````
  fence, never ASCII art: `DocsPage` opts `MarkdownBlock` into `diagrams` (bot output never is), Mermaid is a
  dynamic import fetched only by a page that has one, and `MermaidDiagram` paints it from the live semantic tokens.
- Both are readable signed out.

### 5. The CLI

The terminal gets the same palette and the same glyphs, degraded properly:

- `cli/src/output/theme.ts` reads `design/tokens.json` at build time and uses truecolor when the terminal supports
  it, the nearest 256-color index otherwise, and no color under `NO_COLOR`, `--no-color`, `--json`, or a non-TTY. A
  flag on the command line beats an inherited `FORCE_COLOR`.
- Glyphs as in [the status table](#status-glyphs), from the same `design/states.ts`, with ASCII fallbacks
  (`* o ? ~ v x . -`) when the locale is not UTF-8.
- Tables are borderless, with dim column headers and right-aligned numbers. Long values (paths, branch names) are
  truncated in the middle, not the end.
- `hypotenuse` with no arguments prints a one-line banner (`◢ hypotenuse 2.0.0`), not ASCII art. `--version` prints
  the bare version, because scripts and the self-upgrader parse it.

A list, once the operator CLI has one, reads like this:

```
$ hypotenuse conversation list
  ◉ #billing   Refund for Globex?            bot Ada  Slack   waiting for approval
  ◔ ENG-142    Add retry to webhook ingress  bot Kit  Linear  working
  ○ #eng-help  How do I run e2e?             bot Kit  Slack   hibernating
```

## Writing

- **The tagline is "A persistent multiplayer, multichannel agent for your team."** Use it verbatim everywhere
  a one-line description appears: the README, the marketing home's lede, the Open Graph and Twitter descriptions,
  the social card, the npm package, and the CLI's `--help`. The home page's hero is "A teammate in every channel";
  `social.test.ts` holds the tagline to the tags, the home page, and the card.
- Sentence case everywhere (buttons, headings, menu items).
- Name the actor: "Kit is working on ENG-142", not "Processing…".
- Empty states say what would make them non-empty and offer the command or button that does it.
- Errors say what happened and what to do next, in that order.
- What a bot writes into Slack, Linear, or Pylon follows the same rules, and is shorter.
