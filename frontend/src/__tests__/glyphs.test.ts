import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AGENT_SESSION_STATUSES,
  Avatar,
  PresenceDot,
  type RunnerPresence,
  StatusGlyph,
} from "../ui";

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

describe("status glyphs", () => {
  const rendered = AGENT_SESSION_STATUSES.map((status) => ({
    status,
    markup: renderToStaticMarkup(createElement(StatusGlyph, { status })),
  }));

  test("every status draws a different shape, so colour is never the only cue", () => {
    const shapes = new Set(rendered.map((r) => shape(r.markup)));
    expect(shapes.size).toBe(AGENT_SESSION_STATUSES.length);
  });

  test("every glyph is a labelled image", () => {
    for (const { markup } of rendered) {
      expect(markup).toContain('role="img"');
      expect(markup).toMatch(/aria-label="[A-Z][a-z ]+"/);
    }
  });

  test("every glyph class is painted, and only with a generated token", () => {
    for (const { markup } of rendered) {
      const kind = markup.match(/data-glyph="([a-z-]+)"/)?.[1];
      const rule = UI_SCSS.slice(UI_SCSS.indexOf(`.ui-glyph-${kind} {`)).split(
        "}",
      )[0];
      const token = rule.match(/color: var\(--([a-z-]+)\)/)?.[1];
      expect(token).toBeDefined();
      expect(TOKENS).toContain(`--${token}:`);
    }
  });

  test("the active glyph's spin stops under reduced motion", () => {
    const reduced = UI_SCSS.slice(
      UI_SCSS.indexOf("@media (prefers-reduced-motion: reduce)"),
    );
    expect(UI_SCSS).toMatch(/\.ui-glyph-active \{[^}]*animation:/);
    expect(reduced).toMatch(/\.ui-glyph-active,[\s\S]*?animation: none/);
  });

  test("a decorative glyph can opt out of the accessibility tree", () => {
    const markup = renderToStaticMarkup(
      createElement(StatusGlyph, { status: "active", label: null }),
    );
    expect(markup).toContain('aria-hidden="true"');
    expect(markup).not.toContain("role=");
  });
});

describe("presence and avatars", () => {
  test("each presence is its own shape", () => {
    const presences: RunnerPresence[] = ["online", "offline", "draining"];
    const shapes = presences.map((presence) =>
      shape(renderToStaticMarkup(createElement(PresenceDot, { presence }))),
    );
    expect(new Set(shapes).size).toBe(3);
  });

  test("an agent avatar always carries the agent badge; a person's never does", () => {
    const agent = renderToStaticMarkup(
      createElement(Avatar, { name: "Codex", agent: "codex" }),
    );
    expect(agent).toContain('data-agent="codex"');
    expect(agent).toContain('aria-label="Codex (agent)"');
    const person = renderToStaticMarkup(
      createElement(Avatar, { name: "Ada Lovelace" }),
    );
    expect(person).not.toContain("ui-agent-badge");
    expect(person).toContain(">AL<");
  });
});
