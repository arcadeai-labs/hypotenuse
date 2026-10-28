/**
 * Join optional class names without leaking booleans into markup.
 * @param values - Class names, or falsy values to skip.
 * @returns The space-joined class list.
 */
export function cx(
  ...values: Array<string | false | null | undefined>
): string {
  return values.filter(Boolean).join(" ");
}
