import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App";

/**
 * Render the whole app at a path, without a browser. Effects do not run on
 * the server, so this sees each page's first paint.
 * @param path - The location to render.
 * @returns The rendered HTML.
 */
function renderAt(path: string): string {
  return renderToString(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
}

describe("routes", () => {
  test("the home page names the product and links to the server status", () => {
    const html = renderAt("/");
    expect(html).toContain("<h1>Hypotenuse</h1>");
    expect(html).toContain('href="/status"');
  });

  test("an unknown path falls back to the home page rather than a blank screen", () => {
    expect(renderAt("/no/such/page")).toContain("<h1>Hypotenuse</h1>");
  });

  test("/status says it is asking the server before the answer arrives", () => {
    const html = renderAt("/status");
    expect(html).toContain("<h1>Server status</h1>");
    expect(html).toContain("Asking the server");
  });
});
