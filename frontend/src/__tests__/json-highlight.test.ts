import { describe, expect, test } from "bun:test";
import { highlightJson } from "../utils/jsonHighlight";

/**
 * Drop whitespace so a case can assert kinds without restating indent.
 * @param value - A JSON-encodable value.
 * @returns `[kind, text]` pairs for every non-whitespace token.
 */
function labelled(value: unknown) {
  return highlightJson(value)
    .filter((token) => token.kind !== "whitespace")
    .map((token) => [token.kind, token.text] as const);
}

/**
 * Concatenate every token back into a document.
 * @param value - A JSON-encodable value.
 * @returns The highlighted source as a string.
 */
function printed(value: unknown): string {
  return highlightJson(value)
    .map((token) => token.text)
    .join("");
}

describe("highlightJson", () => {
  test("the tokens concatenate to stringify's pretty-print", () => {
    // The load-bearing equality: what is on screen is still valid JSON, byte
    // for byte with `JSON.stringify(value, null, 2)`, so a copy of the run's
    // inputs is the same object that was stored.
    const values: unknown[] = [
      { style: "epic", topic: "soda" },
      {
        speed: "fast",
        input_tokens: 1234,
        cache_creation: { ephemeral_5m_input_tokens: 0 },
        nested: [{ ok: true, missing: null }],
      },
      [],
      {},
      "hello",
      42,
      true,
      false,
      null,
      ["a", 1, { k: "v" }],
      { quote: 'say "hi"', path: "C:\\tmp" },
      { big: 1e21 },
    ];
    for (const value of values) {
      expect(printed(value)).toBe(JSON.stringify(value, null, 2));
    }
  });

  test("object keys are keys and string values are strings", () => {
    expect(labelled({ style: "epic", topic: "soda" })).toEqual([
      ["punctuation", "{"],
      ["key", '"style"'],
      ["punctuation", ":"],
      ["string", '"epic"'],
      ["punctuation", ","],
      ["key", '"topic"'],
      ["punctuation", ":"],
      ["string", '"soda"'],
      ["punctuation", "}"],
    ]);
  });

  test("nested objects keep classifying keys after a child closes", () => {
    // After the inner `}` the walker has to return to the outer object's
    // value state so the next property is a key, not a string.
    expect(labelled({ outer: { inner: 1 }, next: false })).toEqual([
      ["punctuation", "{"],
      ["key", '"outer"'],
      ["punctuation", ":"],
      ["punctuation", "{"],
      ["key", '"inner"'],
      ["punctuation", ":"],
      ["number", "1"],
      ["punctuation", "}"],
      ["punctuation", ","],
      ["key", '"next"'],
      ["punctuation", ":"],
      ["boolean", "false"],
      ["punctuation", "}"],
    ]);
  });

  test("array strings are values, even when they look like keys", () => {
    expect(labelled(["style", { style: "epic" }])).toEqual([
      ["punctuation", "["],
      ["string", '"style"'],
      ["punctuation", ","],
      ["punctuation", "{"],
      ["key", '"style"'],
      ["punctuation", ":"],
      ["string", '"epic"'],
      ["punctuation", "}"],
      ["punctuation", "]"],
    ]);
  });

  test("numbers, booleans, and null keep their own kinds", () => {
    expect(labelled({ n: -1.5, ok: true, missing: null })).toEqual([
      ["punctuation", "{"],
      ["key", '"n"'],
      ["punctuation", ":"],
      ["number", "-1.5"],
      ["punctuation", ","],
      ["key", '"ok"'],
      ["punctuation", ":"],
      ["boolean", "true"],
      ["punctuation", ","],
      ["key", '"missing"'],
      ["punctuation", ":"],
      ["null", "null"],
      ["punctuation", "}"],
    ]);
  });

  test("escaped quotes inside a string do not end the token", () => {
    const tokens = labelled({ quote: 'say "hi"' });
    expect(tokens).toContainEqual(["string", '"say \\"hi\\""']);
    expect(printed({ quote: 'say "hi"' })).toContain('"say \\"hi\\""');
  });

  test("empty objects and arrays stay on one line", () => {
    expect(printed({})).toBe("{}");
    expect(printed([])).toBe("[]");
  });

  test("top-level undefined yields no tokens", () => {
    // `JSON.stringify(undefined)` is `undefined`, not a document. The
    // component is not called for a missing usage row; this is the empty
    // answer rather than printing the word `undefined`.
    expect(highlightJson(undefined)).toEqual([]);
  });

  test("a value stringify cannot print does not throw through the page", () => {
    // BigInt is the cheap case: stringify throws immediately, and the page
    // still has something to show rather than an uncaught exception. A
    // circular object is the same catch; it is not used here because walking
    // one is not the property under test.
    expect(printed(1n)).toBe('"1"');
    expect(labelled(1n)).toEqual([["string", '"1"']]);
  });
});
