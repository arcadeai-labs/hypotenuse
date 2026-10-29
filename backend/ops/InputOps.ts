import { z } from "zod";

/**
 * The largest id a `serial` column holds. An id past it is not one that could
 * exist, and handing it to Postgres would fail the query (a 500 carrying the
 * SQL) instead of answering like any other unknown id.
 */
export const MAX_ID = 2_147_483_647;

/**
 * A positive integer id, coerced from the path or query string where every value
 * arrives as text.
 * @param description - What the id names, for the MCP tool description.
 * @returns The Zod schema.
 */
export function idInput(description: string) {
  return z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_ID, "No such id")
    .describe(description);
}

/**
 * An email address, lowercased before it reaches the database so every email
 * comparison in the app is case-insensitive.
 * @param description - What the address is for.
 * @returns The Zod schema.
 */
export function emailInput(description: string) {
  return z
    .string()
    .trim()
    .refine(
      (val) => val.includes("@") && val.includes("."),
      "Must be a valid email address",
    )
    .transform((val) => val.toLowerCase())
    .describe(description);
}

/**
 * A display name for a person, organization, or project: 3 to 256 characters.
 * @param description - What is being named.
 * @returns The Zod schema.
 */
export function nameInput(description: string) {
  return z
    .string()
    .trim()
    .min(3, "Name must be at least 3 characters")
    .max(256, "Name must be less than 256 characters")
    .describe(description);
}
