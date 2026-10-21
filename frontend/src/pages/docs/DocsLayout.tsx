import { ChevronDown } from "lucide-react";
import { useState } from "react";
import { NavLink, Outlet, useParams } from "react-router-dom";
import { slugify } from "../../components/MarkdownBlock";
import {
  DOCS_SECTIONS,
  findSection,
  headingsOf,
} from "../../content/docs/sections";

/**
 * The docs frame: section nav on the left, a 72ch article, and an "on this
 * page" rail. Below 768px the nav folds behind a button naming the current
 * section, and the rail is hidden. Both stay mounted, so one selector resolves
 * at every width.
 * @returns The layout with the routed page as the article.
 */
export function DocsLayout() {
  const { slug } = useParams();
  const section = findSection(slug);
  const headings = section ? headingsOf(section.markdown) : [];
  // The page the nav was opened on: arriving anywhere else, by the nav or any
  // other link, folds it away. `null` is closed.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const page = slug ?? "";
  const navOpen = openOn === page;

  return (
    <div className="docs-layout" data-testid="docs-layout">
      <div className="docs-nav-frame">
        <button
          type="button"
          className="docs-nav-toggle"
          data-testid="docs-nav-toggle"
          aria-expanded={navOpen}
          aria-controls="docs-nav"
          onClick={() => setOpenOn(navOpen ? null : page)}
        >
          <span>{section?.title ?? "Docs"}</span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
        <nav
          id="docs-nav"
          className="docs-nav"
          aria-label="Docs sections"
          data-testid="docs-nav"
          data-open={navOpen}
        >
          {DOCS_SECTIONS.map((s) => (
            <NavLink
              key={s.slug}
              to={s.slug ? `/docs/${s.slug}` : "/docs"}
              end
              data-testid={`docs-section-${s.slug || "index"}`}
              onClick={() => setOpenOn(null)}
            >
              {s.title}
            </NavLink>
          ))}
        </nav>
      </div>
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
