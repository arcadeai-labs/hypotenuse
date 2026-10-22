import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "../components/MarkdownBlock";
import {
  DOCS_SECTIONS,
  findSection,
  headingsOf,
} from "../content/docs/sections";
import { validateAuthFields } from "../pages/authForm";

// A docs page is a markdown file plus a row in DOCS_SECTIONS. These assert the
// two halves agree, so a new file cannot ship unreachable from the nav.

describe("docs sections", () => {
  test("every markdown file under content/docs is a registered section, and nothing else is", () => {
    const files = readdirSync(join(import.meta.dir, "..", "content", "docs"))
      .filter((f) => f.endsWith(".md"))
      .map((f) => (f === "index.md" ? "" : f.replace(/\.md$/, "")))
      .sort();
    expect(DOCS_SECTIONS.map((s) => s.slug).sort()).toEqual(files);
  });

  test("slugs are unique and resolve; an unknown slug does not", () => {
    expect(new Set(DOCS_SECTIONS.map((s) => s.slug)).size).toBe(
      DOCS_SECTIONS.length,
    );
    expect(findSection(undefined)?.slug).toBe("");
    expect(findSection("why")?.title).toBe("Why Hypotenuse");
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
});

describe("auth form validation", () => {
  test("accepts a well-formed sign-in", () => {
    expect(
      validateAuthFields({
        email: "evan@example.com",
        password: "correct horse",
      }),
    ).toEqual({});
  });

  test("names every bad field, and requires a name only for sign-up", () => {
    expect(
      Object.keys(
        validateAuthFields({ email: "nope", password: "short" }),
      ).sort(),
    ).toEqual(["email", "password"]);
    expect(
      validateAuthFields(
        { email: "a@b.co", password: "12345678", name: " " },
        true,
      ),
    ).toEqual({
      name: "Enter your name.",
    });
  });

  test("a sign-up name is held to the server's minimum length", () => {
    expect(
      validateAuthFields(
        { email: "a@b.co", password: "12345678", name: "Al" },
        true,
      ).name,
    ).toBe("Use at least 3 characters.");
  });
});

describe("the config file page", () => {
  test("is docs/CONFIG.md from its file table on, with no link left relative", async () => {
    const { publicConfigReference } = await import("../content/docs/sections");
    const page = findSection("config")?.markdown ?? "";
    expect(page).toContain("\n## Files and locations\n");
    expect(page).toContain("## `[[repositories]]`");
    const links = [...page.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1] ?? "");
    expect(links.filter((l) => !/^(#|\/docs\/|https:\/\/)/.test(l))).toEqual(
      [],
    );
    expect(() => publicConfigReference("# no anchor")).toThrow(
      "exactly one '## Files and locations'",
    );
  });
});
