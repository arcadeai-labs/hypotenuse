import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { api } from "keryx";
import tokens from "../../../design/tokens.json" with { type: "json" };
import { HOOK_TIMEOUT, serverUrl } from "../setup";

// The OAuth authorize page is the one surface Keryx renders server-side, so it
// is the one place the generated theme could silently stop arriving: a
// `WEB_SERVER_THEME` that is unset, misspelled, or pointing at a moved file
// leaves the framework's default palette in place and nothing else notices.
// This boots a real server, fetches the page over HTTP, and asserts both
// themes' generated values and our mark are in the response.

let html: string;

beforeAll(async () => {
  await api.start();
  // An unregistered `client_id` is deliberate: the GET renders regardless (the
  // POST is what enforces the client), so no OAuth client is needed here.
  const res = await fetch(
    `${serverUrl()}/oauth/authorize?client_id=theme-test&redirect_uri=${encodeURIComponent(
      "http://localhost:9999/cb",
    )}&response_type=code`,
  );
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/html");
  html = await res.text();
}, HOOK_TIMEOUT);

afterAll(async () => {
  await api.stop();
}, HOOK_TIMEOUT);

describe("oauth authorize page — theme", () => {
  test("inlines both generated themes", () => {
    for (const mode of ["light", "dark"] as const) {
      const t = tokens[mode];
      expect(html).toContain(`--keryx-color-primary: ${t.accent};`);
      expect(html).toContain(
        `--keryx-color-primary-hover: ${t["accent-hover"]};`,
      );
      expect(html).toContain(`--keryx-bg: ${t["bg-app"]};`);
      expect(html).toContain(`--keryx-surface: ${t["bg-panel"]};`);
      expect(html).toContain(`--keryx-color-text: ${t["text-primary"]};`);
      expect(html).toContain(
        `--keryx-color-text-muted: ${t["text-secondary"]};`,
      );
      expect(html).toContain(`--keryx-color-border: ${t["border-default"]};`);
    }
    expect(html).toContain("@media (prefers-color-scheme: dark)");
  });

  test("overrides Keryx's defaults rather than merely adding to them", () => {
    // Keryx inlines its default theme first. Ours must come after it, or the
    // cascade leaves the framework's palette in place. Assert the framework's
    // declaration exists first: a -1 would pass the ordering check wrongly.
    const theirs = html.indexOf("--keryx-color-primary: #2f5266");
    const ours = html.indexOf(`--keryx-color-primary: ${tokens.light.accent}`);
    const oursDark = html.indexOf(
      `--keryx-color-primary: ${tokens.dark.accent}`,
    );
    expect(theirs).toBeGreaterThan(-1);
    expect(ours).toBeGreaterThan(theirs);
    expect(oursDark).toBeGreaterThan(ours);
  });

  test("serves our mark, not Keryx's lion", () => {
    expect(html).toContain('data-glyph="hypotenuse"');
    expect(html).not.toContain('viewBox="0 0 2048 2048"');
  });
});
