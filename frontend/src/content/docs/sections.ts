import configReference from "../../../../docs/CONFIG.md?raw";
import accounts from "./accounts.md?raw";
import agentSessions from "./agent-sessions.md?raw";
import audit from "./audit.md?raw";
import cli from "./cli.md?raw";
import config from "./config.md?raw";
import connectingLinear from "./connecting-linear.md?raw";
import daemon from "./daemon.md?raw";
import gettingStarted from "./getting-started.md?raw";
import index from "./index.md?raw";
import managerAndWorker from "./manager-and-worker.md?raw";
import members from "./members.md?raw";
import projects from "./projects.md?raw";
import routing from "./routing.md?raw";
import runners from "./runners.md?raw";
import why from "./why.md?raw";

/** Where the repository's own docs live, for links the public site cannot serve. */
const REPOSITORY_DOCS =
  "https://github.com/arcadeai-labs/hypotenuse/blob/main/docs/";

/**
 * The public half of `docs/CONFIG.md` — from its file table on — with links
 * into the repository made absolute. The reference has one source; this page
 * is its intro plus that.
 * @param reference - `docs/CONFIG.md`'s text.
 * @returns The markdown to append.
 */
export function publicConfigReference(reference: string): string {
  const anchor = "\n## Files and locations\n";
  const at = reference.indexOf(anchor);
  if (at === -1 || reference.indexOf(anchor, at + 1) !== -1) {
    throw new Error(
      "docs/CONFIG.md must have exactly one '## Files and locations'",
    );
  }
  return reference
    .slice(at + 1)
    .replace(
      /\]\(\.\.\/([^)]+)\)/g,
      "](https://github.com/arcadeai-labs/hypotenuse/blob/main/$1)",
    )
    .replace(/\]\(\.\/([^)]+)\)/g, `](${REPOSITORY_DOCS}$1)`);
}

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
  {
    slug: "connecting-linear",
    title: "Connecting Linear",
    markdown: connectingLinear,
  },
  {
    slug: "agent-sessions",
    title: "Agent sessions",
    markdown: agentSessions,
  },
  { slug: "runners", title: "Runners", markdown: runners },
  { slug: "daemon", title: "The daemon", markdown: daemon },
  {
    slug: "config",
    title: "Config file",
    markdown: `${config}\n${publicConfigReference(configReference)}`,
  },
  { slug: "routing", title: "Routing", markdown: routing },
  {
    slug: "manager-and-worker",
    title: "Managers and workers",
    markdown: managerAndWorker,
  },
  { slug: "members", title: "Members and tags", markdown: members },
  { slug: "audit", title: "Audit log", markdown: audit },
  { slug: "cli", title: "The CLI", markdown: cli },
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
