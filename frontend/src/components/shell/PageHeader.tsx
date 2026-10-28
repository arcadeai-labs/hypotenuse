import type { ReactNode } from "react";

/** See {@link PageHeader}. */
export interface PageHeaderProps {
  title: ReactNode;
  /** Filter chips, drawn after the title. */
  filters?: ReactNode;
  /** The Display menu (grouping and ordering). */
  display?: ReactNode;
  /** Right-aligned actions. */
  actions?: ReactNode;
}

/**
 * A page's header row: title, filter chips, the Display menu, and actions.
 * @param props - See {@link PageHeaderProps}.
 * @returns The header.
 */
export function PageHeader({
  title,
  filters,
  display,
  actions,
}: PageHeaderProps) {
  return (
    <header className="shell-page-header" data-testid="page-header">
      <h1 className="shell-page-title">{title}</h1>
      {filters && <div className="shell-page-filters">{filters}</div>}
      <div className="shell-page-actions">
        {display}
        {actions}
      </div>
    </header>
  );
}
