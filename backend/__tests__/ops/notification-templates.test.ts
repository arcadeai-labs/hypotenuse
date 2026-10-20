import { describe, expect, test } from "bun:test";
import {
  escapeHtml,
  layout,
  NOTIFICATION_TEMPLATE_NAMES,
  NOTIFICATION_TEMPLATES,
} from "../../ops/templates";
import { EMAIL_PALETTE } from "../../theme/email-palette";

/**
 * The template chrome is pure, so this suite boots nothing.
 *
 * Two properties matter and neither is about wording. **Escaping**: issue
 * titles, comments, and whatever a coding agent wrote all come from outside,
 * so every template renders attacker-adjacent text into a mail client and
 * `escapeHtml` is the only thing between the two. And **the palette**: mail is
 * painted from the generated design tokens, never from literals typed here.
 */

const APP_URL = "https://app.example.test";

describe("notification templates", () => {
  test("every registered name resolves to a template", () => {
    for (const name of NOTIFICATION_TEMPLATE_NAMES) {
      expect(typeof NOTIFICATION_TEMPLATES[name]).toBe("function");
    }
  });

  test("escapeHtml neutralizes every character that opens markup", () => {
    expect(escapeHtml(`<img src=x onerror="alert('1')"> & more`)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt; &amp; more",
    );
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(42)).toBe("42");
  });

  test("layout escapes the heading and the link it is handed", () => {
    const html = layout({
      heading: "<script>alert('h')</script>",
      bodyHtml: "<p>already escaped</p>",
      actionLabel: "<b>Open</b>",
      actionUrl: `${APP_URL}/settings?x="><script>`,
    });
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<b>");
    expect(html).toContain("<p>already escaped</p>");
    expect(html).toContain(escapeHtml(`${APP_URL}/settings?x="><script>`));
  });

  test("layout is painted from the generated palette", () => {
    const html = layout({
      heading: "Heading",
      bodyHtml: "",
      actionLabel: "Open",
      actionUrl: APP_URL,
    });
    for (const color of Object.values(EMAIL_PALETTE)) {
      expect(html).toContain(color);
    }
    // Every color literal in the chrome is one the palette generated.
    const literals = html.match(/#[0-9a-f]{6}\b/gi) ?? [];
    const palette = new Set<string>(Object.values(EMAIL_PALETTE));
    for (const literal of literals) {
      expect(palette.has(literal.toLowerCase())).toBe(true);
    }
  });
});
