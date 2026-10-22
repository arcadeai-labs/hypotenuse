import { useCallback } from "react";
import { useAuth } from "../context/AuthContext";
import { can } from "../utils/permissions";
import { useProjectStanding } from "./useProjectStanding";

/**
 * `can()` bound to the active project's standing, for pages outside the
 * settings shell. False for everything until `project:view` has answered, so
 * a gated control is hidden rather than offered and refused.
 * @returns `may(actionName)` and whether standing is known yet.
 */
export function useMay(): {
  may: (actionName: string) => boolean;
  ready: boolean;
} {
  const { permissions } = useAuth();
  const standing = useProjectStanding();
  const may = useCallback(
    (actionName: string) =>
      standing !== null && can(permissions, actionName, standing),
    [permissions, standing],
  );
  return { may, ready: standing !== null && permissions !== null };
}
