import accounts from "./accounts.md?raw";
import audit from "./audit.md?raw";
import gettingStarted from "./getting-started.md?raw";
import index from "./index.md?raw";
import members from "./members.md?raw";
import projects from "./projects.md?raw";
import why from "./why.md?raw";

/** One page of the public docs. */
export interface DocsSection {
  /** The URL segment under `/docs`; the empty string is `/docs` itself. */
  slug: string;
  title: string;
  markdown: string;
}

/** Every docs page, in navigation order. A new page is a markdown file and a row here. */
export const DOCS_SECTIONS: DocsSection[] = [
  { slug: "", title: "Introduction", markdown: index },
  { slug: "why", title: "Why Hypotenuse", markdown: why },
  {
    slug: "getting-started",
    title: "Getting started",
    markdown: gettingStarted,
  },
  { slug: "accounts", title: "Accounts", markdown: accounts },
  { slug: "projects", title: "Projects", markdown: projects },
  { slug: "members", title: "Members and tags", markdown: members },
  { slug: "audit", title: "Audit log", markdown: audit },
];

/**
 * Find a section by its slug.
 * @param slug - The URL segment, or undefined for `/docs`.
 * @returns The section, or undefined for an unknown slug.
 */
export function findSection(slug: string | undefined): DocsSection | undefined {
  return DOCS_SECTIONS.find((section) => section.slug === (slug ?? ""));
}

/**
 * The second-level headings of a page, for the "on this page" rail.
 * @param markdown - The page source.
 * @returns Heading text in order, skipping anything inside a code fence.
 */
export function headingsOf(markdown: string): string[] {
  const headings: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    else if (!fenced && line.startsWith("## "))
      headings.push(line.slice(3).trim());
  }
  return headings;
}
