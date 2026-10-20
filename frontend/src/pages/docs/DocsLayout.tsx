import { NavLink, Outlet, useParams } from "react-router-dom";
import { DOCS_SECTIONS, findSection, headingsOf } from "../../content/docs/sections";
import { slugify } from "../../components/MarkdownBlock";

/**
 * The docs frame: section nav on the left, a 72ch article, and an "on this
 * page" rail. The nav is hidden rather than unmounted on narrow screens, so
 * one selector resolves at every width.
 * @returns The layout with the routed page as the article.
 */
export function DocsLayout() {
  const { slug } = useParams();
  const section = findSection(slug);
  const headings = section ? headingsOf(section.markdown) : [];
  return (
    <div className="docs-layout" data-testid="docs-layout">
      <nav className="docs-nav" aria-label="Docs sections" data-testid="docs-nav">
        {DOCS_SECTIONS.map((s) => (
          <NavLink
            key={s.slug}
            to={s.slug ? `/docs/${s.slug}` : "/docs"}
            end
            data-testid={`docs-section-${s.slug || "index"}`}
          >
            {s.title}
          </NavLink>
        ))}
      </nav>
      <article className="docs-article">
        <Outlet />
      </article>
      <aside className="docs-rail" aria-label="On this page">
        {headings.length > 0 && (
          <>
            <h2 className="docs-rail-title">On this page</h2>
            {headings.map((heading) => (
              <a key={heading} href={`#${slugify(heading)}`}>
                {heading}
              </a>
            ))}
          </>
        )}
      </aside>
    </div>
  );
}
