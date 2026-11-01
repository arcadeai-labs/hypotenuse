/**
 * **Text between Hypotenuse and Pylon.** Pylon takes and gives HTML
 * (`body_html`, `message_html`); a bot writes markdown and reads plain text.
 *
 * - {@link markdownToPylonHtml}: every character the model wrote is escaped
 *   first, then a small, closed set of markdown is turned into tags —
 *   paragraphs, line breaks, headings, bullet and numbered lists, fenced and
 *   inline code, bold, italic, and `http(s)` links. Nothing the model writes
 *   can become a tag of its own choosing, an attribute, or a `javascript:` link.
 * - {@link pylonHtmlToText}: tags dropped (block tags become line breaks),
 *   entities decoded, whitespace folded — what a model reads of a message.
 * - Bodies past {@link PYLON_BODY_MAX_CHARS} are cut at a line boundary with a
 *   note that says so.
 */

/** The longest markdown body written to Pylon, in characters. */
export const PYLON_BODY_MAX_CHARS = 30_000;

/**
 * Escape text for HTML.
 * @param s - The text.
 * @returns It, with `& < > " '` escaped.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The inline markdown of one escaped line: code, links, bold, italic.
 * @param escaped - A line, already HTML-escaped.
 * @returns The line with inline tags.
 */
function inline(escaped: string): string {
  const codes: string[] = [];
  let s = escaped.replace(/`([^`]+)`/g, (_, c: string) => {
    codes.push(`<code>${c}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_, text: string, url: string) => `<a href="${url}">${text}</a>`,
  );
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)]);
}

/**
 * Cut a body to size at a line boundary.
 * @param text - The markdown.
 * @returns It, or its head and a note.
 */
function capped(text: string): string {
  if (text.length <= PYLON_BODY_MAX_CHARS) return text;
  const head = text.slice(0, PYLON_BODY_MAX_CHARS);
  const cut = head.lastIndexOf("\n");
  return `${cut > 0 ? head.slice(0, cut) : head}\n\n(cut here: the rest is in the transcript)`;
}

/**
 * **Markdown to the HTML Pylon takes.**
 * @param markdown - What the bot wrote.
 * @returns Safe `body_html`.
 */
export function markdownToPylonHtml(markdown: string): string {
  const lines = capped(
    markdown.replace(/\u0000/g, "").replace(/\r\n?/g, "\n"),
  ).split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length > 0) out.push(`<p>${para.join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) {
      out.push(
        `<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`,
      );
    }
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      flushPara();
      flushList();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) {
        code.push(escapeHtml(lines[i]));
      }
      out.push(`<pre><code>${code.join("\n")}</code></pre>`);
      continue;
    }
    if (line.trim() === "") {
      flushPara();
      flushList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inline(escapeHtml(heading[2]))}</h${level}>`);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    const item = bullet ?? numbered;
    if (item) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push(inline(escapeHtml(item[1])));
      continue;
    }
    flushList();
    para.push(inline(escapeHtml(line)));
  }
  flushPara();
  flushList();
  return out.join("");
}

/** The entities Pylon's HTML carries, decoded. */
const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
};

/**
 * **Pylon's HTML to plain text**, for the model to read.
 * @param html - A message's `message_html` or an issue's `body_html`.
 * @returns The text.
 */
export function pylonHtmlToText(html: string | null | undefined): string {
  return String(html ?? "")
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6]|pre|blockquote|tr)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "- ")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      const lower = e.toLowerCase();
      if (ENTITIES[lower] !== undefined) return ENTITIES[lower];
      if (lower.startsWith("#x"))
        return String.fromCodePoint(Number.parseInt(lower.slice(2), 16));
      if (lower.startsWith("#"))
        return String.fromCodePoint(Number.parseInt(lower.slice(1), 10));
      return m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
