import { z } from "zod";

/**
 * Memory's text handling, ported from membot's chunker and search text and
 * botholomew's line patches: how a document is split into chunks, what each
 * chunk is indexed as, how a path is written, and how a patch edits lines.
 * Pure functions; nothing here touches the database.
 */

/** A chunk aims for this many characters. */
export const CHUNK_TARGET_CHARS = 1400;

/** No chunk is longer than this. */
export const CHUNK_MAX_CHARS = 1800;

/** A document shorter than this is one chunk, whatever its shape. */
const SHORT_CONTENT_THRESHOLD = 200;

/** Lines repeated from the end of one piece at the start of the next. */
const OVERLAP_LINES = 2;

/** The most a description adds to a chunk's search text. */
export const DESCRIPTION_MAX_CHARS = 240;

/**
 * The search-text recipe's version. It is part of the embedding revision, so
 * changing {@link buildSearchText} makes every stored vector stale.
 */
export const SEARCH_TEXT_RECIPE = "path-desc-crumb-body.v1";

/** One chunk of a document. */
export interface Chunk {
  index: number;
  body: string;
  /** The headings that scope the chunk ("Doc > Section"), or "" for none. */
  breadcrumb: string;
}

/**
 * Split text into pieces of at most `maxChars`, preferring paragraph, then
 * line, then hard character boundaries.
 * @param text - The text.
 * @param maxChars - The largest piece.
 * @returns The pieces, in order.
 */
export function splitText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const pack = (parts: string[], joiner: string): string[] => {
    const out: string[] = [];
    let buf = "";
    for (const part of parts) {
      const candidate = buf ? `${buf}${joiner}${part}` : part;
      if (candidate.length <= maxChars) {
        buf = candidate;
        continue;
      }
      if (buf) out.push(buf);
      if (part.length <= maxChars) {
        buf = part;
      } else {
        out.push(...splitText(part, maxChars));
        buf = "";
      }
    }
    if (buf) out.push(buf);
    return out;
  };
  const paragraphs = text.split(/\n\n+/);
  if (paragraphs.length > 1) return pack(paragraphs, "\n\n");
  const lines = text.split("\n");
  if (lines.length > 1) return pack(lines, "\n");
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    out.push(text.slice(i, i + maxChars));
  }
  return out;
}

/**
 * Repeat the last lines of each piece at the start of the next, so a concept
 * spanning a cut stays findable from either side.
 * @param pieces - The pieces.
 * @returns The overlapped pieces.
 */
function addOverlap(pieces: string[]): string[] {
  return pieces.map((piece, i) => {
    if (i === 0) return piece;
    const overlap = pieces[i - 1].split("\n").slice(-OVERLAP_LINES).join("\n");
    return `${overlap}\n${piece}`;
  });
}

/** One heading-delimited slice of a markdown document. */
interface Section {
  ancestors: string[];
  heading: string | null;
  text: string;
}

const ATX_HEADING = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/;

/**
 * Split markdown at its headings, tracking the heading stack. A heading
 * inside a fenced code block is not a boundary.
 * @param content - The markdown.
 * @returns The sections, which rejoined with "\n" are the document.
 */
export function parseSections(content: string): Section[] {
  const sections: Section[] = [];
  const stack: { level: number; title: string }[] = [];
  let current: Section = { ancestors: [], heading: null, text: "" };
  let lines: string[] = [];
  let fence: { char: string; len: number } | null = null;
  const flush = () => {
    if (lines.length === 0) return;
    current.text = lines.join("\n");
    sections.push(current);
    lines = [];
  };
  for (const line of content.split("\n")) {
    if (fence) {
      lines.push(line);
      const m = line.match(FENCE_CLOSE);
      if (m && m[1][0] === fence.char && m[1].length >= fence.len) fence = null;
      continue;
    }
    const open = line.match(FENCE_OPEN);
    if (open) {
      fence = { char: open[1][0], len: open[1].length };
      lines.push(line);
      continue;
    }
    const heading = line.match(ATX_HEADING);
    if (heading) {
      flush();
      const level = heading[1].length;
      const title = heading[2].trim();
      while (stack.length > 0 && stack[stack.length - 1].level >= level) {
        stack.pop();
      }
      current = {
        ancestors: stack.map((s) => s.title),
        heading: title,
        text: "",
      };
      stack.push({ level, title });
    }
    lines.push(line);
  }
  flush();
  return sections;
}

