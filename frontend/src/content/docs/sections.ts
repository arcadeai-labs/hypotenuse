import gettingStarted from "./getting-started.md?raw";

/** One page of the public docs. */
export interface DocsSection {
  /** The URL segment under `/docs`. `/docs` itself shows the first section. */
  slug: string;
  title: string;
  markdown: string;
}

/** Every docs page, in navigation order. A new page is a markdown file and a row here. */
export const DOCS_SECTIONS: DocsSection[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    markdown: gettingStarted,
  },
];

/**
 * Find a section by its slug.
 * @param slug - The URL segment, or undefined for `/docs`, which is the first section.
 * @returns The section, or undefined for an unknown slug.
 */
export function findSection(slug: string | undefined): DocsSection | undefined {
  if (slug === undefined) return DOCS_SECTIONS[0];
  return DOCS_SECTIONS.find((section) => section.slug === slug);
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
