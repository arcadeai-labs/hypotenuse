import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * The builder documentation is maintained in two opposite directions, and one
 * slice of that is mechanically checkable.
 *
 * A plan doc's sections above `## Learnings from the build` are history and are
 * never edited; its learnings section, and every doc outside `docs/plans/`,
 * claim to describe the system as it stands. A rename is the most common way
 * that claim quietly stops being true — and a rename that moves a file or
 * rewords a heading breaks a link, which is the part a test can see.
 *
 * Only `./` and `../` targets are resolved: `http(s)` is somebody else's
 * uptime, and it says nothing about whether this repository still contains
 * what a doc names. Anchors are checked, in-page ones included, because a
 * heading is renamed far more often than a file is.
 */

/** The repository root, three levels above this file. */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

/** Markdown link targets that point at a path in this repository. */
const RELATIVE_LINK = /\]\((\.{1,2}\/[^)\s]+)\)/g;

/**
 * Markdown links carrying an `#anchor`, with or without a path before it.
 * Group 1 is the optional relative path; group 2 is the fragment.
 */
const ANCHORED_LINK = /\]\((\.{1,2}\/[^)\s#]*)?#([^)\s]+)\)/g;

/** ATX headings, whose text is what an anchor has to match. */
const HEADING = /^#{1,6}\s+(.*)$/;

/** A fenced code block's opening or closing line. */
const FENCE = /^\s*(```|~~~)/;

/**
 * The id GitHub gives a heading, per `github-slugger`.
 *
 * Each **space** becomes a hyphen rather than each run of whitespace, so
 * punctuation dropped from between two words leaves two hyphens behind: the em
 * dash in "Pull requests — what a reviewer sees" renders as
 * `pull-requests--what-a-reviewer-sees`.
 * @param heading - The heading text, without its leading hashes.
 * @returns The anchor id.
 */
function headingSlug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/ /g, "-");
}

/**
 * The headings of a markdown document, skipping fenced code, where a `#` line
 * is a comment rather than a heading.
 * @param text - The document's contents.
 * @returns The anchor id of every heading.
 */
function headingSlugs(text: string): Set<string> {
  const found = new Set<string>();
  let fenced = false;
  for (const line of text.split("\n")) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced) continue;
    const heading = line.match(HEADING);
    if (heading) found.add(headingSlug(heading[1]!));
  }
  return found;
}

/**
 * Every markdown file whose links must resolve on disk.
 * @returns Repo-relative paths, sorted so a failure names the same file twice.
 */
function builderDocs(): string[] {
  const found = ["AGENTS.md", "README.md"];
  for (const path of new Bun.Glob("**/*.md").scanSync({
    cwd: join(REPO_ROOT, "docs"),
  })) {
    found.push(join("docs", path));
  }
  return found.sort();
}

/**
 * The plan docs: every phase under `docs/plans/`, without the index.
 * @returns Repo-relative paths.
 */
function planDocs(): string[] {
  return builderDocs().filter(
    (doc) =>
      doc.startsWith(join("docs", "plans")) && !doc.endsWith("README.md"),
  );
}

describe("builder documentation", () => {
  test("every relative link resolves to something in the repository", () => {
    const docs = builderDocs();
    // Guard the guard: a glob that silently matched nothing would make this
    // whole suite pass by examining zero files.
    expect(docs.length).toBeGreaterThan(20);

    const broken: string[] = [];
    for (const doc of docs) {
      const text = readFileSync(join(REPO_ROOT, doc), "utf8");
      for (const match of text.matchAll(RELATIVE_LINK)) {
        // An anchor is a location inside the target, not part of its path.
        const target = match[1]!.split("#")[0]!;
        if (target === "") continue;
        if (!existsSync(resolve(REPO_ROOT, dirname(doc), target))) {
          broken.push(`${doc} -> ${match[1]}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("every anchor link resolves to a heading in the doc it names", () => {
    const docs = builderDocs();
    const slugs = new Map<string, Set<string>>();
    for (const doc of docs) {
      const text = readFileSync(join(REPO_ROOT, doc), "utf8");
      slugs.set(realpathSync(join(REPO_ROOT, doc)), headingSlugs(text));
    }

    const broken: string[] = [];
    for (const doc of docs) {
      const text = readFileSync(join(REPO_ROOT, doc), "utf8");
      for (const match of text.matchAll(ANCHORED_LINK)) {
        const path = match[1]
          ? resolve(REPO_ROOT, dirname(doc), match[1])
          : join(REPO_ROOT, doc);
        if (!existsSync(path)) continue; // The path test above owns this.
        const headings = slugs.get(realpathSync(path));
        // A link into a file this suite does not read says nothing checkable.
        if (!headings) continue;
        if (!headings.has(match[2]!.toLowerCase())) {
          broken.push(`${doc} -> ${relative(REPO_ROOT, path)}#${match[2]}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("every plan doc carries the heading that divides its two halves, once", () => {
    const docs = planDocs();
    // Twenty-three phases are planned; a glob that lost most of them must fail.
    expect(docs.length).toBeGreaterThan(20);

    const wrong: string[] = [];
    for (const doc of docs) {
      const text = readFileSync(join(REPO_ROOT, doc), "utf8");
      // The exact heading, because it is what tells a reader which half they
      // are in — and therefore which half they may edit. Twice would leave the
      // reader unsure which half they are in.
      const count = text.split("\n## Learnings from the build\n").length - 1;
      if (count !== 1) wrong.push(`${doc}: ${count}`);
    }
    expect(wrong).toEqual([]);
  });

  test("every plan doc is listed in the plans index", () => {
    const index = readFileSync(
      join(REPO_ROOT, "docs", "plans", "README.md"),
      "utf8",
    );
    const unlisted = planDocs().filter(
      (doc) => !index.includes(`(./${doc.split("/").pop()})`),
    );
    expect(unlisted).toEqual([]);
  });
});
