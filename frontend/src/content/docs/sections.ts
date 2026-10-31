import type { ComponentType } from "react";
import { StyleGuidePage } from "../../pages/StyleGuidePage";
import accounts from "./accounts.md?raw";
import approvals from "./approvals.md?raw";
import audit from "./audit.md?raw";
import bots from "./bots.md?raw";
import cli from "./cli.md?raw";
import codeMode from "./code-mode.md?raw";
import conversations from "./conversations.md?raw";
import gettingStarted from "./getting-started.md?raw";
import goals from "./goals.md?raw";
import mcpServers from "./mcp-servers.md?raw";
import members from "./members.md?raw";
import memory from "./memory.md?raw";
import models from "./models.md?raw";
import organizations from "./organizations.md?raw";
import projects from "./projects.md?raw";
import prompts from "./prompts.md?raw";
import skills from "./skills.md?raw";
import styleGuide from "./style-guide.md?raw";
import tags from "./tags.md?raw";
import talkingToABotOverTheApi from "./talking-to-a-bot-over-the-api.md?raw";

/** One page of the public docs. */
export interface DocsSection {
  /** The URL segment under `/docs`. `/docs` itself shows the first section. */
  slug: string;
  title: string;
  markdown: string;
  /** A live component drawn under the markdown, for a page that shows rather than tells. */
  component?: ComponentType;
  /** Gives the page the rail's width too, for a component that needs the room. */
  wide?: boolean;
}

/** Every docs page, in navigation order. A new page is a markdown file and a row here. */
export const DOCS_SECTIONS: DocsSection[] = [
  {
    slug: "getting-started",
    title: "Getting started",
    markdown: gettingStarted,
  },
  { slug: "accounts", title: "Accounts", markdown: accounts },
  { slug: "organizations", title: "Organizations", markdown: organizations },
  { slug: "projects", title: "Projects", markdown: projects },
  { slug: "members", title: "Members", markdown: members },
  { slug: "tags", title: "Tags", markdown: tags },
  { slug: "models", title: "Models", markdown: models },
  { slug: "bots", title: "Bots", markdown: bots },
  { slug: "conversations", title: "Conversations", markdown: conversations },
  { slug: "prompts", title: "Prompts", markdown: prompts },
  { slug: "goals", title: "Goals", markdown: goals },
  { slug: "skills", title: "Skills", markdown: skills },
  { slug: "memory", title: "Memory", markdown: memory },
  { slug: "mcp-servers", title: "MCP servers", markdown: mcpServers },
  { slug: "approvals", title: "Approvals", markdown: approvals },
  { slug: "code-mode", title: "Code mode", markdown: codeMode },
  {
    slug: "talking-to-a-bot-over-the-api",
    title: "Talking to a bot over the API",
    markdown: talkingToABotOverTheApi,
  },
  { slug: "audit", title: "Audit log", markdown: audit },
  { slug: "cli", title: "Command line", markdown: cli },
  {
    slug: "style-guide",
    title: "Style guide",
    markdown: styleGuide,
    component: StyleGuidePage,
    wide: true,
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
