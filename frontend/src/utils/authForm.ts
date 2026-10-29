/** What a sign-in or sign-up form validates on the client. */
export interface AuthFields {
  email: string;
  password: string;
  name?: string;
}

/** The shortest password the form accepts; `user:create` refuses shorter. */
export const MIN_PASSWORD_LENGTH = 8;

/** The shortest name the form accepts; `user:create` refuses shorter. */
export const MIN_NAME_LENGTH = 3;

/**
 * Validate an auth form on the client, with the same limits the server
 * enforces, so a refusal the browser could have predicted never costs a round
 * trip.
 * @param fields - The current values.
 * @param requireName - Whether a name is required (sign-up).
 * @returns Field name → message, empty when valid.
 */
export function validateAuthFields(
  fields: AuthFields,
  requireName = false,
): Partial<Record<keyof AuthFields, string>> {
  const errors: Partial<Record<keyof AuthFields, string>> = {};
  const name = fields.name?.trim() ?? "";
  if (requireName && !name) errors.name = "Enter your name.";
  else if (requireName && name.length < MIN_NAME_LENGTH) {
    errors.name = `Use at least ${MIN_NAME_LENGTH} characters.`;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email.trim()))
    errors.email = "Enter an email address.";
  if (fields.password.length < MIN_PASSWORD_LENGTH) {
    errors.password = `Use at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return errors;
}
