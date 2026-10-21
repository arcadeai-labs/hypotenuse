# Design

How Hypotenuse looks and reads, on every surface it has: the dashboard, the public site and `/docs`, the Keryx
OAuth page, and the `hypotenuse` CLI. This is a live document (rule 14 in [`AGENTS.md`](../AGENTS.md)). It describes
the design language as it is meant to be, and once built, as it is. The plan that builds it is
[`phase-03-design-system.md`](./plans/phase-03-design-system.md).

## Direction: a quiet companion to Linear

People open Hypotenuse *from* Linear and go back *to* Linear. The dashboard should feel like the same kind of tool:
calm surfaces, small and precise type, a list as the primary shape, and status you can read from a glyph before you
read a word. Where ToolExec is a dense midnight operator console, Hypotenuse is a **Linear-native** companion.

That means *echo, never clone*:

- We share Linear's **grammar**: a left sidebar, list views with grouped rows, a properties panel beside a detail
  view, circular status glyphs, a command palette, and keyboard-first navigation.
- We do **not** use Linear's logo, its icons, its exact palette, or its product names for our own surfaces. Status
  glyphs are drawn by us. The accent is not Linear's indigo. Where we refer to Linear, we follow
  [Linear's brand guidelines](https://linear.app/brand) and say "for Linear" / "works with Linear".

Principles, in priority order:

1. **State first.** Every row and every page answers *what is happening and who is doing it* — a session's status,
   which runner holds it, which agent and role — before anything else.
2. **Agents are always visibly agents** (Linear's AIG principle 1). An agent-authored line carries the agent badge.
   A human prompt never looks like agent output, and vice versa.
3. **Quiet by default, loud only for a person.** Color is spent on what needs a human: an elicitation waiting for an
   answer, an error, a runner going offline mid-turn. Everything else is greyscale and weight.
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
plus `design/tokens.json` for the CLI and the Keryx OAuth page. Nobody edits a generated hex by hand. Changing the
look means changing an input.

| Input | Light | Dark |
|---|---|---|
| base | LCH ≈ `98 1.5 260` (paper with a faint cool tint) | LCH ≈ `9 2 265` (near-black, cool) |
| accent | **Hypotenuse teal**, LCH ≈ `58 38 195` | same hue, lifted to L ≈ `70` |
| contrast | 30 (default) | 30 (default) |

The accent is a teal deliberately far from Linear's indigo, so a Hypotenuse surface is never mistaken for Linear's.
It is one input; changing it regenerates both themes.

### Tokens

Semantic tokens only. A component never names a raw color.

| Token | Use |
|---|---|
| `--bg-app`, `--bg-panel`, `--bg-raised`, `--bg-sunken`, `--bg-hover`, `--bg-selected` | surfaces, from app ground to selected row |
| `--border-subtle`, `--border-default`, `--border-strong` | hairlines, inputs, focus-adjacent edges |
| `--text-primary`, `--text-secondary`, `--text-tertiary`, `--text-disabled`, `--text-on-accent` | the text ramp |
| `--accent`, `--accent-hover`, `--accent-subtle` | primary actions, links, selection |
| `--focus-ring` | the 2px ring around a focused control |
| `--status-pending`, `--status-active`, `--status-waiting`, `--status-complete`, `--status-error`, `--status-stale`, `--status-stopping` | agent session state (below) |
| `--runner-online`, `--runner-offline`, `--runner-draining` | runner presence |
| `--role-manager`, `--role-worker` | role chips |
| `--diff-add`, `--diff-remove` | diff summaries in action results |

`frontend/src/__tests__/contrast.test.ts` computes WCAG 2.1 contrast for every text/background pair the components
use, in **both** themes, and fails below 4.5:1 for body text and 3:1 for large text, glyphs, and focus rings.

### Theme selection

- `data-theme="light" | "dark"` on `<html>`. The default follows `prefers-color-scheme`.
- The person can pick Light, Dark, or System from the account menu or `⌘K`. The choice is a property of the browser
  and lives in `localStorage` (`hypotenuse.theme`), as ToolExec's phase 25 settled.
- A **pre-paint boot script** in `index.html` sets the attribute before first paint, so there is no flash of the
  wrong theme. It is inline, tiny, and covered by `e2e/theme.spec.ts`.
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
- Issue identifiers (`ENG-142`) are Inter Medium in `--text-secondary`. They are not monospaced, because Linear does
  not set them that way.
- Every size is a ratio of `--font-size` (13px). A literal `rem` font-size in a component rule is a bug, and a source
  scan test enforces it. This is ToolExec's rule, kept.

## Space, shape, motion

- **4px grid.** Spacing tokens `--space-1 … --space-8` = 4, 8, 12, 16, 20, 24, 32, 40px.
- **Radius:** 6px controls, 8px panels and cards, 999px chips and avatars.
- **Elevation:** light uses soft two-layer shadows. Dark uses no shadows, only a lighter `--bg-raised` and a hairline.
- **List rows:** 36px. Compact tables: 32px. The sidebar item: 28px.
- **Motion:** 120ms ease-out for hover and press, 180ms for panels. The only continuous animation is the *active*
  status glyph's slow rotation, and `prefers-reduced-motion` stops it.

## Iconography and glyphs

- **Icons:** [Lucide](https://lucide.dev) (ISC), 16px, 1.5px stroke, `currentColor`. Imported per icon, never as a
  whole set.
- **Status glyphs are ours**, drawn as 14px SVG components in `frontend/src/ui/glyphs/`. The CLI renders the same
  shapes with Unicode fallbacks. One shape language covers session state:

| Session status | Glyph | CLI | Token |
|---|---|---|---|
| `pending` | dotted ring | `◌` | `--status-pending` |
| `active` | ring with a quarter arc (slow spin) | `◔` | `--status-active` |
| `awaitingInput` | ring with a centre dot | `◉` | `--status-waiting` |
| `complete` | filled disc with a check | `✓` | `--status-complete` |
| `error` | filled disc with a cross | `✕` | `--status-error` |
| `stale` | dashed ring, faded | `◌` (dim) | `--status-stale` |
| `stopping` | ring around a small square | `◘` | `--status-stopping` |

  Runner presence uses a solid dot (online), a hollow dot (offline), and a half dot (draining). Roles use a
  rounded-square chip: **M** for manager and **W** for worker, tinted with `--role-*`.
- **The mark.** A right triangle, `◢`, whose hypotenuse runs from Linear (top right) to your machine (bottom left).
  It is drawn as an SVG at `design/mark.svg`, with a one-color version for favicons and the CLI banner. The wordmark is
  "Hypotenuse" in Inter Display 600.
- **Agent badge.** A small "agent" chip with the agent kind (`claude`, `codex`, …) is shown on every avatar that
  stands for an agent. This applies in the transcript, the session list, and the runner view.

## Layout and navigation

```
┌──────────────┬───────────────────────────────────────────────────────────────┐
│ ◢ Hypotenuse │  Sessions                         [Filter] [Display]  ⌘K       │
│ acme ▾       ├───────────────────────────────────────────────────────────────┤
│              │  ▾ Waiting for you · 1                                         │
│  Home        │  ◉  ENG-139  PRD: Billing v2              M  claude  evan-mbp  │
│  Sessions  7 │  ▾ Running · 3                                                 │
│  Runners   4 │  ◔  ENG-142  Add retry to webhook ingress W  codex   ci-box-2  │
│  Routing     │  ◔  ENG-151  Fix flaky invite test         W  claude  evan-mbp  │
│              │  ▾ Done today · 12                                             │
│  Settings    │  ✓  ENG-120  Paginate audit list           W  codex   mia-desk  │
│  Docs ↗      │                                                                │
└──────────────┴───────────────────────────────────────────────────────────────┘
```

- **Sidebar** (240px, collapsible to icons at `[`): project switcher, Home, Sessions, Runners, Routing, Settings,
  Docs. Counts are live. The switcher's menu also holds Invites, Audit log, and New project; the foot holds the
  notification bell and the account menu, so both work collapsed.
- **List views**, grouped by status with "Waiting for you" first. A *Display* menu chooses grouping (status, runner,
  role, person) and ordering. Filters are chips.
- **Detail views** use a main column plus a 280px **properties panel**: status, role, runner, agent, repository,
  branch, issue link, Linear session link, PR links, timings.
- **Keyboard:** `⌘K` command palette (built on `cmdk`), `g h/s/r/o` to go to Home, Sessions, Runners, or Routing,
  `j`/`k` to move, `enter` to open, `esc` to go back, `/` to search, and `?` for the shortcut sheet.
- **Below 768px** the sidebar becomes a sheet (closed by an ✕, with finger-sized rows), the properties panel moves
  under the main column, and lists keep one line per row by dropping secondary columns. They do not wrap. The docs
  section nav folds behind a button naming the current section, pinned under the top bar, and a wide markdown table
  scrolls inside itself rather than widening the page. Below 1100px the docs' "On this page" rail is dropped first.
- ToolExec's loading rules carry over unchanged: three loading states (`useFirstLoad`), no denial rendered before
  standing is known, and skeletons only before the first answer.

## The four signature surfaces

### 1. The session transcript

The page people spend time on. It is a **log, not a chat**, the same conclusion ToolExec reached in
`TRANSCRIPT_UI.md`. Its source is the mirrored `agent_activities` rows, so it shows exactly what Linear shows, plus
what only Hypotenuse knows: which runner, which agent, and how long each turn took.

```
┌ ENG-142 · Add retry to webhook ingress ─────────────────────┬ Properties ──────┐
│ ── Turn 1 · evan-mbp · codex · 6m 12s ───────────────────── │ ◔ Active         │
│ (EV) Evan  @hypotenuse please take this                     │ W Worker         │
│ ◢  Picked up on evan-mbp. Working in hypotenuse/eng-142…    │ evan-mbp · codex │
│ ┌ Plan ────────────────────────────────────────────────┐    │ acme/web         │
│ │ ✓ Read the ingress handler                            │    │ hypotenuse/eng-… │
│ │ ◔ Add exponential backoff                             │    │ Linear session ↗ │
│ │ ○ Write tests                                         │    │ PR #418 ↗        │
│ └───────────────────────────────────────────────────────┘    │                  │
│ ▸ Searched  backend/actions/webhooks/**            0.4s      │                  │
│ ▸ Edited    backend/ops/LinearWebhookOps.ts  +42 −7          │                  │
│ ··· thinking: the retry should key on Linear-Delivery …      │                  │
│ ┌ Needs your answer ───────────────────────────────────┐    │                  │
│ │ Allow `bun test` to run?   [Allow once] [Deny]  ↗    │    │                  │
│ └───────────────────────────────────────────────────────┘    │                  │
└──────────────────────────────────────────────────────────────┴──────────────────┘
```

- **Turn separators** carry the work item: runner, agent, role, duration, and outcome.
- **Prompts** (human) are set flush with an avatar. **Agent lines** carry the `◢` mark and agent badge.
- **Thoughts** are tertiary text, collapsed to one line with a `···` lead and expandable. An **ephemeral** thought or
  action renders as the single live line at the bottom and is replaced in place, as Linear does.
- **Actions** are one row: verb, parameter in mono, and duration. They expand to the result. Diff results show
  `+n −m` in `--diff-*`.
- **The plan** is a checklist card pinned at the top of the turn that last changed it, using the same glyphs.
- **Elicitations** are the only accented card: `--status-waiting` border and options as buttons. Answering happens
  **in Linear** (the button deep-links to the session), because Linear is where a prompt has to come from. The
  dashboard never fakes a human prompt.
- **Responses** render through `MarkdownBlock` (no raw HTML). **Errors** are tinted `--status-error` and say what to
  do next.
- **It follows.** The view sticks to the bottom while the reader is at the bottom, and stays put when they scroll
  up. This is ToolExec's `useStickToBottom` rule.

### 2. The runner fleet

Runners answer "who can take work right now". There are two views of the same data, toggled with `v`:

- **Cards** (default), grouped by owner. Each card shows the runner name, owner avatar, presence dot, version (with
  an "update available" chip when behind npm's latest), and a **capacity bar**. The bar has one segment per slot, and
  each filled segment is labelled with the issue it is working on and links there. Below that: agent chips, role
  chips, repository names, subscriptions, and "last heartbeat 4s ago" in tabular numbers.
- **Table**, for many runners: the same fields, one 32px row each, sortable.

A runner that goes offline mid-turn turns its live segments `--status-stale` and lists the affected sessions. That
is the one moment this page raises its voice.

### 3. The public site and `/docs`

- **Home** (`/`): a short hero, "Your agents, your machines, inside Linear", over a diagram of the triangle: Linear at
  the top right, your machine at the bottom left, and Hypotenuse as the shortest path between them. Below it are
  three panels (delegate → it works where your code is → it answers in the session), a manager/worker explainer, a
  supported-agents strip (names as text, not logos), install commands with copy buttons, and security points
  (credentials stay home, Linear tokens stay on the server).
- **Docs** (`/docs`): left section nav, an article column capped at 72ch, and a right-hand "on this page" rail.
  Content is markdown under `frontend/src/content/docs/` (rule 12). Every code block has a copy button. Screenshots are
  **generated in both themes** by `bun run docs:illustrations`, and a `<picture>` element picks the one that matches
  the reader's theme.
- Both are outside `ProtectedRoute` and readable signed out.

### 4. The CLI

The terminal gets the same palette and the same glyphs, degraded properly:

- `cli/src/output/theme.ts` reads `design/tokens.json` at build time and uses truecolor when the terminal supports
  it, the nearest 256-color index otherwise, and no color under `NO_COLOR`, `--no-color`, `--json`, or a non-TTY.
  These are mcpx's `early-env` and `tty` rules, kept.
- Glyphs as in the status table above, with ASCII fallbacks (`o * ? v x`) when the locale is not UTF-8.
- Tables are borderless, with dim column headers and right-aligned numbers. Long values (paths, branch names) are
  truncated in the middle, not the end.
- One spinner style (nanospinner) for anything longer than 300ms, always on stderr.
- `hypotenuse` with no arguments prints a one-line banner (`◢ hypotenuse 1.4.0`), not ASCII art. `--version`
  prints the bare version, because scripts and the self-upgrader parse it.

```
$ hypotenuse daemon status
◢ hypotenuse 1.4.0 · runner evan-mbp · ● online · acme

  SESSIONS  2 of 3 slots
  ◔ ENG-142  Add retry to webhook ingress   W codex   6m12s  hypotenuse/eng-142-add-retry
  ◉ ENG-139  PRD: Billing v2                M claude  waiting on Evan

  AGENTS    claude ✓  codex ✓  gemini ✕ not logged in (hypotenuse doctor --agent gemini)
  REPOS     acme/web  acme/api
```

## Writing

- Sentence case everywhere (buttons, headings, menu items).
- Name the actor: "codex on evan-mbp is working on ENG-142", not "Processing…".
- Empty states say what would make them non-empty and offer the command or button that does it.
- Errors say what happened and what to do next, in that order.
- Agent-facing text written into Linear follows the same rules, and is shorter.
