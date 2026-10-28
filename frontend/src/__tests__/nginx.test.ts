import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Production serves the build from nginx behind Render, which forwards to a
// port nobody outside can reach. A reload of a client route must get the SPA's
// index.html, never one of nginx's own redirects (which named that port) or a
// directory from public/ (which 403s without an index.html).

const FRONTEND = join(import.meta.dir, "..", "..");
const conf = readFileSync(join(FRONTEND, "nginx.conf"), "utf8")
  .split("\n")
  .map((line) => line.replace(/#.*/, "").trim())
  .filter(Boolean)
  .join("\n");

/**
 * The first path segment of every `<Route path="/…">` in App.tsx.
 * @returns Each top-level route segment, e.g. `status`.
 */
function topLevelRouteSegments(): Set<string> {
  const app = readFileSync(join(FRONTEND, "src", "App.tsx"), "utf8");
  const segments = new Set<string>();
  for (const [, path] of app.matchAll(/path="\/([^"]*)"/g)) {
    const segment = path?.split("/")[0];
    if (segment) segments.add(segment);
  }
  return segments;
}

describe("nginx.conf", () => {
  test("listens on the port Render forwards to", () => {
    expect(conf).toMatch(/^listen 10000;$/m);
  });

  test("never builds an absolute redirect from the internal host and port", () => {
    expect(conf).toMatch(/^absolute_redirect off;$/m);
  });

  test("falls back to index.html without matching directories", () => {
    const tryFiles = conf.match(/^try_files (.+);$/m)?.[1];
    expect(tryFiles).toBe("$uri /index.html");
  });
});

describe("public/", () => {
  test("no top-level entry shadows a client route", () => {
    const routes = topLevelRouteSegments();
    // Guard the guard: a route regex that matched nothing would pass.
    expect(routes.has("status")).toBe(true);
    const publicDir = join(FRONTEND, "public");
    const entries = existsSync(publicDir) ? readdirSync(publicDir) : [];
    expect(entries.filter((entry) => routes.has(entry))).toEqual([]);
  });
});
