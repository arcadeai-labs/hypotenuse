import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "../components/MarkdownBlock";
import {
  DOCS_SECTIONS,
  findSection,
  headingsOf,
} from "../content/docs/sections";

// A docs page is a markdown file plus a row in DOCS_SECTIONS. These assert the
// two halves agree, so a new file cannot ship unreachable from the nav.

describe("docs sections", () => {
  test("every markdown file under content/docs is a registered section, and nothing else is", () => {
    const files = readdirSync(join(import.meta.dir, "..", "content", "docs"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
      .sort();
    expect(DOCS_SECTIONS.map((s) => s.slug).sort()).toEqual(files);
  });

  test("slugs are unique and resolve; an unknown slug does not", () => {
    expect(new Set(DOCS_SECTIONS.map((s) => s.slug)).size).toBe(
      DOCS_SECTIONS.length,
    );
    expect(findSection(undefined)).toBe(DOCS_SECTIONS[0]);
    expect(findSection("getting-started")?.title).toBe("Getting started");
    expect(findSection("nope")).toBeUndefined();
  });

  test("the rail reads second-level headings and skips code fences", () => {
    expect(
      headingsOf("# T\n## One\n```\n## not a heading\n```\n### Sub\n## Two"),
    ).toEqual(["One", "Two"]);
  });

  test("every /docs link names a page, and every #anchor a heading on it", () => {
    const broken: string[] = [];
    for (const section of DOCS_SECTIONS) {
      for (const [, slug, anchor] of section.markdown.matchAll(
        /\]\(\/docs(?:\/([a-z0-9-]+))?(?:#([a-z0-9-]+))?\)/g,
      )) {
        const target = findSection(slug);
        if (!target) {
          broken.push(`${section.slug}: /docs/${slug}`);
          continue;
        }
        if (
          anchor &&
          !target.markdown
            .split("\n")
            .filter((line) => /^#{2,4} /.test(line))
            .some((line) => slugify(line.replace(/^#+ /, "")) === anchor)
        ) {
          broken.push(`${section.slug}: /docs/${slug ?? ""}#${anchor}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("heading ids are stable slugs", () => {
    expect(slugify("How it fits together")).toBe("how-it-fits-together");
    expect(slugify("Agents where `your` code is!")).toBe(
      "agents-where-your-code-is",
    );
  });

  test("every illustration a page embeds exists in both themes", () => {
    const dir = join(
      import.meta.dir,
      "..",
      "..",
      "public",
      "doc-assets",
      "illustrations",
    );
    const missing: string[] = [];
    for (const section of DOCS_SECTIONS) {
      for (const [, name] of section.markdown.matchAll(
        /\]\(illustration:([a-z0-9-]+)\)/g,
      )) {
        for (const theme of ["light", "dark"]) {
          if (!existsSync(join(dir, `${name}-${theme}.png`)))
            missing.push(`${section.slug}: ${name}-${theme}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
