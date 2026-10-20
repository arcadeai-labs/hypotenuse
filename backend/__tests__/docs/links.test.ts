import { describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

/**
 * The builder documentation is maintained in two opposite directions, and one
 * slice of that is mechanically checkable.
 *
 * A plan doc's sections above `## Learnings from the build` are history and are
 * never edited; its learnings section, and every doc outside `docs/plans/`,
 * claim to describe the system as it stands. A rename is the most common way
 * that claim quietly stops being true — and a rename that moves a file breaks a
 * link, which is the part a test can see. The dead link this was written for
 * pointed at a renamed test file from the step table that described it.
 *
 * Scoped to the builder docs on purpose. `frontend/src/content/docs/` is
 * rendered in-app through `MarkdownBlock` with `internalLinks`, so a rooted
 * path there is a React Router route rather than a file on disk, and asserting
 * it against the filesystem would fail on every correct link.
 *
 * Only `./` and `../` targets are resolved: `http(s)` is somebody else's
 * uptime, and it says nothing about whether this repository still contains what
 * a doc names.
 *
 * An `#anchor` **is** checked, in-page ones included, because a heading is
 * renamed far more often than a file is and the link into it is the last thing
 * anybody rereads. `docs/ARCHITECTURE.md` is what made this worth asserting:
 * two docs now deep-link into its sections, so a heading reworded there breaks
 * a pointer somewhere else in the tree.
 */

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

/**
 * The id GitHub gives a heading, per `github-slugger`.
 *
 * Each **space** becomes a hyphen rather than each run of whitespace, so
 * punctuation dropped from between two words leaves two hyphens behind. That
 * is not a detail worth knowing except that it is the whole difference between
 * a working anchor and a dead one: the em dash in "Raw requests — generalize
 * the capture hook" renders as `raw-requests--generalize`, and the one link
 * pointing at it guessed a single hyphen.
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
 * Every markdown file whose links must resolve on disk.
 * @returns Repo-relative paths, sorted so a failure names the same file twice.
 */
async function builderDocs(): Promise<string[]> {
  const found = ["AGENTS.md", "README.md"];
  const glob = new Bun.Glob("**/*.md");
  for await (const path of glob.scan({ cwd: join(REPO_ROOT, "docs") })) {
    found.push(join("docs", path));
  }
  return found.sort();
}

describe("builder documentation", () => {
  test("every relative link resolves to something in the repository", async () => {
    const docs = await builderDocs();
    // Guard the guard: a glob that silently matched nothing would make this
    // whole suite pass by examining zero files.
    expect(docs.length).toBeGreaterThan(20);

    const broken: string[] = [];
    for (const doc of docs) {
      const text = await Bun.file(join(REPO_ROOT, doc)).text();
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

  test("every anchor link resolves to a heading in the doc it names", async () => {
    const docs = await builderDocs();
    expect(docs.length).toBeGreaterThan(20);

    // Keyed by real path, so a link through a symlinked name still finds the
    // headings of the file it points at.
    const slugs = new Map<string, Set<string>>();
    for (const doc of docs) {
      const found = new Set<string>();
      for (const line of (await Bun.file(join(REPO_ROOT, doc)).text()).split(
        "\n",
      )) {
        const heading = line.match(HEADING);
        if (heading) found.add(headingSlug(heading[1]!));
      }
      slugs.set(realpathSync(join(REPO_ROOT, doc)), found);
    }

    const broken: string[] = [];
    for (const doc of docs) {
      const text = await Bun.file(join(REPO_ROOT, doc)).text();
      for (const match of text.matchAll(ANCHORED_LINK)) {
        const path = match[1]
          ? resolve(REPO_ROOT, dirname(doc), match[1])
          : join(REPO_ROOT, doc);
        if (!existsSync(path)) continue; // The path test above owns this.
        const headings = slugs.get(realpathSync(path));
        // A link into a doc this suite does not read says nothing checkable:
        // `frontend/src/content/docs/` anchors are resolved by the renderer.
        if (!headings) continue;
        if (!headings.has(match[2]!.toLowerCase())) {
          broken.push(`${doc} -> ${relative(REPO_ROOT, path)}#${match[2]}`);
        }
      }
    }
    expect(broken).toEqual([]);
  });

  test("every plan doc carries the heading that divides its two halves", async () => {
    const docs = (await builderDocs()).filter(
      (doc) =>
        doc.startsWith(join("docs", "plans")) && !doc.endsWith("README.md"),
    );
    expect(docs.length).toBeGreaterThan(15);

    const missing: string[] = [];
    for (const doc of docs) {
      const text = await Bun.file(join(REPO_ROOT, doc)).text();
      // The exact heading, because it is what tells a reader which half they
      // are in — and therefore which half they may edit.
      if (!text.includes("\n## Learnings from the build\n")) missing.push(doc);
    }
    expect(missing).toEqual([]);
  });
});
