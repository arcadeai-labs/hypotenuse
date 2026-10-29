/** See {@link LoadingLabel}. */
export interface LoadingLabelProps {
  /** What is being waited on. Defaults to `"Loading"`; the ellipsis is drawn by CSS. */
  label?: string;
  /**
   * Centre it in a padded block, for a wait that owns a whole page or column.
   * Off by default, which is the inline case: a line inside a card.
   */
  block?: boolean;
  /**
   * The `data-testid`. Required, with no default: two elements sharing an id
   * make Playwright's strict mode refuse the locator outright.
   */
  testId: string;
}

/**
 * What a page renders while a read is in flight and there is nothing
 * table-shaped to draw ghosts of. Words rather than a bare spinner, so a
 * screen reader says "Loading members" instead of nothing. `role="status"`
 * implies `aria-live="polite"`, so there is no separate `aria-live` here.
 *
 * It does not animate: the only continuous motion in the design is the active
 * status glyph.
 * @param props - See {@link LoadingLabelProps}.
 * @returns The rendered label.
 */
export function LoadingLabel({
  label = "Loading",
  block = false,
  testId,
}: LoadingLabelProps) {
  return (
    <p
      className={block ? "loading-label loading-label-block" : "loading-label"}
      role="status"
      data-testid={testId}
    >
      {label}
    </p>
  );
}
