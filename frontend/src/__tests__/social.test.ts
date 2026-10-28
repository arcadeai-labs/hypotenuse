import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TAGLINE } from "../pages/marketing/HomePage";

// A shared link unfurls from index.html's Open Graph and Twitter tags. Crawlers
// do not run the app, so the tags must be in the static file, name an absolute
// image URL that the site serves from public/, and state that image's real size.

const FRONTEND = join(import.meta.dir, "..", "..");
const SITE = "https://www.hypotenuse.cloud";
const html = readFileSync(join(FRONTEND, "index.html"), "utf8");

/**
 * The `content` of the one `<meta>` with this `property` or `name`.
 * @param key - The `og:*` property or `twitter:*` name.
 * @returns Its content.
 */
function meta(key: string): string {
  const matches = [
    ...html.matchAll(
      new RegExp(
        `<meta (?:property|name)="${key.replace(/[:.]/g, "\\$&")}" content="([^"]*)"`,
        "g",
      ),
    ),
  ];
  expect(matches).toHaveLength(1);
  return matches[0][1];
}

describe("social preview", () => {
  test("index.html carries the tags every unfurler reads", () => {
    for (const key of [
      "description",
      "og:type",
      "og:site_name",
      "og:url",
      "og:title",
      "og:description",
      "og:image:alt",
      "twitter:title",
      "twitter:description",
      "twitter:image:alt",
    ])
      expect(meta(key).length).toBeGreaterThan(0);
    expect(meta("twitter:card")).toBe("summary_large_image");
    expect(meta("og:url")).toBe(`${SITE}/`);
  });

  test("the image is absolute, served from public/, and its stated size is its real size", () => {
    const url = meta("og:image");
    expect(meta("twitter:image")).toBe(url);
    expect(url.startsWith(`${SITE}/`)).toBe(true);
    const png = readFileSync(
      join(FRONTEND, "public", url.slice(SITE.length + 1)),
    );
    expect(png.subarray(1, 4).toString("latin1")).toBe("PNG");
    expect(meta("og:image:type")).toBe("image/png");
    const width = png.readUInt32BE(16);
    const height = png.readUInt32BE(20);
    expect(String(width)).toBe(meta("og:image:width"));
    expect(String(height)).toBe(meta("og:image:height"));
    // The 1.91:1 large-card shape, and under X's 5 MB limit.
    expect(width / height).toBeCloseTo(1200 / 630, 2);
    expect(png.length).toBeLessThan(5 * 1024 * 1024);
  });

  test("the tagline appears verbatim in every description and on the home page", () => {
    const tagline =
      "A persistent multiplayer, multichannel agent for your team";
    for (const key of ["description", "og:description", "twitter:description"])
      expect(meta(key), key).toContain(tagline);
    expect(TAGLINE).toBe(tagline);
    const card = readFileSync(
      join(FRONTEND, "scripts", "render-social-image.ts"),
      "utf8",
    );
    expect(card).toContain(tagline);
  });
});
