import {
  type HTMLAttributes,
  type ReactNode,
  useEffect,
  useId,
  useRef,
} from "react";
import { cx } from "./cx";

/** See {@link Sheet}. */
export type SheetProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  open: boolean;
  onClose: () => void;
  /** The edge it slides from. The mobile sidebar is `left`; the properties drawer is `right`. */
  side?: "left" | "right";
  /** Heading, also the dialog's accessible name. */
  title?: ReactNode;
};

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * A side drawer: the sidebar below 768px, and the narrow-viewport properties
 * drawer. `Escape` and a backdrop click close it; `Tab` stays inside while it is
 * open, and focus returns to whatever opened it.
 * @param props - See {@link SheetProps}.
 * @returns The sheet, or `null` when closed.
 */
export function Sheet({
  open,
  onClose,
  side = "left",
  title,
  className,
  children,
  ...props
}: SheetProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const opener =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const first = panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel.current)?.focus();
    /**
     * Close on `Escape`; wrap `Tab` at either end of the sheet.
     * @param event - The key event.
     */
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) return;
      const head = items[0];
      const tail = items[items.length - 1];
      if (event.shiftKey && document.activeElement === head) {
        event.preventDefault();
        tail?.focus();
      } else if (!event.shiftKey && document.activeElement === tail) {
        event.preventDefault();
        head?.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      opener?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div
      className="ui-sheet-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        {...props}
        ref={panel}
        className={cx("ui-sheet", `ui-sheet-${side}`, className)}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title !== undefined ? titleId : undefined}
        tabIndex={-1}
      >
        {title !== undefined && (
          <div className="ui-sheet-header">
            <h2 id={titleId} className="ui-sheet-title">
              {title}
            </h2>
            <button
              type="button"
              className="ui-close"
              aria-label="Close"
              onClick={onClose}
            >
              ×
            </button>
          </div>
        )}
        <div className="ui-sheet-body">{children}</div>
      </div>
    </div>
  );
}
