import type { ReactNode } from "react";
import { PageHeader, type PageHeaderProps } from "../shell/PageHeader";

/** See {@link DetailLayout}. */
export interface DetailLayoutProps extends PageHeaderProps {
  /** The 280px right-hand column, normally a `PropertiesPanel`. Moves under the main column below 768px. */
  properties?: ReactNode;
  children: ReactNode;
}

/**
 * A detail page: header, a main column, and the properties panel.
 * @param props - See {@link DetailLayoutProps}.
 * @returns The layout.
 */
export function DetailLayout({
  properties,
  children,
  ...header
}: DetailLayoutProps) {
  return (
    <div className="shell-layout-detail" data-testid="detail-layout">
      <PageHeader {...header} />
      <div className="shell-detail-body">
        <div className="shell-detail-main">{children}</div>
        {properties && (
          <div className="shell-detail-properties">{properties}</div>
        )}
      </div>
    </div>
  );
}
