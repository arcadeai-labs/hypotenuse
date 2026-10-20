/**
 * Pretty-print a JSON value into highlighted tokens.
 *
 * `JSON.stringify(value, null, 2)` is the source of truth for the text — so a
 * copy of what is on screen is still valid JSON, including omitted `undefined`
 * keys and the scientific notation stringify picks for huge numbers. The
 * tokenizer then walks that string and labels each span. Classification lives
 * here rather than in the component so the kinds can be asserted without a
 * render harness.
 */

/** The token kinds `.tx-json-*` in `theme.scss` styles. */
export type JsonHighlightKind =
  | "key"
  | "string"
  | "number"
  | "boolean"
  | "null"
  | "punctuation"
  | "whitespace";

/** One span of pretty-printed JSON. Concatenating `text` rebuilds the source. */
export interface JsonHighlightToken {
  /** Which `.tx-json-*` class this span wears. */
  kind: JsonHighlightKind;
  /** The source characters, including quotes around keys and strings. */
  text: string;
}

const WHITESPACE = new Set([" ", "\n", "\r", "\t"]);

/**
 * Pretty-print `value` and split it into highlighted tokens.
 *
 * A value `JSON.stringify` cannot print (a circular object, a BigInt) becomes a
 * quoted string of its `String()` form rather than throwing through the page.
 * Top-level `undefined` — stringify's empty result — yields no tokens.
 * @param value - Any JSON-encodable value.
 * @returns Tokens whose `text` concatenates to the pretty-printed source.
 */
export function highlightJson(value: unknown): JsonHighlightToken[] {
  let source: string | undefined;
  try {
    source = JSON.stringify(value, null, 2);
  } catch {
    source = JSON.stringify(String(value));
  }
  if (source === undefined) return [];
  return tokenizeJson(source);
}

/**
 * Label every character of a well-formed JSON document.
 *
 * Object vs array context is what distinguishes a key from a string value: a
 * quoted span immediately inside `{` or after a comma in an object is a key;
 * every other quoted span is a string. The input is stringify's own output, so
 * the grammar is the subset it emits, not the full RFC.
 * @param source - Pretty-printed JSON.
 * @returns The labelled spans, covering `source` without gaps or overlap.
 */
function tokenizeJson(source: string): JsonHighlightToken[] {
  const tokens: JsonHighlightToken[] = [];
  // `"object-key"` means the next quoted span in this frame is a property name.
  const stack: Array<"object-key" | "object-value" | "array"> = [];
  let i = 0;

  /**
   * Advance while `pred` holds and return the consumed slice.
   * @param pred - Whether the current character belongs to this token.
   * @returns The consumed characters.
   */
  const takeWhile = (pred: (ch: string) => boolean): string => {
    const start = i;
    while (i < source.length && pred(source[i]!)) i++;
    return source.slice(start, i);
  };

  while (i < source.length) {
    const ch = source[i]!;

    if (WHITESPACE.has(ch)) {
      tokens.push({
        kind: "whitespace",
        text: takeWhile((c) => WHITESPACE.has(c)),
      });
      continue;
    }

    if (ch === "{") {
      tokens.push({ kind: "punctuation", text: "{" });
      i++;
      stack.push("object-key");
      continue;
    }

    if (ch === "[") {
      tokens.push({ kind: "punctuation", text: "[" });
      i++;
      stack.push("array");
      continue;
    }

    if (ch === "}" || ch === "]") {
      tokens.push({ kind: "punctuation", text: ch });
      i++;
      stack.pop();
      continue;
    }

    if (ch === ":") {
      tokens.push({ kind: "punctuation", text: ":" });
      i++;
      if (stack[stack.length - 1] === "object-key") {
        stack[stack.length - 1] = "object-value";
      }
      continue;
    }

    if (ch === ",") {
      tokens.push({ kind: "punctuation", text: "," });
      i++;
      if (stack[stack.length - 1] === "object-value") {
        stack[stack.length - 1] = "object-key";
      }
      continue;
    }

    if (ch === '"') {
      const text = readJsonString(source, i);
      i += text.length;
      const kind = stack[stack.length - 1] === "object-key" ? "key" : "string";
      tokens.push({ kind, text });
      continue;
    }

    if (source.startsWith("true", i)) {
      tokens.push({ kind: "boolean", text: "true" });
      i += 4;
      continue;
    }

    if (source.startsWith("false", i)) {
      tokens.push({ kind: "boolean", text: "false" });
      i += 5;
      continue;
    }

    if (source.startsWith("null", i)) {
      tokens.push({ kind: "null", text: "null" });
      i += 4;
      continue;
    }

    if (ch === "-" || isDigit(ch)) {
      const text = takeWhile(isJsonNumberChar);
      tokens.push({ kind: "number", text });
      continue;
    }

    // stringify should never land here. Emitting the character keeps the
    // concatenation equal to `source` so a bug in the walker cannot drop text
    // off the page.
    tokens.push({ kind: "punctuation", text: ch });
    i++;
  }

  return tokens;
}

/**
 * Read a JSON string literal starting at `start`, including both quotes.
 *
 * Escape handling follows stringify's output: `\` skips the next character,
 * except `\uXXXX` which skips the four hex digits after `u`.
 * @param source - The full document.
 * @param start - Index of the opening quote.
 * @returns The literal, from opening quote through closing quote.
 */
function readJsonString(source: string, start: number): string {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === "\\") {
      i++;
      if (source[i] === "u") {
        i += 5;
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      return source.slice(start, i + 1);
    }
    i++;
  }
  return source.slice(start);
}

/**
 * Whether `ch` can appear in a JSON number stringify emits.
 * @param ch - One character.
 * @returns Whether it belongs to a number token.
 */
function isJsonNumberChar(ch: string): boolean {
  return (
    isDigit(ch) ||
    ch === "-" ||
    ch === "+" ||
    ch === "." ||
    ch === "e" ||
    ch === "E"
  );
}

/**
 * Whether `ch` is an ASCII digit.
 * @param ch - One character.
 * @returns Whether it is `0`–`9`.
 */
function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}
