import type { ReactNode } from "react";
import { Button, Modal } from "../ui";

/** See {@link ConfirmDialog}. */
export interface ConfirmDialogProps {
  /** Whether it is open. */
  show: boolean;
  /** The question, e.g. "Delete Ada?". */
  title: string;
  /** What happens if they go ahead. */
  children: ReactNode;
  /** The confirming button's label, which names the act: "Delete bot". */
  confirmLabel: string;
  /** Whether the act is under way; disables both buttons. */
  busy?: boolean;
  /** Go ahead. */
  onConfirm: () => void;
  /** Close without doing anything. */
  onCancel: () => void;
  /** Keys the dialog's test ids: `<testId>-dialog`, `<testId>-confirm`, `<testId>-cancel`. */
  testId: string;
}

/**
 * Ask before an act that cannot be undone. The confirming button names the
 * act rather than saying "OK", and Cancel is the one focused first, so a
 * stray Enter does nothing irreversible.
 * @param props - See {@link ConfirmDialogProps}.
 * @returns The dialog, or nothing while closed.
 */
export function ConfirmDialog({
  show,
  title,
  children,
  confirmLabel,
  busy = false,
  onConfirm,
  onCancel,
  testId,
}: ConfirmDialogProps) {
  return (
    <Modal
      show={show}
      onHide={onCancel}
      size="sm"
      data-testid={`${testId}-dialog`}
    >
      <Modal.Header closeButton>
        <Modal.Title>{title}</Modal.Title>
      </Modal.Header>
      <Modal.Body>{children}</Modal.Body>
      <Modal.Footer>
        <Button
          variant="outline-secondary"
          disabled={busy}
          autoFocus
          onClick={onCancel}
          data-testid={`${testId}-cancel`}
        >
          Cancel
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={onConfirm}
          data-testid={`${testId}-confirm`}
        >
          {confirmLabel}
        </Button>
      </Modal.Footer>
    </Modal>
  );
}