/**
 * A breadcrumb from heading titles.
 * @param parts - The titles, outermost first.
 * @returns `"A > B"`, or `""`.
 */
function crumb(parts: string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(" > ");
}

/**
 * Re-split any chunk longer than {@link CHUNK_MAX_CHARS}, and renumber.
 * @param chunks - The chunks.
 * @returns Chunks that all fit.
 */
function enforceMax(chunks: Omit<Chunk, "index">[]): Chunk[] {
  const out: Chunk[] = [];
  for (const c of chunks) {
    for (const body of splitText(c.body, CHUNK_MAX_CHARS)) {
      out.push({ index: out.length, body, breadcrumb: c.breadcrumb });
    }
  }
  return out;
}

/**
 * **Chunk a document.** Short documents are one chunk. Markdown with headings
 * is packed section by section up to {@link CHUNK_TARGET_CHARS}, never
 * splitting inside a code fence unless one section alone is too large; each
 * chunk carries the breadcrumb of the headings above its first line. Anything
 * else splits at paragraphs and lines, with a little overlap.
 * @param content - The document.
 * @returns The chunks, in order, none longer than {@link CHUNK_MAX_CHARS}.
 */
export function chunkDocument(content: string): Chunk[] {
  if (content.trim() === "") return [];
  if (content.length < SHORT_CONTENT_THRESHOLD) {
    return [{ index: 0, body: content, breadcrumb: "" }];
  }
  const sections = parseSections(content);
  if (!sections.some((s) => s.heading !== null)) {
    return enforceMax(
      addOverlap(splitText(content, CHUNK_TARGET_CHARS)).map((body) => ({
        body,
        breadcrumb: "",
      })),
    );
  }
  const out: Omit<Chunk, "index">[] = [];
  let buf = "";
  let bufCrumb = "";
  const flush = () => {
    if (buf === "") return;
    out.push({ body: buf, breadcrumb: bufCrumb });
    buf = "";
    bufCrumb = "";
  };
  for (const section of sections) {
    const candidate = buf ? `${buf}\n${section.text}` : section.text;
    if (candidate.length <= CHUNK_TARGET_CHARS) {
      if (buf === "") bufCrumb = crumb(section.ancestors);
      buf = candidate;
      continue;
    }
    flush();
    if (section.text.length <= CHUNK_TARGET_CHARS) {
      buf = section.text;
      bufCrumb = crumb(section.ancestors);
      continue;
    }
    const pieces = addOverlap(splitText(section.text, CHUNK_TARGET_CHARS));
    const inner = crumb(
      section.heading !== null
        ? [...section.ancestors, section.heading]
        : section.ancestors,
    );
    pieces.forEach((body, i) => {
      out.push({
        body,
        breadcrumb: i === 0 ? crumb(section.ancestors) : inner,
      });
    });
  }
  flush();
  return enforceMax(out);
}

/**
 * Cut text to at most `max` characters at a word boundary, with an ellipsis.
 * @param text - The text.
 * @param max - The limit.
 * @returns The text, or its cut.
 */
export function truncateAtWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const slice = text.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > max * 0.5 ? slice.slice(0, lastSpace) : slice;
  return `${cut.trimEnd()}…`;
}

/**
 * **The search text** of a chunk — what is embedded and what the `tsvector`
 * is computed from: the path, the description, the breadcrumb, a blank
 * line, and the body. A query for a path or a heading finds the chunk.
 * @param logicalPath - The document's path.
 * @param description - Its description.
 * @param chunk - The chunk.
 * @returns The text.
 */
export function buildSearchText(
  logicalPath: string,
  description: string,
  chunk: Pick<Chunk, "body" | "breadcrumb">,
): string {
  const desc = truncateAtWord(description.trim(), DESCRIPTION_MAX_CHARS);
  const head = chunk.breadcrumb
    ? `${logicalPath}\n${desc}\n${chunk.breadcrumb}`
    : `${logicalPath}\n${desc}`;
  return `${head}\n\n${chunk.body}`;
}

/**
 * The input for a memory path: relative, slash-separated, made of letters,
 * digits, dots, dashes, and underscores, with no empty or `.`/`..` segment.
 * Leading slashes are dropped, and a path without an extension gets `.md`.
 */
