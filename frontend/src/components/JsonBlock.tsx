import { highlightJson } from "../utils/jsonHighlight";

/**
 * Pretty-printed JSON with syntax highlighting. The only file that renders a
 * JSON value as highlighted source, so the indent, the token kinds, and the
 * classes are decided once. Colors come from `.json-*` rules painted with
 * semantic tokens; concatenating the spans rebuilds
 * `JSON.stringify(value, null, 2)`.
 * @param props.value - The JSON-encodable value to show.
 * @param props.testId - A `data-testid` for the `<pre>`.
 * @returns The highlighted source.
 */
export default function JsonBlock({
  value,
  testId,
}: {
  value: unknown;
  testId?: string;
}) {
  const tokens = highlightJson(value);
  return (
    <pre className="json-block" data-testid={testId}>
      {tokens.map((token, index) =>
        token.kind === "whitespace" ? (
          token.text
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: tokens never reorder.
          <span key={index} className={`json-${token.kind}`}>
            {token.text}
          </span>
        ),
      )}
    </pre>
  );
}
