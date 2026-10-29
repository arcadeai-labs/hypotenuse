import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";
import { ThemeProvider } from "../context/ThemeContext";

// The app is client-only: the theme provider and the shell read the viewport
// and the stored theme while they first render. A light, narrow-less window is
// enough for a first paint without a browser.
const browser = globalThis as unknown as { window?: unknown };
browser.window ??= {
  matchMedia: (query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }),
};

/**
 * Render the whole app at a path, without a browser. Effects do not run on
 * the server, so this sees each page's first paint.
 * @param path - The location to render.
 * @returns The rendered HTML.
 */
function renderAt(path: string): string {
  return renderToString(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <App />
      </MemoryRouter>
    </ThemeProvider>,
  );
}

describe("routes", () => {
  test("the home page carries the hero inside the public frame", () => {
    const html = renderAt("/");
    expect(html).toContain('data-testid="public-shell"');
    expect(html).toContain("A teammate in every channel");
  });

  test("an unknown path redirects rather than rendering a page of its own", () => {
    // `<Navigate>` acts in an effect, so a first paint is empty; the browser
    // suite follows the redirect home.
    expect(renderAt("/no/such/page")).toBe("");
  });

  test("/status sits in the app shell and says it is asking the server", () => {
    const html = renderAt("/status");
    expect(html).toContain('data-testid="app-shell"');
    expect(html).toContain("Server status");
    expect(html).toContain("Asking the server");
  });

  test("every destination is in the sidebar; one not built yet is disabled and says so without a phase", () => {
    const html = renderAt("/status");
    for (const id of ["home", "conversations", "memory", "sandboxes"]) {
      const item = html.match(
        new RegExp(`<[a-z]+[^>]*data-testid="nav-${id}"[^>]*>`),
      )?.[0];
      expect(item, id).toBeDefined();
      expect(item).toContain('aria-disabled="true"');
      expect(item).toContain('title="Not available yet"');
    }
    expect(html).not.toMatch(/phase/i);
  });

  test("settings and bots are live destinations", () => {
    const html = renderAt("/status");
    for (const [id, href] of [
      ["settings", "/settings"],
      ["bots", "/bots"],
    ]) {
      const item = html.match(
        new RegExp(`<[a-z]+[^>]*data-testid="nav-${id}"[^>]*>`),
      )?.[0];
      expect(item, id).toStartWith("<a");
      expect(item).toContain(`href="${href}"`);
      expect(item).not.toContain("aria-disabled");
    }
  });

  test("a signed-in page waits for the session before deciding where to go", () => {
    // Redirecting before `/me` answers would bounce a signed-in person to
    // sign-in on every hard refresh.
    for (const path of [
      "/settings/members",
      "/settings/models",
      "/bots",
      "/bots/new",
      "/bots/1",
      "/organization/members",
      "/invites",
      "/account",
    ]) {
      const html = renderAt(path);
      expect(html, path).toContain('data-testid="auth-loading"');
      expect(html, path).not.toContain('data-testid="sign-in-card"');
    }
  });

  test("sign-in and sign-up render their forms in the public frame", () => {
    const signIn = renderAt("/sign-in?next=%2Fsettings%2Ftags");
    expect(signIn).toContain('data-testid="public-shell"');
    expect(signIn).toContain('data-testid="sign-in-form"');
    // A safe `next` is carried across to sign-up.
    expect(signIn).toContain('href="/sign-up?next=%2Fsettings%2Ftags"');
    const unsafe = renderAt("/sign-in?next=%2F%2Fevil.example");
    expect(unsafe).toContain('href="/sign-up"');
    expect(renderAt("/sign-up")).toContain('data-testid="sign-up-name"');
  });

  test("signed out, the shell's person-scoped controls are drawn disabled, not left out", () => {
    const html = renderAt("/status");
    const bell = html.match(
      /<[a-z]+[^>]*data-testid="notification-bell-toggle"[^>]*>/,
    )?.[0];
    expect(bell).toContain('aria-disabled="true"');
    expect(html).toContain('data-testid="account-menu"');
    expect(html).toContain("Not signed in");
  });

  test("the organization switcher sits above the project switcher", () => {
    const html = renderAt("/status");
    expect(html.indexOf('data-testid="organization-switcher"')).toBeGreaterThan(
      -1,
    );
    expect(html.indexOf('data-testid="organization-switcher"')).toBeLessThan(
      html.indexOf('data-testid="project-switcher"'),
    );
  });

  test("the style guide is a public docs page that renders both themes side by side", () => {
    const html = renderAt("/docs/style-guide");
    expect(html).toContain('data-testid="public-shell"');
    expect(html).toContain('data-testid="docs-section-style-guide"');
    expect(html).toContain('data-wide="true"');
    expect(html).toContain('data-testid="style-guide-light"');
    expect(html).toContain('data-testid="style-guide-dark"');
  });

  test("the style guide's old address redirects rather than rendering a page of its own", () => {
    expect(renderAt("/style-guide")).toBe("");
  });
});
