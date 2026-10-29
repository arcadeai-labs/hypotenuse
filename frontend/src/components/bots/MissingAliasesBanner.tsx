import { Link } from "react-router-dom";
import { Alert } from "../../ui";
import { missingAliasesSentence } from "../../utils/bots";

/**
 * Said while the project lacks `default` or `fast`: no bot can run until both
 * exist. An admin is linked to where they are set; anyone else is told whom
 * to ask, because a link to a page of disabled controls helps nobody.
 * @param props - `missing` from `model-alias:list`, and whether the reader may set them.
 * @returns The banner, or nothing when no name is missing.
 */
export function MissingAliasesBanner({
  missing,
  canSet,
}: {
  missing: readonly string[];
  canSet: boolean;
}) {
  const sentence = missingAliasesSentence(missing);
  if (!sentence) return null;
  return (
    <Alert variant="warning" data-testid="missing-aliases">
      {sentence}{" "}
      {canSet ? (
        <Link to="/settings/models" data-testid="missing-aliases-link">
          Set them in Settings → Models.
        </Link>
      ) : (
        "Ask a project admin to set them in Settings → Models."
      )}
    </Alert>
  );
}
