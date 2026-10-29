import { Link } from "react-router-dom";
import { Form } from "../../ui";
import type { ProjectTag } from "./data";

/** See {@link TagPicker}. */
export interface TagPickerProps {
  /** The legend, e.g. "Who may read it". */
  legend: string;
  /** The project's tags, `admin` left out, or `null` while loading. */
  tags: ProjectTag[] | null;
  /** The tag names checked. */
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
  /** Why it is disabled, as each check's `title`. */
  title?: string;
  /** Keys the test ids: `<testId>-<tag>` per check. */
  testId: string;
}

/**
 * An access list as a group of checks, one per project tag. Nothing checked
 * means every member, and the line under the checks says so in words, so an
 * empty list never reads as "nobody".
 * @param props - See {@link TagPickerProps}.
 * @returns The fieldset.
 */
export function TagPicker({
  legend,
  tags,
  value,
  onChange,
  disabled,
  title,
  testId,
}: TagPickerProps) {
  return (
    <fieldset className="settings-fieldset" data-testid={testId}>
      <legend className="form-label">{legend}</legend>
      {tags === null ? (
        <p className="text-meta mb-0">Loading tags…</p>
      ) : tags.length === 0 ? (
        <p className="text-meta mb-0">
          This project has no tags yet, so every member passes.{" "}
          <Link to="/settings/tags">Add tags in Settings → Tags.</Link>
        </p>
      ) : (
        <div className="d-flex flex-wrap gap-3">
          {tags.map((tag) => (
            <Form.Check
              key={tag.id}
              type="checkbox"
              label={tag.name}
              checked={value.includes(tag.name)}
              disabled={disabled}
              title={title}
              onChange={(e) =>
                onChange(
                  e.target.checked
                    ? [...value, tag.name]
                    : value.filter((name) => name !== tag.name),
                )
              }
              data-testid={`${testId}-${tag.name}`}
            />
          ))}
        </div>
      )}
      <Form.Text className="text-meta" data-testid={`${testId}-summary`}>
        {value.length === 0
          ? "Nothing checked: every member of the project. Admins always pass."
          : `Members holding ${value.join(" or ")}, and every admin.`}
      </Form.Text>
    </fieldset>
  );
}
