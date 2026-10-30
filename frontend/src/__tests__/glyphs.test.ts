import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CONVERSATION_OUTCOMES,
  CONVERSATION_STATES,
  CONVERSATION_STATUS,
  type ConversationStatus,
  conversationStatusKey,
  GLYPH_KINDS,
  type GlyphKind,
  SANDBOX_JOB_STATES,
  SANDBOX_JOB_STATUS,
  WAITING_ON,
} from "../../../design/states";
import { GLYPH_COMPONENTS, SandboxJobGlyph, StatusGlyph } from "../ui";

const UI_SCSS = readFileSync(
  join(import.meta.dir, "..", "styles", "_ui.scss"),
  "utf8",
);
const TOKENS = readFileSync(
  join(import.meta.dir, "..", "styles", "_tokens.generated.scss"),
  "utf8",
);

/**
 * The shapes inside a rendered glyph, with the label and class stripped, so two
 * glyphs compare by what they draw.
 * @param markup - A rendered SVG.
 * @returns The inner markup.
 */
function shape(markup: string): string {
  return markup.slice(markup.indexOf(">") + 1);
}

/**
 * The token a glyph kind's `ui-glyph-*` rule paints with.
 * @param kind - The glyph kind.
 * @returns The custom property's name, without `--`.
 */
function paintedWith(kind: string): string | undefined {
  const rule = UI_SCSS.slice(UI_SCSS.indexOf(`.ui-glyph-${kind} {`)).split(
    "}",
  )[0];
  return rule?.match(/color: var\(--([a-z-]+)\)/)?.[1];
}

/** Every conversation status the server can report: each state, crossed with its detail. */
const EVERY_STATUS: ConversationStatus[] = CONVERSATION_STATES.flatMap(
  (state): ConversationStatus[] => {
    if (state === "waiting")
      return WAITING_ON.map((waitingOn) => ({ state, waitingOn }));
    if (state === "ended")
      return CONVERSATION_OUTCOMES.map((outcome) => ({ state, outcome }));
    return [{ state }];
  },
);

describe("conversation status glyphs", () => {
  test("every state × detail maps to exactly this glyph, token, and CLI shape", () => {
    // The whole table, literally: a new state or a moved glyph fails here.
    const actual = Object.fromEntries(
      EVERY_STATUS.map((status) => {
        const kind = CONVERSATION_STATUS[conversationStatusKey(status)].glyph;
        return [
          conversationStatusKey(status),
          [kind, paintedWith(kind), GLYPH_KINDS[kind].unicode],
        ];
      }),
    );
    expect(actual).toEqual({
      working: ["working", "status-active", "◔"],
      hibernating: ["hibernating", "status-idle", "○"],
      "waiting:answer": ["waiting-person", "status-waiting", "◉"],
      "waiting:approval": ["waiting-person", "status-waiting", "◉"],
      "waiting:sandbox": ["waiting-system", "status-pending", "◷"],
      "waiting:timer": ["waiting-system", "status-pending", "◷"],
      "ended:complete": ["complete", "status-complete", "✓"],
      "ended:failed": ["failed", "status-error", "✕"],
      "ended:cancelled": ["stale", "status-stale", "◦"],
    });
    expect(Object.keys(actual).sort()).toEqual(
      Object.keys(CONVERSATION_STATUS).sort(),
    );
  });

  test("every sandbox job state maps to exactly this glyph", () => {
    const actual = Object.fromEntries(
      SANDBOX_JOB_STATES.map((state) => [
        state,
        SANDBOX_JOB_STATUS[state].glyph,
      ]),
    );
    expect(actual).toEqual({
      provisioning: "provisioning",
      running: "working",
      complete: "complete",
      failed: "failed",
    });
  });

  test("the web paints each kind with the token the CLI uses", () => {
    for (const [kind, { token }] of Object.entries(GLYPH_KINDS)) {
      expect([kind, paintedWith(kind)]).toEqual([kind, token]);
      expect(TOKENS).toContain(`--${token}:`);
    }
  });

  test("every kind draws a different shape, so colour is never the only cue", () => {
    const kinds = Object.keys(GLYPH_KINDS) as GlyphKind[];
    const shapes = new Set(
      kinds.map((kind) =>
        shape(renderToStaticMarkup(createElement(GLYPH_COMPONENTS[kind]))),
      ),
    );
    expect(shapes.size).toBe(kinds.length);
    const cli = new Set(kinds.map((kind) => GLYPH_KINDS[kind].unicode));
    expect(cli.size).toBe(kinds.length);
  });

  test("a status glyph is labelled with what it waits on, not only its shape", () => {
    const markup = renderToStaticMarkup(
      createElement(StatusGlyph, { state: "waiting", waitingOn: "approval" }),
    );
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="Waiting for approval"');
    expect(markup).toContain('data-glyph="waiting-person"');
    expect(markup).not.toContain("waitingOn");
  });

  test("a sandbox job glyph is labelled", () => {
    const markup = renderToStaticMarkup(
      createElement(SandboxJobGlyph, { state: "provisioning" }),
    );
    expect(markup).toContain('aria-label="Provisioning"');
  });

  test("the working glyph's spin stops under reduced motion", () => {
    const reduced = UI_SCSS.slice(
      UI_SCSS.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    expect(UI_SCSS).toMatch(/\.ui-glyph-working \{[^}]*animation:/);
    expect(reduced).toMatch(/\.ui-glyph-working,[\s\S]*?animation: none/);
  });

  test("a decorative glyph can opt out of the accessibility tree", () => {
    const markup = renderToStaticMarkup(
      createElement(StatusGlyph, { state: "working", label: null }),
    );
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("role=");
  });
});
