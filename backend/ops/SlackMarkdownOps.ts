/**
 * **Markdown into Slack's `mrkdwn`**, made safe to post.
 *
 * A model writes CommonMark; Slack reads its own dialect
 * (https://api.slack.com/reference/surfaces/formatting): `*bold*`, `_italic_`,
 * `~strike~`, `<url|text>`, and no headings. And Slack reads `&`, `<`, and `>`
 * as control characters, so they are escaped first — which is also what keeps
 * a model from pinging a channel: `<!channel>`, `<!here>`, and `<!everyone>`
 * reach Slack as text, never as a broadcast. A person's mention (`<@U…>`)
 * survives, except the bot's own, because a bot that mentions itself starts
 * another conversation with itself.
 *
 * Code — fenced blocks and inline spans — passes through untouched.
 */

/** Slack's limit on a message's text. */
export const SLACK_MAX_MESSAGE_CHARS = 40_000;

/**
 * Escape Slack's three control characters.
 * @param text - Plain text.
 * @returns The text, escaped.
 */
export function escapeSlack(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Convert the prose (never code) of a markdown fragment.
 * @param text - Prose, not yet escaped.
 * @param selfUserId - The bot's own Slack user id, whose mention is dropped.
 * @returns The fragment in `mrkdwn`.
 */
function convertProse(text: string, selfUserId: string | null): string {
  let out = escapeSlack(text);
  // People's mentions survive; the bot's own and every broadcast do not.
  out = out.replace(/&lt;@([UW][A-Z0-9]+)(\|[^&]*)?&gt;/g, (_whole, id) =>
    id === selfUserId ? "" : `<@${id}>`,
  );
  // Links: [text](url) → <url|text>.
  out = out.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, label: string, url: string) => `<${url}|${label.replace(/\|/g, "¦")}>`,
  );
  // Headings become a bold line.
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "\u0001$1\u0001");
  // Bold (** or __) before italic, through a placeholder so `*` is not re-read.
  out = out.replace(/\*\*(.+?)\*\*/g, "\u0001$1\u0001");
  out = out.replace(/__(.+?)__/g, "\u0001$1\u0001");
  // Bullets: a leading `- ` or `* ` is a dot.
  out = out.replace(/^(\s*)[-*]\s+/gm, "$1• ");
  // Italic: *x* → _x_.
  out = out.replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1_$2_");
  // Strike.
  out = out.replace(/~~(.+?)~~/g, "~$1~");
  return out.replace(/\u0001/g, "*");
}

/**
 * **Markdown to `mrkdwn`**, escaped and sanitized.
 * @param markdown - What the model wrote.
 * @param selfUserId - The bot's own Slack user id, if known.
 * @returns Text Slack renders as intended and that pings nobody it should not.
 */
export function toMrkdwn(markdown: string, selfUserId: string | null): string {
  const parts = markdown.split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) {
        // Code keeps its characters, but Slack still needs them escaped.
        return escapeSlack(part);
      }
      return convertProse(part, selfUserId);
    })
    .join("");
}

/**
 * Truncate text to Slack's message limit, pointing at the whole of it.
 * @param text - The text, already in `mrkdwn`.
 * @param link - Where the whole text can be read.
 * @param max - The limit.
 * @returns The text, or its head and the link.
 */
export function truncateForSlack(
  text: string,
  link: string,
  max = SLACK_MAX_MESSAGE_CHARS,
): string {
  if (text.length <= max) return text;
  const tail = `\n\n… <${link}|Read the rest in Hypotenuse>`;
  return text.slice(0, max - tail.length) + tail;
}
