/**
 * **Text a bot writes into Linear**, made safe and kept to size.
 *
 * - **No literal mention of the bot.** Linear turns `@<app name>` into a real
 *   mention, and a mention of an agent opens a new agent session — so a bot
 *   that quoted its own name would start talking to itself. Every `@` that
 *   names the bot gets a zero-width space after it: the text reads the same,
 *   and Linear sees no mention.
 * - **NUL bytes stripped**, and a body past {@link LINEAR_BODY_MAX_CHARS} cut
 *   at a line boundary with a link to the transcript for the rest.
 */

/** The longest body written to Linear, in characters. */
export const LINEAR_BODY_MAX_CHARS = 60_000;

/**
 * Escape a string for use inside a regular expression.
 * @param s - The string.
 * @returns It, with every metacharacter escaped.
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The handles Linear could read as a mention of the bot: its name, and its
 * name without spaces (how Linear's mention menu writes a multi-word name).
 * @param names - The bot's names in Linear (the app user's, the bot's own).
 * @returns The distinct handles, longest first.
 */
function handles(names: (string | null | undefined)[]): string[] {
  const out = new Set<string>();
  for (const n of names) {
    const name = (n ?? "").trim();
    if (name.length < 2) continue;
    out.add(name);
    out.add(name.replace(/\s+/g, ""));
  }
  return [...out].sort((a, b) => b.length - a.length);
}

/**
 * Neutralize every mention of the bot in text bound for Linear.
 * @param text - The text.
 * @param names - The bot's names in Linear.
 * @returns The text, with no `@<name>` Linear would read as a mention.
 */
export function neutralizeSelfMentions(
  text: string,
  names: (string | null | undefined)[],
): string {
  let out = text;
  for (const handle of handles(names)) {
    out = out.replace(new RegExp(`@(${escapeRegExp(handle)})`, "gi"), "@​$1");
  }
  return out;
}

/**
 * **A body for Linear**: NUL bytes stripped, the bot's own mentions
 * neutralized, and cut to {@link LINEAR_BODY_MAX_CHARS} with a link.
 * @param text - The markdown.
 * @param names - The bot's names in Linear.
 * @param link - Where the whole text can be read, for a cut body.
 * @returns The body to send.
 */
export function bodyForLinear(
  text: string,
  names: (string | null | undefined)[],
  link: string,
): string {
  const clean = neutralizeSelfMentions(text.replaceAll("\0", ""), names);
  if (clean.length <= LINEAR_BODY_MAX_CHARS) return clean;
  const note = `\n\n… (cut; the whole message is at ${link})`;
  const room = clean.slice(0, LINEAR_BODY_MAX_CHARS - note.length);
  const lastLine = room.lastIndexOf("\n");
  return `${lastLine > room.length / 2 ? room.slice(0, lastLine) : room}${note}`;
}
