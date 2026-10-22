import {
  TOOL_BODY_MAX_BYTES,
  TOOL_RESULT_MAX_BYTES,
} from "@hypotenuse/protocol";
import { ErrorType, TypedError } from "keryx";

/**
 * What the agent tools write to Linear and read back, kept to size.
 *
 * - **Bodies are not rewritten.** A comment, description, or document the agent
 *   writes goes to Linear as it wrote it, with NUL bytes stripped and a 64 KB
 *   ceiling. Linear itself turns issue and profile URLs into mentions and
 *   renders `+++ Title … +++` as a collapsible section, so neither needs help
 *   here.
 * - **Results are capped.** A tool result is at most 16 KB, cut at a line
 *   boundary with a note telling the agent to narrow its request; an issue
 *   description shown by `linear_get_issue` is at most 8 KB.
 */

/** The largest issue description `linear_get_issue` shows, in bytes. */
export const DESCRIPTION_MAX_BYTES = 8 * 1024;

/** The note a cut tool result ends with. */
export const TRUNCATED_NOTE =
  "… (truncated; ask for fewer items or a narrower query)";

/**
 * A string's size in UTF-8 bytes.
 * @param text - The text.
 * @returns Its byte length.
 */
export function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/**
 * Cut text to at most `max` UTF-8 bytes without splitting a character.
 * @param text - The text.
 * @param max - The byte budget.
 * @returns The longest prefix that fits.
 */
function cutToBytes(text: string, max: number): string {
  if (byteLength(text) <= max) return text;
  const bytes = Buffer.from(text, "utf8").subarray(0, max);
  // A cut inside a multi-byte character decodes to U+FFFD; drop it.
  return bytes.toString("utf8").replace(/�+$/, "");
}

/**
 * A body the agent wants written to Linear: NUL bytes stripped, and refused
 * when larger than {@link TOOL_BODY_MAX_BYTES}.
 * @param body - The comment, description, or document.
 * @param what - What it is, for the refusal ("The comment").
 * @returns The body to send.
 * @throws {TypedError} 406 naming the size.
 */
export function bodyForLinear(body: string, what: string): string {
  const clean = body.replaceAll("\0", "");
  const size = byteLength(clean);
  if (size > TOOL_BODY_MAX_BYTES) {
    throw new TypedError({
      message: `${what} is ${size} bytes; Linear takes at most ${TOOL_BODY_MAX_BYTES}. Shorten it, or put the detail in a document or the pull request.`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
    });
  }
  if (!clean.trim()) {
    throw new TypedError({
      message: `${what} is empty`,
      type: ErrorType.CONNECTION_ACTION_PARAM_VALIDATION,
    });
  }
  return clean;
}

/**
 * Cut a tool result to {@link TOOL_RESULT_MAX_BYTES} at a line boundary,
 * ending with {@link TRUNCATED_NOTE}.
 * @param text - The Markdown result.
 * @param max - The budget (tests pass a smaller one).
 * @returns The text, whole or cut.
 */
export function capResult(text: string, max = TOOL_RESULT_MAX_BYTES): string {
  if (byteLength(text) <= max) return text;
  const room = max - byteLength(`\n${TRUNCATED_NOTE}`);
  const prefix = cutToBytes(text, Math.max(room, 0));
  const lastLine = prefix.lastIndexOf("\n");
  const kept = lastLine > 0 ? prefix.slice(0, lastLine) : prefix;
  return `${kept}\n${TRUNCATED_NOTE}`;
}

/**
 * An issue description cut to {@link DESCRIPTION_MAX_BYTES}, pointing at the
 * issue for the rest.
 * @param description - The description.
 * @param url - The issue's URL.
 * @returns The description, whole or cut.
 */
export function capDescription(description: string, url: string): string {
  if (byteLength(description) <= DESCRIPTION_MAX_BYTES) return description;
  const room = DESCRIPTION_MAX_BYTES - 200;
  const prefix = cutToBytes(description, room);
  const lastLine = prefix.lastIndexOf("\n");
  const kept = lastLine > room / 2 ? prefix.slice(0, lastLine) : prefix;
  return `${kept}\n\n… (description truncated; the rest is at ${url})`;
}

/**
 * One line of Markdown for a person, as a link to their profile — which is
 * how the agent mentions them.
 * @param person - The person, or null.
 * @returns `[Name](url)`, or `nobody`.
 */
export function personLink(
  person: { name: string; url: string } | null | undefined,
): string {
  return person ? `[${person.name}](${person.url})` : "nobody";
}
