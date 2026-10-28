import { Link, useParams } from "react-router-dom";
import { MarkdownBlock } from "../../components/MarkdownBlock";
import { findSection } from "../../content/docs/sections";

/**
 * One docs page, rendered from its markdown, then its component if it has one.
 * @returns The page, or a not-found message for an unknown slug.
 */
export function DocsPage() {
  const { slug } = useParams();
  const section = findSection(slug);
  if (!section) {
    return (
      <div className="docs-not-found" data-testid="docs-not-found">
        <h1>Page not found</h1>
        <p>
          There is no docs page at this address. Start from{" "}
          <Link to="/docs">Getting started</Link>.
        </p>
      </div>
    );
  }
  const Component = section.component;
  return (
    <div data-testid={`docs-page-${section.slug || "index"}`}>
      <MarkdownBlock internalLinks diagrams>
        {section.markdown}
      </MarkdownBlock>
      {Component && <Component />}
    </div>
  );
}
