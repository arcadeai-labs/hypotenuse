import type { DiffLine } from "./memory/model";

/** The mark drawn in each line's gutter, by kind. */
const MARKS: Record<DiffLine["kind"], string> = {
  add: "+",
  remove: "−",
  same: " ",
};

/** What a screen reader hears before each changed line. */
const SPOKEN: Record<DiffLine["kind"], string> = {
  add: "added: ",
  remove: "removed: ",
  same: "",
};

/**
 * A line diff, drawn: kept lines quiet, added and removed lines tinted with
 * the diff tokens and marked in the gutter (the mark is hidden from screen
 * readers, which hear "added" or "removed" instead). Used wherever versions
 * of a text are compared — a memory document, a prompt section, a skill.
 * @param props.diff - The lines, from `lineDiff`.
 * @param props.testId - The block's `data-testid`.
 * @returns The block.
 */
export function DiffBlock({
  diff,
  testId,
}: {
  diff: readonly DiffLine[];
  testId?: string;
}) {
  return (
    <pre className="memory-diff" data-testid={testId}>
      {diff.map((line, i) => (
        <span
          // Lines repeat; their position is their identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff line has no id
          key={i}
          className={`memory-diff-line is-${line.kind}`}
        >
          <span className="memory-diff-mark" aria-hidden="true">
            {MARKS[line.kind]}
          </span>
          <span className="visually-hidden">{SPOKEN[line.kind]}</span>
          {line.text || " "}
          {"\n"}
        </span>
      ))}
    </pre>
  );
}
