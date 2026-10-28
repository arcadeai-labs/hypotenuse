import { Button, type ButtonProps } from "../ui";

/** See {@link GatedButton}. */
export type GatedButtonProps = ButtonProps & {
  /**
   * Why the person may not use it, from `useMay().reason(action)`. Set, the
   * button is drawn disabled with this as its `title`; unset, it is a button.
   */
  deniedReason?: string;
};

/**
 * A button that a refusal disables rather than removes: the control stays
 * where it is, says why on hover and to a screen reader, and does nothing.
 * Disabled, never absent, so a page has one shape for everyone who can see it.
 * @param props - Button props plus `deniedReason`.
 * @returns The button.
 */
export function GatedButton({
  deniedReason,
  disabled,
  title,
  ...props
}: GatedButtonProps) {
  return (
    <Button
      {...props}
      disabled={disabled || deniedReason !== undefined}
      title={deniedReason ?? title}
      aria-disabled={deniedReason !== undefined ? true : undefined}
      data-denied={deniedReason !== undefined ? "true" : undefined}
    />
  );
}
