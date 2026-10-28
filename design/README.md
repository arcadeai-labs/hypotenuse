# design/

The look of Hypotenuse, as **inputs**. Nothing here is a hand-picked hex.

`tokens.ts` holds three inputs per theme — a **base** (the neutral ground), an **accent**, and a **contrast** level,
all in LCH — and a generator that turns them into every semantic token the product uses. Text and state colors are
*solved* for a contrast target against the surfaces they are drawn on, so changing an input cannot make a theme
illegible: it moves the solved colors with it, and `CONTRAST_PAIRS` is what the frontend's contrast test walks.

```bash
bun run --cwd frontend theme:build   # regenerate every output below
bun run --cwd frontend theme:check   # fail if any output is stale (part of frontend lint)
```

| Output | Read by |
|---|---|
| `frontend/src/styles/_tokens.generated.scss` | the web app: `[data-theme="light"]` and `[data-theme="dark"]` blocks |
| `design/tokens.json` | the CLI palette, embedded into the compiled binary |
| `backend/theme/hypotenuse-theme.ts` | Keryx's OAuth authorize page (`WEB_SERVER_THEME`), light plus a `prefers-color-scheme` block |
| `design/mark.svg`, `frontend/public/favicon{,-dark}.svg` | the `◢` mark, in each theme's colors |
| `design/app-icon.png` | the mark as a 512 px opaque tile, for services that take a PNG — the Linear app's icon |
| `backend/assets/favicon.ico`, `backend/assets/favicon{,-dark}.svg` | the API origin's icon — MCP clients and favicon services ask the server's origin for `/favicon.ico`; the ICO is the light mark rasterized at 16–64 px |
| `backend/templates/lion.svg` | the mark on the OAuth page, painted from that page's own variables |

`states.ts` is the other input: the conversation and sandbox job states a status glyph stands for, and each one's
glyph, token, Unicode shape, and words. The web kit's `StatusGlyph` and the CLI palette both import it, so a renamed
state is a type error in both. It is hand-written, not generated.

**Never edit a generated file.** Change an input in `tokens.ts` and rebuild. `frontend/src/__tests__/tokens.test.ts`
compares every output with a fresh generation, so a hand edit fails CI.

This directory is not a workspace and has no dependencies, so `frontend/`, `cli/`, and `backend/` can each read it
without a dependency edge between them. The rationale is in [`docs/DESIGN.md`](../docs/DESIGN.md#color).
