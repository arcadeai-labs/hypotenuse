import { type ReactNode, useId, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Button, Card, Nav } from "../../ui";

/** One item in a {@link SectionNav}. */
export interface SectionNavItem {
  /** The URL segment, which keys this item's `data-testid`. */
  slug: string;
  /** What the sidebar calls it. */
  label: string;
  /** The heading it sits under. Groups are rendered in first-seen order. */
  group: string;
  /**
   * Where it points, or `null` when there is nowhere to go yet.
   *
   * A `null` renders a real `<span>` rather than a link with
   * `pointer-events: none`: a disabled control must not be focusable or announced
   * as a link, and `aria-disabled` is what the e2e suite asserts on.
   */
  to: string | null;
  /** Rendered as the current section rather than as disabled, while `to` is null. */
  current?: boolean;
  /** Why it is not a link, for the `title` attribute. */
  disabledReason?: string;
}

/** See {@link SectionNav}. */
export interface SectionNavProps {
  /** The root card's `data-testid`. */
  testId: string;
  /** The items, in the order they should appear within their groups. */
  items: readonly SectionNavItem[];
  /** Problems per slug, for the sidebar markers. Unused where there is no validator. */
  problemCounts?: Record<string, { errors: number; warnings: number }>;
  /** Which section is holding unsaved edits, if any. */
  dirtySlug?: string | null;
  /**
   * Intercept a navigation.
   *
   * A shell uses it to ask before discarding a dirty draft. It returns whether the
   * navigation was handled — `true` means this component must not let the link
   * proceed.
   *
   * **This is why there is no `useBlocker`.** React Router 7's blocker requires a
   * data router (`createBrowserRouter` + `RouterProvider`) and throws outside one;
   * the app is built on `<BrowserRouter>`, and migrating would restructure how
   * `AuthProvider` and `NotificationProvider` nest — a much larger change that has
   * no business riding along with this one. Do not "fix" this later without doing
   * that migration deliberately. See `useDirtyGuard` for the other half.
   */
  onNavigate?: (slug: string) => boolean;
  /** A note under the list, e.g. why half the items are disabled. */
  footer?: ReactNode;
}

/**
 * A sidebar of sections, for any area split into deep-linked sections (today,
 * project settings).
 *
 * `Nav.Link as={NavLink}` rather than a comparison in JSX, so `.active` comes from
 * the router and cannot disagree with the URL. Deliberately **not**
 * `<Tab.Container>` or `Nav variant="tabs"`: `Tab` owns its own active key and
 * would fight the router, and tabs imply the URL does not change — which is the
 * opposite of the point, since every section is a deep link.
 *
 * It takes **items rather than a registry**, so each area keeps its own table
 * with its own extra fields (`readAction` for settings) and maps it here. The
 * per-item testids (`section-<slug>`, `section-dirty`,
 * `section-problems-<slug>`) are the same in every area, so one e2e helper
 * drives any of them.
 *
 * **Below `md` the list is a disclosure, closed until asked for.** It is a sidebar
 * only where there is a side: in one column it is however many sections tall,
 * above the thing the reader came for.
 *
 * The list itself is always **rendered**, and only hidden — `d-none d-md-block`
 * rather than a mount — so one `getByTestId("section-…")` resolves at either width
 * and the desktop layout owes nothing to state.
 * @param props - See {@link SectionNavProps}.
 * @returns The rendered sidebar.
 */
export default function SectionNav({
  testId,
  items,
  problemCounts = {},
  dirtySlug = null,
  onNavigate,
  footer,
}: SectionNavProps) {
  // Derived from the items rather than passed in, so a group list cannot drift
  // from the sections that claim to be in it.
  const groups = [...new Set(items.map((item) => item.group))];

  const [open, setOpen] = useState(false);
  const listId = useId();
  const { pathname } = useLocation();

  // What the closed disclosure is named. The URL rather than `.active`, because
  // `.active` is the router's business inside each link and is not readable from
  // out here; `current` covers the areas whose sections are not links yet.
  const here =
    items.find((item) => item.to !== null && item.to === pathname) ??
    items.find((item) => item.current);

  return (
    <Card data-testid={testId}>
      <Card.Body className="p-2">
        <Button
          variant="outline-secondary"
          size="sm"
          className="d-md-none w-100 section-nav-toggle"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((wasOpen) => !wasOpen)}
          data-testid="section-nav-toggle"
        >
          {here ? here.label : "Sections"}
        </Button>

        <Nav
          id={listId}
          className={`flex-column section-nav ${open ? "" : "d-none d-md-flex"}`}
        >
          {groups.map((group) => (
            <div key={group} className="mb-2">
              <div className="text-meta px-2 pb-1">{group}</div>
              {items
                .filter((item) => item.group === group)
                .map((item) => {
                  const counts = problemCounts[item.slug];
                  const dirty = dirtySlug === item.slug;

                  if (item.to === null) {
                    return (
                      <span
                        key={item.slug}
                        className={
                          item.current ? "nav-link active" : "nav-link disabled"
                        }
                        aria-current={item.current ? "page" : undefined}
                        aria-disabled={item.current ? undefined : "true"}
                        title={item.current ? undefined : item.disabledReason}
                        data-testid={`section-${item.slug}`}
                      >
                        {item.label}
                      </span>
                    );
                  }

                  return (
                    <Nav.Link
                      key={item.slug}
                      as={NavLink}
                      to={item.to}
                      data-testid={`section-${item.slug}`}
                      onClick={(event: React.MouseEvent) => {
                        if (onNavigate?.(item.slug)) event.preventDefault();
                        // A disclosure that stays open after a choice leaves the
                        // reader exactly where they started: looking at the list.
                        // Closed on every click, including an intercepted one —
                        // the dirty guard answers in a modal and then navigates
                        // itself, so a close that only ran on the immediate path
                        // left the list covering the section it had just opened.
                        setOpen(false);
                      }}
                    >
                      {item.label}
                      {dirty && (
                        <>
                          <span
                            className="section-nav-dirty"
                            aria-hidden="true"
                            data-testid="section-dirty"
                          />
                          <span className="visually-hidden">
                            {" "}
                            unsaved changes
                          </span>
                        </>
                      )}
                      {counts && (counts.errors > 0 || counts.warnings > 0) && (
                        <span
                          className={
                            counts.errors > 0
                              ? "section-nav-count text-danger"
                              : "section-nav-count text-warning"
                          }
                          data-testid={`section-problems-${item.slug}`}
                        >
                          {counts.errors + counts.warnings}
                        </span>
                      )}
                    </Nav.Link>
                  );
                })}
            </div>
          ))}
        </Nav>

        {/* Under the list because it explains the list — a note about why half the
            sections are disabled is noise beside a closed disclosure. */}
        {footer && (
          <div className={open ? undefined : "d-none d-md-block"}>{footer}</div>
        )}
      </Card.Body>
    </Card>
  );
}
