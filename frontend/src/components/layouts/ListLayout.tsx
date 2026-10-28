import type { ReactNode } from "react";
import { PageHeader, type PageHeaderProps } from "../shell/PageHeader";

/** See {@link ListLayout}. */
export interface ListLayoutProps extends PageHeaderProps {
  /** Placeholder for a search field; omitted means the page has no search. */
  searchPlaceholder?: string;
  onSearch?: (query: string) => void;
  children: ReactNode;
}

/**
 * A list page: header, an optional search field (the `/` shortcut focuses any
 * element carrying `data-search`), and the grouped list.
 * @param props - See {@link ListLayoutProps}.
 * @returns The layout.
 */
export function ListLayout({
  searchPlaceholder,
  onSearch,
  children,
  ...header
}: ListLayoutProps) {
  return (
    <div className="shell-layout-list" data-testid="list-layout">
      <PageHeader {...header} />
      {searchPlaceholder !== undefined && (
        <div className="shell-search">
          <input
            type="search"
            className="shell-search-input"
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            data-search
            onChange={(event) => onSearch?.(event.target.value)}
          />
        </div>
      )}
      <div className="shell-list-body">{children}</div>
    </div>
  );
}
