import {
  createElement,
  type ElementType,
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { cx } from "./cx";

/** See {@link ListRow}. */
export type ListRowProps = Omit<HTMLAttributes<HTMLElement>, "title"> & {
  /**
   * The element to render. Pass a router `Link` (with `to`) for a row that
   * opens something; `enter` then follows it natively.
   */
  as?: ElementType;
  /** A leading glyph — usually a {@link StatusGlyph}. */
  glyph?: ReactNode;
  /** An issue identifier (`ENG-142`): Inter Medium, secondary text, never mono. */
  identifier?: ReactNode;
  /** The row's title. It is the one cell that truncates. */
  title: ReactNode;
  /** Chips at the trailing edge. Dropped below 768px so a row stays one line. */
  trailing?: ReactNode;
  /** An avatar at the very end. */
  avatar?: ReactNode;
  /** Mark the row as the selected one. */
  selected?: boolean;
  /** Any further props go to the element (`to`, `href`, `data-testid`, …). */
  [prop: string]: unknown;
};

/** The attribute every row carries, which is what `j` / `k` move between. */
export const LIST_ROW_ATTRIBUTE = "data-ui-row";

/**
 * Move focus to the row `step` places away from `from`, within the document's
 * rows in DOM order. Collapsed groups hide their rows, so they are skipped.
 * @param from - The row that has focus.
 * @param step - `1` for next, `-1` for previous.
 * @returns Whether focus moved.
 */
export function focusAdjacentRow(from: Element, step: 1 | -1): boolean {
  const rows = [
    ...document.querySelectorAll<HTMLElement>(`[${LIST_ROW_ATTRIBUTE}]`),
  ].filter((row) => row.offsetParent !== null || row === from);
  const next = rows[rows.indexOf(from as HTMLElement) + step];
  if (!next) return false;
  next.focus();
  return true;
}

/**
 * One 36px row of a grouped list: glyph, identifier, title, trailing chips,
 * avatar. Rows are focusable, and `j` / `k` (or the arrow keys) move between
 * them; `enter` activates the row.
 * @param props - See {@link ListRowProps}.
 * @returns The row.
 */
export function ListRow({
  as = "div",
  glyph,
  identifier,
  title,
  trailing,
  avatar,
  selected,
  className,
  onKeyDown,
  ...props
}: ListRowProps) {
  const interactive = as !== "div" || props.onClick !== undefined;
  return createElement(
    as,
    {
      ...props,
      [LIST_ROW_ATTRIBUTE]: "",
      tabIndex: (props.tabIndex as number | undefined) ?? 0,
      role: as === "div" ? (interactive ? "button" : "listitem") : undefined,
      "aria-current": selected ? "true" : undefined,
      className: cx("ui-list-row", selected && "ui-selected", className),
      onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
        onKeyDown?.(event);
        if (event.defaultPrevented || event.metaKey || event.ctrlKey) return;
        if (event.key === "j" || event.key === "ArrowDown") {
          if (focusAdjacentRow(event.currentTarget, 1)) event.preventDefault();
        } else if (event.key === "k" || event.key === "ArrowUp") {
          if (focusAdjacentRow(event.currentTarget, -1)) event.preventDefault();
        } else if (event.key === "Enter" && as === "div") {
          event.currentTarget.click();
        }
      },
    },
    <>
      {glyph !== undefined && (
        <span className="ui-list-row-glyph">{glyph}</span>
      )}
      {identifier !== undefined && (
        <span className="ui-list-row-identifier">{identifier}</span>
      )}
      <span className="ui-list-row-title">{title}</span>
      {trailing !== undefined && (
        <span className="ui-list-row-trailing">{trailing}</span>
      )}
      {avatar !== undefined && (
        <span className="ui-list-row-avatar">{avatar}</span>
      )}
    </>,
  );
}
