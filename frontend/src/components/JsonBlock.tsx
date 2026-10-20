import { highlightJson } from "../utils/jsonHighlight";

/**
 * Pretty-printed JSON with syntax highlighting, scoped to `.tx-json`.
 *
 * The only file that renders a JSON value as highlighted source, so the indent,
 * the token kinds, and the theme classes are decided once. A run's inputs and
 * usage both go through here; a second copy would drift the way two markdown
 * renderers would.
 *
 * Colors come from `.tx-json-*` in `theme.scss`, never from JSX. Concatenating
 * the spans rebuilds `JSON.stringify(value, null, 2)`.
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
    <pre className="tx-json mb-0" data-testid={testId}>
      {tokens.map((token, index) =>
        token.kind === "whitespace" ? (
          token.text
        ) : (
          <span key={index} className={`tx-json-${token.kind}`}>
            {token.text}
          </span>
        ),
      )}
    </pre>
  );
}
