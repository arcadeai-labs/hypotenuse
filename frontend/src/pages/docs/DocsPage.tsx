import { Link, useParams } from "react-router-dom";
import { MarkdownBlock } from "../../components/MarkdownBlock";
import { findSection } from "../../content/docs/sections";

/**
 * One docs page, rendered from its markdown.
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
          There is no docs page at this address. Start from the <Link to="/docs">introduction</Link>.
        </p>
      </div>
    );
  }
  return (
    <div data-testid={`docs-page-${section.slug || "index"}`}>
      <MarkdownBlock internalLinks>{section.markdown}</MarkdownBlock>
    </div>
  );
}