export const memoryPathInput = z
  .string()
  .trim()
  .min(1, "A path is required")
  .max(200, "A path is at most 200 characters")
  .transform((p) => normalizeMemoryPath(p))
  .refine((p) => p !== null, {
    message:
      "A path is slash-separated words of letters, digits, dots, dashes, and underscores, such as facts/deploy-process.md",
  })
  .transform((p) => p as string)
  .describe(
    "The document's path, such as people/alex.md or facts/deploy-process.md",
  );

/**
 * Normalize a memory path, or refuse it.
 * @param raw - What was given.
 * @returns The path, or `null` when it cannot be one.
 */
export function normalizeMemoryPath(raw: string): string | null {
  const trimmed = raw.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed === "") return null;
  const segments = trimmed.split("/");
  for (const s of segments) {
    if (!/^[A-Za-z0-9._-]+$/.test(s) || s === "." || s === "..") return null;
  }
  const last = segments[segments.length - 1];
  return last.includes(".") ? segments.join("/") : `${segments.join("/")}.md`;
}

/** A path prefix filter: the same characters, any shape. */
export const memoryPathPrefixInput = z
  .string()
  .trim()
  .max(200)
  .regex(
    /^[A-Za-z0-9._/-]*$/,
    "Letters, digits, dots, dashes, underscores, and slashes",
  )
  .transform((p) => p.replace(/^\/+/, ""))
  .describe("Only documents whose path starts with this, such as people/");

/** One line-range replacement, 1-based and inclusive, as botholomew's patches. */
export interface LinePatch {
  start_line: number;
  end_line: number;
  content: string;
}

/** The input for one {@link LinePatch}. */
export const linePatchInput = z.object({
  start_line: z
    .number()
    .int()
    .positive()
    .describe("1-based inclusive start line"),
  end_line: z
    .number()
    .int()
    .min(0)
    .describe(
      "1-based inclusive end line (0 inserts before start_line without replacing)",
    ),
  content: z
    .string()
    .describe("The replacement text (empty to delete the lines)"),
});

/**
 * Apply line patches, bottom-up so earlier line numbers stay valid.
 * @param raw - The document.
 * @param patches - The patches.
 * @returns The patched document.
 * @throws {Error} With a sentence naming the bad patch, for a range outside
 *   the document or patches that overlap.
 */
export function applyLinePatches(raw: string, patches: LinePatch[]): string {
  const lines = raw.split("\n");
  const sorted = [...patches].sort((a, b) => b.start_line - a.start_line);
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    const insert = p.end_line === 0;
    if (
      p.start_line > lines.length + 1 ||
      (!insert && p.end_line > lines.length)
    ) {
      throw new Error(
        `Lines ${p.start_line}–${p.end_line} are outside the document, which has ${lines.length} lines.`,
      );
    }
    if (!insert && p.end_line < p.start_line) {
      throw new Error(
        `end_line ${p.end_line} is before start_line ${p.start_line}.`,
      );
    }
    const next = sorted[i + 1];
    if (next && next.end_line !== 0 && next.end_line >= p.start_line) {
      throw new Error(
        `The patches at lines ${next.start_line} and ${p.start_line} overlap.`,
      );
    }
  }
  for (const p of sorted) {
    const insertLines = p.content === "" ? [] : p.content.split("\n");
    if (p.end_line === 0) lines.splice(p.start_line - 1, 0, ...insertLines);
    else
      lines.splice(
        p.start_line - 1,
        p.end_line - p.start_line + 1,
        ...insertLines,
      );
  }
  return lines.join("\n");
}

/**
 * Number a document's lines, as `memory_read` shows them.
 * @param content - The document.
 * @param startLine - The first line to show (1-based).
 * @param endLine - The last line to show, inclusive.
 * @returns The lines, each prefixed with its number and a tab.
 */
export function numberLines(
  content: string,
  startLine = 1,
  endLine = Number.MAX_SAFE_INTEGER,
): { text: string; totalLines: number } {
  const lines = content.split("\n");
  const from = Math.max(1, startLine);
  const to = Math.min(lines.length, endLine);
  const text = lines
    .slice(from - 1, to)
    .map((line, i) => `${from + i}\t${line}`)
    .join("\n");
  return { text, totalLines: lines.length };
}
