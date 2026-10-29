/**
 * A JSON value set as indented monospace on the sunken surface — an audit
 * row's before, after, and metadata. `null` reads as "Nothing", because an
 * empty snapshot is a fact worth saying in words.
 * @param props.value - Any JSON-serializable value.
 * @param props.label - What the value is, read as the block's caption.
 * @param props.testId - The block's `data-testid`.
 * @returns The block.
 */
export function JsonBlock({
  value,
  label,
  testId,
}: {
  value: unknown;
  label: string;
  testId?: string;
}) {
  return (
    <figure className="json-block" data-testid={testId}>
      <figcaption className="json-block-label">{label}</figcaption>
      {value === null || value === undefined ? (
        <p className="json-block-empty">Nothing</p>
      ) : (
        <pre className="json-block-body">{JSON.stringify(value, null, 2)}</pre>
      )}
    </figure>
  );
}
