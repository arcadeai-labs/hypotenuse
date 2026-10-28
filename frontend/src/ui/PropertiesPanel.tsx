import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

/**
 * The 280px right-hand panel of a detail view. Below 768px it moves under the
 * main column; `DetailLayout` decides where, this only draws the panel.
 * @param props - `title` (default "Properties") and native aside props.
 * @returns The panel.
 */
export function PropertiesPanel({
  title = "Properties",
  className,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLElement>, "title"> & { title?: ReactNode }) {
  return (
    <aside
      {...props}
      className={cx("ui-properties", className)}
      aria-label={typeof title === "string" ? title : "Properties"}
    >
      {title !== null && <h2 className="ui-properties-title">{title}</h2>}
      <dl className="ui-properties-list">{children}</dl>
    </aside>
  );
}

/**
 * One label / value row of a {@link PropertiesPanel}. The value can be text,
 * chips, or a link.
 * @param props - `label`, the value as children, and native div props.
 * @returns The row.
 */
export function Property({
  label,
  className,
  children,
  ...props
}: HTMLAttributes<HTMLDivElement> & { label: ReactNode }) {
  return (
    <div {...props} className={cx("ui-property", className)}>
      <dt className="ui-property-label">{label}</dt>
      <dd className="ui-property-value">{children}</dd>
    </div>
  );
}
