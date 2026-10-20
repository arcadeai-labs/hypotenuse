/** What a sign-in or sign-up form validates on the client. */
export interface AuthFields {
  email: string;
  password: string;
  name?: string;
}

/** The shortest password the form accepts. */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Validate an auth form on the client.
 * @param fields - The current values.
 * @param requireName - Whether a name is required (sign-up).
 * @returns Field name → message, empty when valid.
 */
export function validateAuthFields(
  fields: AuthFields,
  requireName = false,
): Partial<Record<keyof AuthFields, string>> {
  const errors: Partial<Record<keyof AuthFields, string>> = {};
  if (requireName && !fields.name?.trim()) errors.name = "Enter your name.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email.trim()))
    errors.email = "Enter an email address.";
  if (fields.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return errors;
}
